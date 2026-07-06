import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { ClaudeCliProvider, mapClaudeStreamJson } from '../main/ai/claude-cli-provider';
import { FallbackProvider, type StreamSource } from '../main/ai/fallback-provider';
import { buildCliPrompt } from '../main/ai/cli-prompt';
import { __setShellExecForTests, __setCliProbeForTests, __resetCliSpawnPathForTests, type CliProcess } from '../main/ai/cli-runner';
import type { AiChatEvent, AiChatRequest } from '../main/ai/types';

class FakeChild implements CliProcess {
  stdinChunks: string[] = [];
  killed = false;
  private out: Array<(c: string) => void> = [];
  private errCb: Array<(c: string) => void> = [];
  private closeCbs: Array<(c: number | null) => void> = [];
  private errorCbs: Array<(e: Error) => void> = [];
  stdin = { write: (c: string) => this.stdinChunks.push(c), end: () => {} };
  stdout = { on: (_e: 'data', cb: (c: string) => void) => { this.out.push(cb); } };
  stderr = { on: (_e: 'data', cb: (c: string) => void) => { this.errCb.push(cb); } };
  on(ev: 'error' | 'close', cb: (...a: never[]) => void) {
    if (ev === 'close') this.closeCbs.push(cb as (c: number | null) => void);
    if (ev === 'error') this.errorCbs.push(cb as (e: Error) => void);
  }
  kill() { this.killed = true; }
  emitOut(s: string) { this.out.forEach((cb) => cb(s)); }
  doClose(code: number | null) { this.closeCbs.forEach((cb) => cb(code)); }
}

const req: AiChatRequest = {
  instructions: 'You are helpful.',
  history: [{ role: 'user', text: 'prev' }],
  userText: 'SENTINEL-USER-TEXT',
  model: { provider: 'claude', id: 'claude-sonnet-4-5' },
};

// Provider methods now `await buildMinimalEnv()` (async PATH resolver) before spawning.
// Stub the resolver so these tests never exec the real login shell and resolve fast.
beforeEach(() => {
  __setShellExecForTests(async () => 'GJC_PATH=/usr/bin\n');
  __setCliProbeForTests(() => true);
});
afterEach(() => __resetCliSpawnPathForTests());

describe('mapClaudeStreamJson (real stream-json schema)', () => {
  it('extracts assistant text as a delta', () => {
    expect(mapClaudeStreamJson({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } })).toEqual({ delta: 'hi' });
  });
  it('treats a success result as done and an error result as error', () => {
    expect(mapClaudeStreamJson({ type: 'result', subtype: 'success', is_error: false, result: 'hi' })).toEqual({ done: true });
    expect(mapClaudeStreamJson({ type: 'result', is_error: true, result: 'boom' })).toEqual({ error: 'boom' });
  });
  it('ignores system/hook/rate_limit records', () => {
    expect(mapClaudeStreamJson({ type: 'system', subtype: 'init' })).toBeNull();
    expect(mapClaudeStreamJson({ type: 'rate_limit_event' })).toBeNull();
  });
});

describe('buildCliPrompt', () => {
  it('folds system + history + user text into one stdin block with no file paths', () => {
    const p = buildCliPrompt(req);
    expect(p).toContain('You are helpful.');
    expect(p).toContain('User: prev');
    expect(p).toContain('User: SENTINEL-USER-TEXT');
  });
});

describe('ClaudeCliProvider', () => {
  function harness() {
    let child: FakeChild | undefined;
    let args: string[] = [];
    const spawn = (_c: string, a: string[]) => { args = a; child = new FakeChild(); return child; };
    const provider = new ClaudeCliProvider({ spawn });
    const events: AiChatEvent[] = [];
    const promise = provider.streamChat(req, (e) => events.push(e));
    return { promise, getChild: () => child!, getArgs: () => args, events };
  }

  it('streams assistant text then done; prompt via stdin only, model in argv', async () => {
    const h = harness();
    await new Promise((r) => setTimeout(r, 0)); // async buildMinimalEnv() resolves → spawn runs
    const child = h.getChild();
    child.emitOut('{"type":"system","subtype":"init"}\n');
    child.emitOut('{"type":"assistant","message":{"content":[{"type":"text","text":"hello world"}]}}\n');
    child.emitOut('{"type":"result","subtype":"success","is_error":false,"result":"hello world"}\n');
    child.doClose(0);
    await h.promise;

    expect(h.events.filter((e) => e.kind === 'delta').map((e) => (e as { text: string }).text)).toEqual(['hello world']);
    expect(h.events.at(-1)?.kind).toBe('done');
    expect(h.getArgs()).toContain('-p');
    expect(h.getArgs()).toContain('--disallowedTools');
    expect(h.getArgs()).toContain('claude-sonnet-4-5'); // model id allowed in argv
    expect(h.getArgs().join(' ')).not.toContain('SENTINEL-USER-TEXT'); // prompt NEVER in argv
    expect(child.stdinChunks.join('')).toContain('SENTINEL-USER-TEXT'); // prompt via stdin
  });
});

// Minimal StreamSource fakes for FallbackProvider.
function source(fn: (onEvent: (e: AiChatEvent) => void) => void): StreamSource {
  return { streamChat: async (_req, onEvent) => fn(onEvent) };
}

describe('FallbackProvider', () => {
  it('uses the primary and does NOT call the fallback on primary success', async () => {
    let fbCalled = false;
    let route = '';
    const fb: StreamSource = { streamChat: async (_r, oe) => { fbCalled = true; oe({ kind: 'done', text: '' }); } };
    const primary = source((oe) => { oe({ kind: 'delta', text: 'P' }); oe({ kind: 'done', text: '' }); });
    const fp = new FallbackProvider(primary, fb, { onRoute: (r) => { route = r; } });
    const events: AiChatEvent[] = [];
    await fp.streamChat(req, (e) => events.push(e));
    expect(fbCalled).toBe(false);
    expect(route).toBe('primary');
    expect(events.map((e) => e.kind)).toEqual(['delta', 'done']);
  });

  it('falls back when the primary errors BEFORE any output; primary error is swallowed', async () => {
    let route = '';
    const primary = source((oe) => oe({ kind: 'error', message: 'CLI missing', errorKind: 'provider' }));
    const fb = source((oe) => { oe({ kind: 'delta', text: 'API' }); oe({ kind: 'done', text: '' }); });
    const fp = new FallbackProvider(primary, fb, { onRoute: (r) => { route = r; } });
    const events: AiChatEvent[] = [];
    await fp.streamChat(req, (e) => events.push(e));
    expect(route).toBe('fallback');
    expect(events.some((e) => e.kind === 'error')).toBe(false); // primary error not surfaced
    expect(events.filter((e) => e.kind === 'delta').map((e) => (e as { text: string }).text)).toEqual(['API']);
  });

  it('does NOT fall back when the primary errors AFTER a delta (no duplicate output)', async () => {
    let fbCalled = false;
    const primary = source((oe) => { oe({ kind: 'delta', text: 'P' }); oe({ kind: 'error', message: 'mid', errorKind: 'network' }); });
    const fb: StreamSource = { streamChat: async () => { fbCalled = true; } };
    const fp = new FallbackProvider(primary, fb);
    const events: AiChatEvent[] = [];
    await fp.streamChat(req, (e) => events.push(e));
    expect(fbCalled).toBe(false);
    expect(events.some((e) => e.kind === 'error' && (e as { message: string }).message === 'mid')).toBe(true);
  });

  it('never falls back on user cancellation', async () => {
    let fbCalled = false;
    const primary = source((oe) => oe({ kind: 'error', message: 'cancelled', errorKind: 'cancelled' }));
    const fb: StreamSource = { streamChat: async () => { fbCalled = true; } };
    const fp = new FallbackProvider(primary, fb);
    const events: AiChatEvent[] = [];
    await fp.streamChat(req, (e) => events.push(e));
    expect(fbCalled).toBe(false);
    expect(events.some((e) => e.kind === 'error' && (e as { errorKind?: string }).errorKind === 'cancelled')).toBe(true);
  });
});
