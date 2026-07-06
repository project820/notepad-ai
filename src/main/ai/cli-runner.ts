/**
 * cli-runner.ts — secure subprocess runner for local subscription CLI providers
 * (claude / grok). v0.7 completion mode only: prompt is delivered via STDIN, argv
 * carries only static routing flags, and a minimal allowlisted env is passed to
 * spawn (NEVER the parent process.env — that would leak other providers' API keys
 * to the external CLI). The child is parsed as NDJSON/JSONL: partial and bursty
 * chunks are buffered, only complete records are JSON.parse'd, and output is byte
 * capped. The spawn function is injectable so the whole runner is unit-testable
 * with no real subprocess. (G003)
 */

import type { AiChatEvent, AiProviderErrorKind } from './types';

/** Minimal child-process surface the runner needs (keeps the spawn seam mockable). */
export interface CliProcess {
  stdin: { write(chunk: string): void; end(): void } | null;
  stdout: { on(event: 'data', cb: (chunk: Buffer | string) => void): void } | null;
  stderr: { on(event: 'data', cb: (chunk: Buffer | string) => void): void } | null;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'close', cb: (code: number | null) => void): void;
  kill(signal?: NodeJS.Signals): void;
}

export type CliSpawn = (
  command: string,
  args: string[],
  opts: { env: Record<string, string>; cwd: string },
) => CliProcess;

/** Maps one parsed JSONL record to a stream effect. Provider-specific. */
export type CliLineMapper = (record: unknown) => { delta?: string; done?: boolean; error?: string } | null;

export type CliRunResult = { ok: boolean; sawOutput: boolean; error?: string };

export const CLI_LIMITS = {
  /** Max bytes of assembled model text before the stream is force-closed. */
  outputCap: 8 * 1024 * 1024,
  /** Max bytes of a single unparsed JSONL line before it is rejected. */
  maxLineBytes: 1 * 1024 * 1024,
  /** Max captured stderr bytes (diagnostics only, never streamed as model text). */
  stderrCap: 64 * 1024,
  /** Time to first byte before the run is aborted as unresponsive. */
  noOutputMs: 60_000,
} as const;

/**
 * A GUI-launched macOS app inherits a minimal PATH (e.g. /usr/bin:/bin) that does
 * NOT include where user CLIs live (Homebrew, npm-global, nvm, or cmux shims), so
 * `claude`/`grok` are not found and the providers look "Not connected". Resolve the
 * user's real PATH via their login shell and merge it with common bin dirs. The
 * resolution is ASYNC (never a sync main-thread `execFileSync`) and darwin-only.
 *
 * Secret containment (G003, adjudication 1.2): the resolver shell is spawned with a
 * MINIMAL allowlist env (HOME/USER/LOGNAME/SHELL/LANG/TMPDIR/PATH) — NEVER the full
 * process.env, which would leak ANTHROPIC_API_KEY/OPENAI_API_KEY/etc. into the login
 * shell and everything its rc files source.
 *
 * Two-stage resolution (adjudication 1.3): try a non-interactive `-lc` first (fast,
 * sources .zprofile/.zshenv); ONLY when `claude`/`grok` do not resolve on that PATH,
 * retry ONCE with an interactive `-ilc` (sources .zshrc, where nvm init conventionally
 * lives). Whichever yields a usable PATH wins.
 *
 * Caching: a single shared in-flight promise coalesces concurrent callers, and ONLY a
 * successfully resolved non-empty PATH string is cached. A pending, timed-out, or
 * failed resolution NEVER caches null (no negative-cache poisoning) — the next caller
 * re-resolves, so a transient shell failure self-heals. PATH is not a secret, so none
 * of this weakens the minimal-env guarantee.
 */
const PATH_PROBE_CMD = 'echo "GJC_PATH=$PATH"';
const PATH_SENTINEL = 'GJC_PATH=';
const RESOLVER_ENV_KEYS = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TMPDIR', 'PATH'] as const;
const COMMON_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/** Injectable async shell exec (default over node:child_process); overridable in tests. */
export type ShellExecFn = (
  shell: string,
  args: string[],
  opts: { env: Record<string, string>; timeoutMs: number },
) => Promise<string>;

const defaultShellExec: ShellExecFn = (shell, args, opts) =>
  new Promise<string>((resolve, reject) => {
    const { execFile } = require('node:child_process') as typeof import('node:child_process');
    execFile(shell, args, { encoding: 'utf-8', timeout: opts.timeoutMs, env: opts.env }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });

/** Does any dir on `pathStr` contain a `claude`/`grok` binary? (real filesystem in prod). */
function defaultCliProbe(pathStr: string): boolean {
  const { existsSync } = require('node:fs') as typeof import('node:fs');
  const nodePath = require('node:path') as typeof import('node:path');
  for (const dir of pathStr.split(':')) {
    if (!dir) continue;
    if (existsSync(nodePath.join(dir, 'claude')) || existsSync(nodePath.join(dir, 'grok'))) return true;
  }
  return false;
}

let _execImpl: ShellExecFn = defaultShellExec;
let _cliProbeImpl: (pathStr: string) => boolean = defaultCliProbe;

let cachedShellPath: string | undefined;
let inflight: Promise<string | null> | null = null;

/** Minimal allowlist env for the resolver shell — never the full (secret-bearing) env. */
function resolverEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of RESOLVER_ENV_KEYS) {
    const v = process.env[key];
    if (typeof v === 'string') env[key] = v;
  }
  return env;
}

/** Extract the `GJC_PATH=` sentinel value, tolerating rc-file chatter on stdout. */
function parseSentinelPath(out: string): string | null {
  const line = out
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith(PATH_SENTINEL));
  const p = line ? line.slice(PATH_SENTINEL.length).trim() : '';
  return p || null;
}

/** Run one shell mode with the minimal env + hard 5s timeout; null on any failure. */
async function runShellForPath(shell: string, flag: '-lc' | '-ilc'): Promise<string | null> {
  try {
    const out = await _execImpl(shell, [flag, PATH_PROBE_CMD], { env: resolverEnv(), timeoutMs: 5_000 });
    return parseSentinelPath(out);
  } catch {
    return null;
  }
}

/** Two-stage resolution; returns the chosen PATH or null when the shell can't be read. */
async function doResolveLoginShellPath(): Promise<string | null> {
  const shell = process.env.SHELL || '/bin/zsh';
  // Stage 1: non-interactive login shell (sources .zprofile/.zshenv).
  const lc = await runShellForPath(shell, '-lc');
  if (lc && _cliProbeImpl(lc)) return lc;
  // Stage 2 (only when the CLIs are unresolved): interactive shell (sources .zshrc/nvm).
  const ilc = await runShellForPath(shell, '-ilc');
  if (ilc && _cliProbeImpl(ilc)) return ilc;
  // Neither resolves a CLI: prefer the (superset) interactive PATH, else the -lc PATH.
  return ilc || lc || null;
}

/**
 * Resolve the login-shell PATH once (darwin-only), coalescing concurrent callers on a
 * shared in-flight promise. Caches only a non-empty success; never caches null.
 */
async function resolveLoginShellPath(): Promise<string | null> {
  if (typeof cachedShellPath === 'string') return cachedShellPath;
  if (process.platform !== 'darwin') return null;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const resolved = await doResolveLoginShellPath();
      if (resolved) cachedShellPath = resolved; // cache ONLY a non-empty success
      return resolved;
    } finally {
      inflight = null; // pending/failed resolutions leave the cache untouched (no null poison)
    }
  })();
  return inflight;
}

/** Warm the login-shell PATH resolver in the background (fire-and-forget at startup). */
export async function prewarmCliSpawnPath(): Promise<void> {
  await resolveLoginShellPath();
}

/** Merge login-shell PATH + current PATH + common bin dirs, de-duplicated (order-preserving). */
async function enrichedSpawnPath(): Promise<string> {
  const resolved = await resolveLoginShellPath();
  const parts = [
    ...(resolved?.split(':') ?? []),
    ...(process.env.PATH ?? '').split(':'),
    ...COMMON_BIN_DIRS,
  ].filter(Boolean);
  return [...new Set(parts)].join(':');
}

/**
 * Build a minimal allowlisted environment for spawn. Only the named keys are
 * forwarded from the parent; everything else (including ANTHROPIC_API_KEY,
 * OPENAI_API_KEY, OPENROUTER_API_KEY, and any other secret) is dropped. PATH is
 * awaited from the async resolver — a first call racing prewarm awaits the shared
 * in-flight promise rather than falling back to a stripped PATH.
 */
export async function buildMinimalEnv(extraAllow: string[] = []): Promise<Record<string, string>> {
  const base = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TMPDIR'];
  const allow = new Set([...base, ...extraAllow]);
  const out: Record<string, string> = {};
  for (const key of allow) {
    const v = process.env[key];
    if (typeof v === 'string') out[key] = v;
  }
  // Always hand the child a PATH that can actually locate user CLIs (login-shell
  // PATH + common bin dirs), not the stripped GUI-app PATH.
  out.PATH = await enrichedSpawnPath();
  return out;
}

// --- test seams (not part of the production API; used only by unit tests) ---
/** Override the shell-exec used by the PATH resolver (hermetic tests). */
export function __setShellExecForTests(fn: ShellExecFn): void {
  _execImpl = fn;
}
/** Override the CLI-existence probe used by the two-stage resolver (hermetic tests). */
export function __setCliProbeForTests(fn: (pathStr: string) => boolean): void {
  _cliProbeImpl = fn;
}
/** Reset resolver cache, in-flight promise, and seams to defaults between tests. */
export function __resetCliSpawnPathForTests(): void {
  cachedShellPath = undefined;
  inflight = null;
  _execImpl = defaultShellExec;
  _cliProbeImpl = defaultCliProbe;
}

/**
 * Incremental NDJSON/JSONL parser. Buffers partial lines across chunks, tolerates
 * multiple records in one burst chunk and a single record split across chunks,
 * skips blank keep-alive lines, and rejects an over-long unterminated line.
 */
export function createJsonlParser(maxLineBytes: number = CLI_LIMITS.maxLineBytes) {
  let buffer = '';
  const drainLine = (line: string, out: unknown[]): string | null => {
    const trimmed = line.trim();
    if (trimmed === '') return null;
    try {
      out.push(JSON.parse(trimmed));
      return null;
    } catch {
      return `unparseable JSONL record`;
    }
  };
  return {
    /** Returns parsed records; throws-free, returns an error string on a bad/oversized line. */
    push(chunk: string): { records: unknown[]; error?: string } {
      buffer += chunk;
      const records: unknown[] = [];
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const err = drainLine(line, records);
        if (err) return { records, error: err };
      }
      if (buffer.length > maxLineBytes) return { records, error: 'JSONL line exceeds cap' };
      return { records };
    },
    /** Flush any trailing record after the stream closes (no final newline). */
    flush(): { records: unknown[]; error?: string } {
      if (buffer === '') return { records: [] };
      const records: unknown[] = [];
      const err = drainLine(buffer, records);
      buffer = '';
      return err ? { records, error: err } : { records };
    },
  };
}

function asString(chunk: Buffer | string): string {
  return typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
}

/**
 * Run a CLI completion: spawn with static args + minimal env, write the prompt to
 * stdin, stream JSONL output through `mapLine` as AiChatEvents, and resolve when
 * the process closes. Cancellation (via signal) kills the child and emits a
 * cancelled event. Never throws; failures are emitted as error events + returned.
 */
export function runCliCompletion(opts: {
  spawn: CliSpawn;
  command: string;
  /** STATIC routing flags only — never user/prompt content. */
  args: string[];
  /** Full prompt, delivered exclusively via stdin. */
  prompt: string;
  mapLine: CliLineMapper;
  env: Record<string, string>;
  cwd: string;
  signal?: AbortSignal;
  onEvent: (e: AiChatEvent) => void;
  limits?: Partial<typeof CLI_LIMITS>;
}): Promise<CliRunResult> {
  const limits = { ...CLI_LIMITS, ...(opts.limits ?? {}) };
  return new Promise<CliRunResult>((resolve) => {
    let settled = false;
    let sawOutput = false;
    let outputBytes = 0;
    let stderrBytes = 0;
    let stderrText = '';
    let child: CliProcess;
    const parser = createJsonlParser(limits.maxLineBytes);

    const finish = (result: CliRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const fail = (error: string, kind: AiProviderErrorKind = 'provider') => {
      try {
        child?.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      opts.onEvent({ kind: 'error', message: error, errorKind: kind });
      finish({ ok: false, sawOutput, error });
    };
    const onAbort = () => {
      try {
        child?.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      opts.onEvent({ kind: 'error', message: 'cancelled', errorKind: 'cancelled' });
      finish({ ok: false, sawOutput, error: 'cancelled' });
    };

    const watchdog = setTimeout(() => {
      if (!sawOutput) fail('CLI produced no output in time', 'network');
    }, limits.noOutputMs);

    try {
      child = opts.spawn(opts.command, opts.args, { env: opts.env, cwd: opts.cwd });
    } catch (e) {
      fail(`failed to launch ${opts.command}: ${(e as Error)?.message ?? e}`, 'provider');
      return;
    }

    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    const handleRecords = (records: unknown[]): boolean => {
      for (const rec of records) {
        const mapped = opts.mapLine(rec);
        if (!mapped) continue;
        if (mapped.error) {
          fail(mapped.error);
          return false;
        }
        if (mapped.delta) {
          outputBytes += Buffer.byteLength(mapped.delta, 'utf-8');
          if (outputBytes > limits.outputCap) {
            fail('CLI output exceeded cap');
            return false;
          }
          sawOutput = true;
          opts.onEvent({ kind: 'delta', text: mapped.delta });
        }
        if (mapped.done) {
          opts.onEvent({ kind: 'done', text: '' });
          finish({ ok: true, sawOutput });
          return false;
        }
      }
      return true;
    };

    child.stdout?.on('data', (chunk) => {
      if (settled) return;
      const { records, error } = parser.push(asString(chunk));
      if (!handleRecords(records)) return;
      if (error) fail(error);
    });

    child.stderr?.on('data', (chunk) => {
      if (stderrBytes >= limits.stderrCap) return;
      const s = asString(chunk);
      stderrBytes += Buffer.byteLength(s, 'utf-8');
      stderrText += s;
    });

    child.on('error', (err) => fail(`CLI process error: ${err?.message ?? err}`, 'provider'));

    child.on('close', (code) => {
      if (settled) return;
      const tail = parser.flush();
      if (!handleRecords(tail.records)) return;
      if (tail.error) {
        fail(tail.error);
        return;
      }
      if (code === 0) {
        opts.onEvent({ kind: 'done', text: '' });
        finish({ ok: true, sawOutput });
      } else {
        const detail = stderrText.trim().slice(0, 500);
        // Adjudication 1.4: a non-zero exit whose stderr looks like an auth/login
        // failure is classified errorKind:'auth' with actionable login guidance (the
        // CLI is installed but not logged in); anything else stays 'provider'.
        if (/log ?in|auth|unauthori|credential|not logged in/i.test(stderrText)) {
          const guidance = 'Run `claude login` (or `grok`) then reopen the app.';
          fail(detail ? `${detail}\n${guidance}` : guidance, 'auth');
        } else {
          fail(detail || `CLI exited with code ${code}`, 'provider');
        }
      }
    });

    // Prompt is delivered ONLY via stdin; argv never carries user content.
    try {
      child.stdin?.write(opts.prompt);
      child.stdin?.end();
    } catch (e) {
      fail(`failed to write prompt to ${opts.command} stdin: ${(e as Error)?.message ?? e}`, 'provider');
    }
  });
}

/**
 * Probe whether a CLI is installed + invocable using STATIC args + minimal env
 * (never any prompt content). Resolves available=true when the probe exits 0.
 */
export function probeCliAvailability(opts: {
  spawn: CliSpawn;
  command: string;
  probeArgs: string[];
  env: Record<string, string>;
  cwd: string;
  timeoutMs?: number;
}): Promise<{ available: boolean; reason?: string }> {
  return new Promise((resolve) => {
    let done = false;
    const settle = (r: { available: boolean; reason?: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child: CliProcess;
    const timer = setTimeout(() => {
      try {
        child?.kill('SIGTERM');
      } catch {
        /* gone */
      }
      settle({ available: false, reason: 'probe timed out' });
    }, opts.timeoutMs ?? 5_000);
    try {
      child = opts.spawn(opts.command, opts.probeArgs, { env: opts.env, cwd: opts.cwd });
    } catch (e) {
      settle({ available: false, reason: (e as Error)?.message ?? 'spawn failed' });
      return;
    }
    child.on('error', (err) => settle({ available: false, reason: err?.message ?? 'spawn error' }));
    child.on('close', (code) =>
      settle(code === 0 ? { available: true } : { available: false, reason: `exit ${code}` }),
    );
  });
}

/**
 * Default production spawn adapter over node:child_process. shell:false (no shell
 * interpolation), windowsHide, piped stdio. Lazy-required so this module stays
 * importable in non-Electron test contexts without spawning anything.
 */
export function nodeCliSpawn(): CliSpawn {
  const { spawn } = require('node:child_process') as typeof import('node:child_process');
  return (command, args, opts) =>
    spawn(command, args, {
      env: opts.env,
      cwd: opts.cwd,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as unknown as CliProcess;
}
