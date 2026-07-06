import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  buildMinimalEnv,
  prewarmCliSpawnPath,
  createJsonlParser,
  runCliCompletion,
  probeCliAvailability,
  CLI_LIMITS,
  __setShellExecForTests,
  __setCliProbeForTests,
  __resetCliSpawnPathForTests,
  type CliProcess,
  type CliLineMapper,
  type ShellExecFn,
} from '../main/ai/cli-runner';
import type { AiChatEvent } from '../main/ai/types';

// A controllable fake child process implementing the CliProcess seam.
class FakeChild implements CliProcess {
  stdinChunks: string[] = [];
  stdinEnded = false;
  killed = false;
  killSignal?: string;
  private out: Array<(c: string) => void> = [];
  private err: Array<(c: string) => void> = [];
  private closeCbs: Array<(c: number | null) => void> = [];
  private errCbs: Array<(e: Error) => void> = [];
  stdin = { write: (c: string) => this.stdinChunks.push(c), end: () => { this.stdinEnded = true; } };
  stdout = { on: (_e: 'data', cb: (c: string) => void) => { this.out.push(cb); } };
  stderr = { on: (_e: 'data', cb: (c: string) => void) => { this.err.push(cb); } };
  on(ev: 'error' | 'close', cb: (...a: never[]) => void): void {
    if (ev === 'close') this.closeCbs.push(cb as (c: number | null) => void);
    if (ev === 'error') this.errCbs.push(cb as (e: Error) => void);
  }
  kill(sig?: string) { this.killed = true; this.killSignal = sig; }
  emitOut(s: string) { this.out.forEach((cb) => cb(s)); }
  emitErr(s: string) { this.err.forEach((cb) => cb(s)); }
  doClose(code: number | null) { this.closeCbs.forEach((cb) => cb(code)); }
  doError(e: Error) { this.errCbs.forEach((cb) => cb(e)); }
}

// Claude-stream-json-like mapper for tests.
const mapLine: CliLineMapper = (rec) => {
  const r = rec as { type?: string; delta?: { text?: string }; error?: { message?: string } };
  if (r.type === 'error') return { error: r.error?.message ?? 'err' };
  if (r.type === 'message_stop') return { done: true };
  if (r.type === 'content_block_delta') return { delta: r.delta?.text ?? '' };
  return null;
};

function harness(over: Partial<Parameters<typeof runCliCompletion>[0]> = {}) {
  let child: FakeChild | undefined;
  let capturedArgs: string[] = [];
  let capturedEnv: Record<string, string> = {};
  const events: AiChatEvent[] = [];
  const spawn = (_cmd: string, args: string[], opts: { env: Record<string, string>; cwd: string }) => {
    capturedArgs = args;
    capturedEnv = opts.env;
    child = new FakeChild();
    return child;
  };
  const promise = runCliCompletion({
    spawn,
    command: 'claude',
    args: ['-p', '--output-format', 'stream-json'],
    prompt: 'SECRET-PROMPT-TEXT',
    mapLine,
    env: { PATH: '/usr/bin' },
    cwd: '/tmp',
    onEvent: (e) => events.push(e),
    ...over,
  });
  return { promise, getChild: () => child!, events, getArgs: () => capturedArgs, getEnv: () => capturedEnv };
}

const REAL_PLATFORM = process.platform;
const REAL_PATH = process.env.PATH;
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true, writable: true });
}

// Hermetic shell-exec seam: records every call and replies per shell mode (-lc/-ilc).
type ExecCall = { shell: string; args: string[]; env: Record<string, string>; timeoutMs: number };
function fakeShellExec(reply: (mode: '-lc' | '-ilc') => string | Error): { fn: ShellExecFn; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const fn: ShellExecFn = async (shell, args, opts) => {
    calls.push({ shell, args, env: opts.env, timeoutMs: opts.timeoutMs });
    const r = reply(args.includes('-ilc') ? '-ilc' : '-lc');
    if (r instanceof Error) throw r;
    return r;
  };
  return { fn, calls };
}

afterEach(() => {
  vi.useRealTimers();
  __resetCliSpawnPathForTests();
  Object.defineProperty(process, 'platform', { value: REAL_PLATFORM, configurable: true, writable: true });
  if (REAL_PATH === undefined) delete process.env.PATH;
  else process.env.PATH = REAL_PATH;
});

describe('buildMinimalEnv (G003 secret containment)', () => {
  beforeEach(() => {
    // Hermetic: stub the resolver shell + CLI probe so tests never exec the real login shell.
    setPlatform('darwin');
    __setShellExecForTests(async () => 'GJC_PATH=/opt/homebrew/bin\n');
    __setCliProbeForTests(() => true);
  });
  it('forwards PATH/HOME but never leaks provider API keys or arbitrary secrets', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-leak';
    process.env.OPENAI_API_KEY = 'sk-leak2';
    process.env.SECRET_XYZ = 'nope';
    process.env.PATH = process.env.PATH || '/usr/bin';
    const env = await buildMinimalEnv();
    expect(env.PATH).toBeTruthy();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.SECRET_XYZ).toBeUndefined();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.SECRET_XYZ;
  });
  it('honors an explicit allowlist extension only', async () => {
    process.env.GROK_TOKEN_DIR = '/x';
    expect((await buildMinimalEnv(['GROK_TOKEN_DIR'])).GROK_TOKEN_DIR).toBe('/x');
    expect((await buildMinimalEnv()).GROK_TOKEN_DIR).toBeUndefined();
    delete process.env.GROK_TOKEN_DIR;
  });
});

describe('async login-shell PATH resolver (darwin-only, secret-safe, two-stage)', () => {
  const ALLOWED_ENV_KEYS = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TMPDIR', 'PATH'];
  beforeEach(() => setPlatform('darwin'));

  it('(a) a first buildMinimalEnv racing prewarm shares the in-flight resolver and uses the resolved PATH', async () => {
    const { fn, calls } = fakeShellExec(() => 'GJC_PATH=/resolved/bin\n');
    __setShellExecForTests(fn);
    __setCliProbeForTests(() => true); // -lc PATH is usable → single stage
    process.env.PATH = '/usr/bin';
    const warm = prewarmCliSpawnPath(); // fire, do not await
    const env = await buildMinimalEnv(); // races the pending resolution
    await warm;
    expect(env.PATH.split(':')).toContain('/resolved/bin');
    expect(calls.length).toBe(1); // one shared resolution, not one per caller
  });

  it('(b) a pending resolution is shared and never observed as a cached null', async () => {
    let release: () => void = () => {};
    const calls: string[][] = [];
    const fn: ShellExecFn = (_shell, args) => {
      calls.push(args);
      return new Promise<string>((res) => {
        release = () => res('GJC_PATH=/late/bin\n');
      });
    };
    __setShellExecForTests(fn);
    __setCliProbeForTests(() => true);
    process.env.PATH = '/usr/bin';
    const warm = prewarmCliSpawnPath(); // exec is pending
    const envP = buildMinimalEnv(); // races WHILE pending — must await the shared in-flight
    release();
    const env = await envP;
    await warm;
    expect(env.PATH.split(':')).toContain('/late/bin'); // resolved value, not a null fallback
    expect(calls.length).toBe(1); // single shared in-flight resolution
  });

  it('(c) parses the GJC_PATH sentinel despite rc-file chatter on stdout', async () => {
    const noisy = 'Welcome to zsh\nplugin: loaded\n  GJC_PATH=/opt/homebrew/bin:/usr/bin  \ntrailing noise\n';
    const { fn } = fakeShellExec(() => noisy);
    __setShellExecForTests(fn);
    __setCliProbeForTests(() => true);
    process.env.PATH = '/usr/bin';
    const env = await buildMinimalEnv();
    expect(env.PATH.split(':')).toContain('/opt/homebrew/bin');
  });

  it('(d) a timeout/terminal shell failure falls back to process.env.PATH + common dirs without poisoning the cache', async () => {
    const { fn, calls } = fakeShellExec(() => new Error('shell timed out'));
    __setShellExecForTests(fn);
    __setCliProbeForTests(() => false);
    process.env.PATH = '/custom/bin';
    const env1 = await buildMinimalEnv();
    expect(env1.PATH.split(':')).toContain('/custom/bin'); // process.env.PATH preserved
    expect(env1.PATH.split(':')).toContain('/usr/bin'); // common dirs present
    const afterFirst = calls.length; // both stages attempted (-lc then -ilc)
    await buildMinimalEnv(); // must retry — a failed resolution is never cached as null
    expect(calls.length).toBeGreaterThan(afterFirst);
  });

  it('(e) an unresolved -lc PATH triggers exactly one interactive -ilc retry and uses its PATH', async () => {
    const { fn, calls } = fakeShellExec((mode) =>
      mode === '-lc' ? 'GJC_PATH=/lc/only/bin\n' : 'GJC_PATH=/ilc/nvm/bin\n',
    );
    __setShellExecForTests(fn);
    __setCliProbeForTests((p) => p.split(':').includes('/ilc/nvm/bin')); // CLI only on the -ilc PATH
    process.env.PATH = '/usr/bin';
    const env = await buildMinimalEnv();
    expect(calls.map((c) => c.args[0])).toEqual(['-lc', '-ilc']);
    expect(env.PATH.split(':')).toContain('/ilc/nvm/bin');
  });

  it('(f) the resolver shell is spawned with a MINIMAL env — never provider API keys', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-anthropic-leak';
    process.env.OPENAI_API_KEY = 'sk-openai-leak';
    process.env.PATH = '/usr/bin';
    const { fn, calls } = fakeShellExec(() => 'GJC_PATH=/opt/homebrew/bin\n');
    __setShellExecForTests(fn);
    __setCliProbeForTests(() => true);
    await buildMinimalEnv();
    expect(calls.length).toBeGreaterThan(0);
    const env = calls[0].env;
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    for (const key of Object.keys(env)) expect(ALLOWED_ENV_KEYS).toContain(key);
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  it('(g) on non-darwin the resolver returns null and never spawns a shell', async () => {
    setPlatform('linux');
    const { fn, calls } = fakeShellExec(() => 'GJC_PATH=/should/not/run\n');
    __setShellExecForTests(fn);
    __setCliProbeForTests(() => true);
    process.env.PATH = '/usr/bin';
    const env = await buildMinimalEnv();
    expect(calls.length).toBe(0); // no shell exec off darwin
    expect(env.PATH.split(':')).toContain('/usr/bin'); // falls back to process.env.PATH + common
    expect(env.PATH.split(':')).toContain('/bin');
    expect(env.PATH.split(':')).not.toContain('/should/not/run');
  });
});

describe('createJsonlParser (bursty/partial chunk tolerance)', () => {
  it('parses one record split across chunks', () => {
    const p = createJsonlParser();
    expect(p.push('{"a":').records).toEqual([]);
    expect(p.push('1}\n').records).toEqual([{ a: 1 }]);
  });
  it('parses multiple records in one burst chunk and skips blank lines', () => {
    const p = createJsonlParser();
    const { records } = p.push('{"a":1}\n\n{"b":2}\n');
    expect(records).toEqual([{ a: 1 }, { b: 2 }]);
  });
  it('flushes a trailing record without a final newline', () => {
    const p = createJsonlParser();
    expect(p.push('{"a":1}').records).toEqual([]);
    expect(p.flush().records).toEqual([{ a: 1 }]);
  });
  it('reports an unparseable line as an error', () => {
    const p = createJsonlParser();
    expect(p.push('not-json\n').error).toBeTruthy();
  });
  it('rejects an over-long unterminated line', () => {
    const p = createJsonlParser(16);
    expect(p.push('x'.repeat(64)).error).toBe('JSONL line exceeds cap');
  });
});

describe('runCliCompletion (stdin-only, streaming, lifecycle)', () => {
  it('delivers the prompt via stdin only — never in argv', async () => {
    const h = harness();
    const child = h.getChild();
    child.emitOut('{"type":"content_block_delta","delta":{"text":"hi"}}\n');
    child.doClose(0);
    await h.promise;
    expect(h.getArgs()).toEqual(['-p', '--output-format', 'stream-json']);
    expect(h.getArgs().join(' ')).not.toContain('SECRET-PROMPT-TEXT');
    expect(child.stdinChunks.join('')).toBe('SECRET-PROMPT-TEXT');
    expect(child.stdinEnded).toBe(true);
  });

  it('streams deltas then done on a clean exit', async () => {
    const h = harness();
    const child = h.getChild();
    child.emitOut('{"type":"content_block_delta","delta":{"text":"A"}}\n');
    child.emitOut('{"type":"content_block_delta","delta":{"text":"B"}}\n');
    child.emitOut('{"type":"message_stop"}\n');
    const res = await h.promise;
    expect(res.ok).toBe(true);
    expect(h.events.filter((e) => e.kind === 'delta').map((e) => (e as { text: string }).text)).toEqual(['A', 'B']);
    expect(h.events.at(-1)?.kind).toBe('done');
  });

  it('maps a CLI error record to an error event and kills the child', async () => {
    const h = harness();
    const child = h.getChild();
    child.emitOut('{"type":"error","error":{"message":"overloaded"}}\n');
    const res = await h.promise;
    expect(res.ok).toBe(false);
    expect(h.events.some((e) => e.kind === 'error' && (e as { message: string }).message === 'overloaded')).toBe(true);
    expect(child.killed).toBe(true);
  });

  it('enforces the output byte cap', async () => {
    const h = harness({ limits: { outputCap: 4 } });
    const child = h.getChild();
    child.emitOut('{"type":"content_block_delta","delta":{"text":"toolongdelta"}}\n');
    const res = await h.promise;
    expect(res.ok).toBe(false);
    expect(h.events.some((e) => e.kind === 'error')).toBe(true);
  });

  it('cancels via AbortSignal: kills the child and emits a cancelled error', async () => {
    const ac = new AbortController();
    const h = harness({ signal: ac.signal });
    ac.abort();
    const res = await h.promise;
    expect(res.ok).toBe(false);
    expect(h.getChild().killed).toBe(true);
    expect(h.events.some((e) => e.kind === 'error' && (e as { errorKind?: string }).errorKind === 'cancelled')).toBe(true);
  });

  it('surfaces a non-zero exit with captured stderr', async () => {
    const h = harness();
    const child = h.getChild();
    child.emitErr('login required: run `claude login`');
    child.doClose(1);
    const res = await h.promise;
    expect(res.ok).toBe(false);
    expect(h.events.some((e) => e.kind === 'error' && (e as { message: string }).message.includes('login required'))).toBe(true);
  });

  it('fails fast when the no-output watchdog fires', async () => {
    const h = harness({ limits: { noOutputMs: 10 } });
    const res = await h.promise;
    expect(res.ok).toBe(false);
    expect(h.getChild().killed).toBe(true);
  });

  it('ignored JSONL records (system/init/hook) do NOT disarm the no-output watchdog', async () => {
    const h = harness({ limits: { noOutputMs: 10 } });
    const child = h.getChild();
    // These map to null (no user-visible delta), so they must NOT set sawOutput.
    child.emitOut('{"type":"system","subtype":"init"}\n');
    child.emitOut('{"type":"hook","event":"pre"}\n');
    const res = await h.promise; // watchdog still fires despite the ignored records
    expect(res.ok).toBe(false);
    expect(res.sawOutput).toBe(false);
    expect(child.killed).toBe(true);
    expect(h.events.some((e) => e.kind === 'error' && (e as { errorKind?: string }).errorKind === 'network')).toBe(true);
  });

  it('classifies auth-looking stderr on a non-zero exit as errorKind:auth with login guidance', async () => {
    const h = harness();
    const child = h.getChild();
    child.emitErr('Error: unauthorized — please authenticate');
    child.doClose(1);
    const res = await h.promise;
    expect(res.ok).toBe(false);
    expect(
      h.events.some((e) => e.kind === 'error' && (e as { errorKind?: string }).errorKind === 'auth'),
    ).toBe(true);
    expect(
      h.events.some(
        (e) => e.kind === 'error' && (e as { message: string }).message.toLowerCase().includes('login'),
      ),
    ).toBe(true);
  });

  it('keeps errorKind:provider for a non-auth non-zero exit', async () => {
    const h = harness();
    const child = h.getChild();
    child.emitErr('Error: internal model failure (500)');
    child.doClose(1);
    const res = await h.promise;
    expect(
      h.events.some((e) => e.kind === 'error' && (e as { errorKind?: string }).errorKind === 'provider'),
    ).toBe(true);
  });
});

describe('probeCliAvailability', () => {
  function probeHarness(closeCode: number | null) {
    let child: FakeChild | undefined;
    const spawn = () => { child = new FakeChild(); return child; };
    const promise = probeCliAvailability({ spawn, command: 'grok', probeArgs: ['--version'], env: {}, cwd: '/tmp' });
    return { promise, getChild: () => child!, closeCode };
  }
  it('reports available when the probe exits 0', async () => {
    const h = probeHarness(0);
    h.getChild().doClose(0);
    expect(await h.promise).toEqual({ available: true });
  });
  it('reports unavailable on a non-zero exit', async () => {
    const h = probeHarness(127);
    h.getChild().doClose(127);
    expect((await h.promise).available).toBe(false);
  });
  it('reports unavailable on spawn error', async () => {
    const h = probeHarness(0);
    h.getChild().doError(new Error('ENOENT'));
    expect((await h.promise).available).toBe(false);
  });
});
