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
 * Build a minimal allowlisted environment for spawn. Only the named keys are
 * forwarded from the parent; everything else (including ANTHROPIC_API_KEY,
 * OPENAI_API_KEY, OPENROUTER_API_KEY, and any other secret) is dropped.
 */
export function buildMinimalEnv(extraAllow: string[] = []): Record<string, string> {
  const base = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TMPDIR'];
  const allow = new Set([...base, ...extraAllow]);
  const out: Record<string, string> = {};
  for (const key of allow) {
    const v = process.env[key];
    if (typeof v === 'string') out[key] = v;
  }
  return out;
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
      if (records.length > 0) sawOutput = sawOutput || records.length > 0;
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
        fail(detail || `CLI exited with code ${code}`, 'provider');
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
