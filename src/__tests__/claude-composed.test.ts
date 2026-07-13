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
  emitErr(s: string) { this.errCb.forEach((cb) => cb(s)); }
  doClose(code: number | null) { this.closeCbs.forEach((cb) => cb(code)); }
}

// No API key => the inner ClaudeProvider (API fallback) emits an auth error
// WITHOUT calling the network. So the presence/absence of that auth error tells
// us whether the API fallback path was reached.
const noKeyStore = { getApiKey: async () => null, getKeyStatus: async () => ({ connected: false, persisted: false }) } as unknown as ApiKeyStore;

const req: AiChatRequest = { instructions: 's', history: [], userText: 'hi', model: { provider: 'claude', id: 'claude-sonnet-4-5' } };
const trustedClaude = async () => ({ command: '/trusted/claude' });

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
    const spawn = (_command: string, args: string[]) => {
      spawnCalls++;
      const next = new FakeChild();
      if (args[0] === '--version') queueMicrotask(() => next.doClose(0));
      else child = next;
      return next;
    };
    const provider = new ComposedClaudeProvider(noKeyStore, spawn, trustedClaude);
    const events: AiChatEvent[] = [];
    const promise = provider.streamChat({ ...req, ...over }, (e) => events.push(e));
    // spawn is now deferred behind `await buildMinimalEnv()`; waitChild flushes the
    // async resolver (macrotasks) until the child appears so tests can drive stdout.
    const waitChild = async (): Promise<FakeChild> => {
      for (let i = 0; i < 50 && !child; i++) await new Promise((r) => setTimeout(r, 0));
      if (!child) throw new Error('CLI child was never spawned');
      return child;
    };
    return { provider, promise, getChild: () => child!, waitChild, events, getSpawnCalls: () => spawnCalls };
  }
  it('reports an unverified CLI transport without implying that an API key is set', async () => {
    const spawn = () => {
      const child = new FakeChild();
      queueMicrotask(() => child.doClose(0));
      return child;
    };
    const status = await new ComposedClaudeProvider(noKeyStore, spawn, trustedClaude).getAuthStatus();
    expect(status).toMatchObject({
      provider: 'claude',
      authKind: 'api_key',
      connected: false,
      cliStatus: {
        installed: true,
        authState: 'unknown',
        errorCode: 'claude_cli_auth_unknown',
      },
    });
    expect(status.keyLast4).toBeUndefined();
  });
  it('re-probes a persisted Claude CLI session in a fresh provider instance', async () => {
    const spawn = vi.fn((_command: string, args: string[]) => {
      const child = new FakeChild();
      queueMicrotask(() => {
        child.emitOut('{"loggedIn":true,"authMethod":"oauth_token"}');
        child.doClose(0);
      });
      return child;
    });

    const provider = new ComposedClaudeProvider(noKeyStore, spawn, trustedClaude);
    const status = await provider.getAuthStatus();

    expect(spawn).toHaveBeenCalledWith('/trusted/claude', ['auth', 'status', '--json'], expect.any(Object));
    expect(status).toMatchObject({
      connected: true,
      connectionSource: 'cli',
      cliStatus: { installed: true, authState: 'succeeded' },
    });
    await expect(provider.getAuthStatus()).resolves.toMatchObject({ connected: true });
    expect(spawn).toHaveBeenCalledTimes(1);
  });
  it('keeps a confirmed logout as an auth-failed cache entry instead of fresh unknown', async () => {
    const spawn = vi.fn(() => new FakeChild());
    const provider = new ComposedClaudeProvider(noKeyStore, spawn, trustedClaude);

    provider.recordCliAuthResult('auth_failed');

    await expect(provider.getAuthStatus()).resolves.toMatchObject({
      connected: false,
      cliStatus: { installed: true, authState: 'auth_failed', errorCode: 'claude_cli_login_required' },
    });
    expect(spawn).not.toHaveBeenCalled();
  });
  it('does not let an earlier status probe overwrite a confirmed logout', async () => {
    const status = new FakeChild();
    const spawn = vi.fn(() => status);
    const provider = new ComposedClaudeProvider(noKeyStore, spawn, trustedClaude);

    const pending = provider.getAuthStatus();
    for (let i = 0; i < 50 && spawn.mock.calls.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    provider.recordCliAuthResult('auth_failed');
    const joined = provider.getAuthStatus();
    status.emitOut('{"loggedIn":true}');
    status.doClose(0);

    await expect(pending).resolves.toMatchObject({ cliStatus: { authState: 'auth_failed' } });
    await expect(joined).resolves.toMatchObject({ cliStatus: { authState: 'auth_failed' } });
    await expect(provider.getAuthStatus()).resolves.toMatchObject({ cliStatus: { authState: 'auth_failed' } });
  });

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
    expect(await h.provider.getAuthStatus()).toMatchObject({
      connected: true,
      connectionSource: 'cli',
      cliStatus: { installed: true, authState: 'succeeded' },
    });
  });

  it('falls back to the API path when the CLI fails before any output', async () => {
    const h = run();
    const child = await h.waitChild();
    child.emitErr('not logged in');
    child.doClose(1);
    await h.promise;
    // Fallback reached the API provider, which (no key) emits an auth error.
    expect(h.events.some((e) => e.kind === 'error')).toBe(true);
    expect((await h.provider.getAuthStatus()).cliStatus).toMatchObject({
      installed: true,
      authState: 'auth_failed',
      errorCode: 'claude_cli_login_required',
    });
  });

  it('routes image requests straight to the API path (CLI never spawned)', async () => {
    const h = run({ images: [{ mime: 'image/png', base64: 'iVBORw0KGgo=', bytes: 8 }] });
    await h.promise;
    expect(h.getSpawnCalls()).toBe(0); // CLI not spawned for image turns
    expect(h.events.some((e) => e.kind === 'error')).toBe(true); // API path (no key) → auth error
  });

  it('keeps a maxOutputTokens request on CLI-first even when an API key IS connected (subscription — no paid-API diversion)', async () => {
    // A subscriber must NOT be pushed onto the paid Anthropic API just because a
    // max-output budget is set. `claude -p` (CLI, subscription) is used even with a
    // connected key; the CLI's own default output cap applies. Zero API touch.
    const connectedKey = {
      getApiKey: async () => 'sk-ant-live',
      getKeyStatus: async () => ({ connected: true, keyLast4: 'live', persisted: true }),
    } as unknown as ApiKeyStore;
    let child: FakeChild | undefined;
    let spawnCalls = 0;
    const spawn = () => { spawnCalls++; child = new FakeChild(); return child; };
    const provider = new ComposedClaudeProvider(connectedKey, spawn, trustedClaude);
    const events: AiChatEvent[] = [];
    const promise = provider.streamChat({ ...req, maxOutputTokens: 64_000 }, (e) => events.push(e));
    for (let i = 0; i < 50 && !child; i++) await new Promise((r) => setTimeout(r, 0));
    if (!child) throw new Error('CLI child never spawned — request was wrongly diverted to the paid API');
    child.emitOut('{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}\n');
    child.emitOut('{"type":"result","subtype":"success","is_error":false,"result":"hi"}\n');
    child.doClose(0);
    await promise;
    expect(spawnCalls).toBe(1); // CLI-first used (subscription) despite the connected key
    expect(events.some((e) => e.kind === 'error')).toBe(false); // never touched the paid API path
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

  it('persists a Grok xAI API key instead of rejecting the dual-transport provider', async () => {
    const setApiKey = vi.fn().mockResolvedValue({ persisted: true });
    const reg = new ProviderRegistry({ setApiKey, deleteApiKey: vi.fn() } as unknown as ApiKeyStore, {});
    await expect(reg.setApiKey('grok', 'x')).resolves.toEqual({ persisted: true });
    expect(setApiKey).toHaveBeenCalledWith('grok', 'x');
  });
});
