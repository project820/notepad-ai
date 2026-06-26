import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  buildMinimalEnv,
  createJsonlParser,
  runCliCompletion,
  probeCliAvailability,
  CLI_LIMITS,
  type CliProcess,
  type CliLineMapper,
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

afterEach(() => vi.useRealTimers());

describe('buildMinimalEnv (G003 secret containment)', () => {
  it('forwards PATH/HOME but never leaks provider API keys or arbitrary secrets', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-leak';
    process.env.OPENAI_API_KEY = 'sk-leak2';
    process.env.SECRET_XYZ = 'nope';
    process.env.PATH = process.env.PATH || '/usr/bin';
    const env = buildMinimalEnv();
    expect(env.PATH).toBeTruthy();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.SECRET_XYZ).toBeUndefined();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.SECRET_XYZ;
  });
  it('honors an explicit allowlist extension only', () => {
    process.env.GROK_TOKEN_DIR = '/x';
    expect(buildMinimalEnv(['GROK_TOKEN_DIR']).GROK_TOKEN_DIR).toBe('/x');
    expect(buildMinimalEnv().GROK_TOKEN_DIR).toBeUndefined();
    delete process.env.GROK_TOKEN_DIR;
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
