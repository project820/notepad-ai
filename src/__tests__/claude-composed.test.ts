import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

import { ComposedClaudeProvider } from '../main/ai/claude-composed';
import { ProviderRegistry, type ProviderMap } from '../main/ai/provider-registry';
import type { ApiKeyStore } from '../main/ai/api-key-store';
import {
  __resetCliSpawnPathForTests,
  __setCliProbeForTests,
  __setShellExecForTests,
  type CliProcess,
} from '../main/ai/cli-runner';
import type { AiChatEvent, AiChatRequest, AiProvider } from '../main/ai/types';

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

// No API key => the inner ClaudeProvider (API fallback) emits an auth error
// WITHOUT calling the network. So the presence/absence of that auth error tells
// us whether the API fallback path was reached.
const noKeyStore = { getApiKey: async () => null, getKeyStatus: async () => ({ connected: false, persisted: false }) } as unknown as ApiKeyStore;

const req: AiChatRequest = { instructions: 's', history: [], userText: 'hi', model: { provider: 'claude', id: 'claude-sonnet-4-5' } };

describe('ComposedClaudeProvider (CLI-first + API fallback)', () => {
  // Hermetic CLI resolver: stub shell-exec (no real subprocess) and force the CLI
  // probe true so PATH resolution is single-stage + filesystem-independent. Needed
  // now that buildMinimalEnv() is async — the CLI spawn is deferred past getChild().
  beforeEach(() => {
    __resetCliSpawnPathForTests();
    __setShellExecForTests(async () => 'GJC_PATH=/usr/bin:/bin');
    __setCliProbeForTests(() => true);
  });
  afterEach(() => {
    __resetCliSpawnPathForTests();
  });

  function run(over: Partial<AiChatRequest> = {}) {
    let child: FakeChild | undefined;
    let spawnCalls = 0;
    const spawn = () => { spawnCalls++; child = new FakeChild(); return child; };
    const provider = new ComposedClaudeProvider(noKeyStore, spawn);
    const events: AiChatEvent[] = [];
    const promise = provider.streamChat({ ...req, ...over }, (e) => events.push(e));
    // spawn is now deferred behind `await buildMinimalEnv()`; waitChild flushes the
    // async resolver (macrotasks) until the child appears so tests can drive stdout.
    const waitChild = async (): Promise<FakeChild> => {
      for (let i = 0; i < 50 && !child; i++) await new Promise((r) => setTimeout(r, 0));
      if (!child) throw new Error('CLI child was never spawned');
      return child;
    };
    return { promise, getChild: () => child!, waitChild, events, getSpawnCalls: () => spawnCalls };
  }

  it('uses the CLI on success and does NOT fall back to the API (no auth error)', async () => {
    const h = run();
    const child = await h.waitChild();
    child.emitOut('{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}\n');
    child.emitOut('{"type":"result","subtype":"success","is_error":false,"result":"hello"}\n');
    child.doClose(0);
    await h.promise;
    expect(h.events.filter((e) => e.kind === 'delta').map((e) => (e as { text: string }).text)).toEqual(['hello']);
    expect(h.events.at(-1)?.kind).toBe('done');
    expect(h.events.some((e) => e.kind === 'error')).toBe(false); // API fallback NOT reached
  });

  it('falls back to the API path when the CLI fails before any output', async () => {
    const h = run();
    const child = await h.waitChild();
    child.emitOut('{"type":"result","is_error":true,"result":"claude: not logged in"}\n');
    await h.promise;
    // Fallback reached the API provider, which (no key) emits an auth error.
    expect(h.events.some((e) => e.kind === 'error')).toBe(true);
  });

  it('routes image requests straight to the API path (CLI never spawned)', async () => {
    const h = run({ images: [{ mime: 'image/png', base64: 'iVBORw0KGgo=', bytes: 8 }] });
    await h.promise;
    expect(h.getSpawnCalls()).toBe(0); // CLI not spawned for image turns
    expect(h.events.some((e) => e.kind === 'error')).toBe(true); // API path (no key) → auth error
  });

  it('routes a maxOutputTokens request to the API directly when the key is connected (CLI never spawned)', async () => {
    // getKeyStatus reports connected (so the diversion triggers) but getApiKey is
    // null, so the API path short-circuits with an auth error WITHOUT a network
    // call. Zero spawns + that auth error prove the DIRECT API route — not a
    // CLI-first spawn that later fell back.
    const connectedNoKey = {
      getApiKey: async () => null,
      getKeyStatus: async () => ({ connected: true, keyLast4: 'x', persisted: true }),
    } as unknown as ApiKeyStore;
    let spawnCalls = 0;
    const spawn = () => { spawnCalls++; return new FakeChild(); };
    const provider = new ComposedClaudeProvider(connectedNoKey, spawn);
    const events: AiChatEvent[] = [];
    await provider.streamChat({ ...req, maxOutputTokens: 64_000 }, (e) => events.push(e));
    expect(spawnCalls).toBe(0); // CLI-first bypassed → direct API route (budget honored)
    expect(events.some((e) => e.kind === 'error')).toBe(true); // API path (no key) → auth error
  });

  it('keeps a maxOutputTokens request on CLI-first when no API key is connected', async () => {
    // noKeyStore → getKeyStatus connected:false, so the diversion must NOT fire;
    // CLI-first stands (CLI spawned + succeeds) even though maxOutputTokens is set.
    const h = run({ maxOutputTokens: 64_000 });
    const child = await h.waitChild();
    child.emitOut('{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}\n');
    child.emitOut('{"type":"result","subtype":"success","is_error":false,"result":"hi"}\n');
    child.doClose(0);
    await h.promise;
    expect(h.getSpawnCalls()).toBe(1); // CLI-first preserved (no key to divert to)
    expect(h.events.some((e) => e.kind === 'error')).toBe(false);
  });
});

// A fake provider to verify registry routing without spawning anything.
function fakeProvider(id: AiProvider['id'], authKind: AiProvider['authKind'], onStream: (e: (ev: AiChatEvent) => void) => void): AiProvider & { calls: number } {
  return {
    id, authKind, calls: 0,
    getAuthStatus: async () => ({ provider: id, authKind, connected: true, label: id }),
    listModels: async () => [],
    streamChat: async function (this: { calls: number }, _r, oe) { this.calls++; onStream(oe); },
  } as AiProvider & { calls: number };
}

describe('ProviderRegistry — grok routing + cli auth', () => {
  it('routes a grok request to the grok provider only', async () => {
    const grok = fakeProvider('grok', 'cli', (oe) => { oe({ kind: 'delta', text: 'G' }); oe({ kind: 'done', text: '' }); });
    const claude = fakeProvider('claude', 'api_key', (oe) => oe({ kind: 'done', text: '' }));
    const map: ProviderMap = { grok, claude };
    const reg = new ProviderRegistry({ setApiKey: vi.fn(), deleteApiKey: vi.fn() } as unknown as ApiKeyStore, map);
    const events: AiChatEvent[] = [];
    await reg.streamProviderChat({ ...req, model: { provider: 'grok', id: 'grok' } }, (e) => events.push(e));
    expect(grok.calls).toBe(1);
    expect(claude.calls).toBe(0);
    expect(events.map((e) => e.kind)).toContain('done');
  });

  it('rejects setApiKey for the grok CLI provider with install/login guidance', async () => {
    const reg = new ProviderRegistry({ setApiKey: vi.fn() } as unknown as ApiKeyStore, {});
    await expect(reg.setApiKey('grok', 'x')).rejects.toThrow(/CLI|login|install/i);
  });
});
