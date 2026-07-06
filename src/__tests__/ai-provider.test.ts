import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AiProviderError,
  classifyHttpError,
  isAiProviderId,
} from '../main/ai/types';
import type {
  AiChatEvent,
  AiChatRequest,
  AiProvider,
  ModelRef,
  ProviderAuthStatus,
} from '../main/ai/types';
import {
  claudeErrorMessage,
  extractClaudeTextDelta,
  extractOpenAiTextDelta,
  isOpenAiDone,
  splitSseEvents,
  sseDataPayload,
} from '../main/ai/sse';
import { toAnthropicMessages, toOpenAiMessages } from '../main/ai/messages';
import { ApiKeyStore, keyLast4, type KeyStoreBackend } from '../main/ai/api-key-store';
import {
  getCuratedModels,
  humanizeEngineIdForProvider,
  isKnownModel,
  makeCustomModel,
  resolveModelRef,
} from '../main/ai/model-catalog';
import { ProviderRegistry, type ProviderMap } from '../main/ai/provider-registry';
import { ClaudeProvider } from '../main/ai/claude-provider';
import { OpenRouterProvider } from '../main/ai/openrouter-provider';
import { LmStudioProvider } from '../main/ai/lmstudio-provider';
import {
  OllamaProvider,
  extractOllamaChatDelta,
  ollamaChatErrorMessage,
  isOllamaChatDone,
  extractOllamaContextLength,
} from '../main/ai/ollama-provider';
import { LocalModelCache } from '../main/ai/local-model-cache';
import {
  normalizeLocalBaseUrl,
  parseLocalConfig,
  LocalConfigStore,
  type LocalConfigBackend,
} from '../main/ai/local-config';

// ---------------------------------------------------------------------------
// types.classifyHttpError — actionable, classified errors (AC24)
// ---------------------------------------------------------------------------
describe('classifyHttpError', () => {
  it('maps 401/403 to an auth error', () => {
    for (const status of [401, 403]) {
      const err = classifyHttpError('Claude', status, 'bad key');
      expect(err).toBeInstanceOf(AiProviderError);
      expect(err.errorKind).toBe('auth');
      expect(err.message).toContain('API key');
      expect(err.message).toContain('bad key');
    }
  });
  it('maps 429 to a rate_limit error', () => {
    const err = classifyHttpError('OpenRouter', 429);
    expect(err.errorKind).toBe('rate_limit');
    expect(err.message).toContain('rate limiting');
  });
  it('maps other statuses to a generic provider error', () => {
    const err = classifyHttpError('OpenRouter', 500, 'boom');
    expect(err.errorKind).toBe('provider');
    expect(err.message).toContain('HTTP 500');
  });
});

describe('isAiProviderId', () => {
  it('accepts all five provider ids and rejects others', () => {
    expect(isAiProviderId('chatgpt')).toBe(true);
    expect(isAiProviderId('claude')).toBe(true);
    expect(isAiProviderId('openrouter')).toBe(true);
    expect(isAiProviderId('ollama')).toBe(true);
    expect(isAiProviderId('lmstudio')).toBe(true);
    expect(isAiProviderId('gemini')).toBe(false);
    expect(isAiProviderId(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SSE parsing — normalization for both providers (AC24)
// ---------------------------------------------------------------------------
describe('sse parsing', () => {
  it('splits complete events and keeps the remainder', () => {
    const { events, rest } = splitSseEvents('data: a\n\ndata: b\n\ndata: c');
    expect(events).toEqual(['data: a', 'data: b']);
    expect(rest).toBe('data: c');
  });
  it('handles CRLF separators', () => {
    const { events } = splitSseEvents('data: a\r\n\r\ndata: b\r\n\r\n');
    expect(events).toEqual(['data: a', 'data: b']);
  });
  it('joins multi-line data payloads', () => {
    expect(sseDataPayload('event: x\ndata: line1\ndata: line2')).toBe('line1\nline2');
  });
  it('extracts Claude text deltas only from content_block_delta', () => {
    const delta = JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '안녕' } });
    expect(extractClaudeTextDelta(delta)).toBe('안녕');
    expect(extractClaudeTextDelta(JSON.stringify({ type: 'message_start' }))).toBe('');
    expect(extractClaudeTextDelta('not json')).toBe('');
  });
  it('detects Claude error events', () => {
    const err = JSON.stringify({ type: 'error', error: { message: 'overloaded' } });
    expect(claudeErrorMessage(err)).toBe('overloaded');
    expect(claudeErrorMessage(JSON.stringify({ type: 'content_block_delta' }))).toBeNull();
  });
  it('extracts OpenAI-compatible deltas and detects [DONE]', () => {
    const delta = JSON.stringify({ choices: [{ delta: { content: 'world' } }] });
    expect(extractOpenAiTextDelta(delta)).toBe('world');
    expect(extractOpenAiTextDelta('[DONE]')).toBe('');
    expect(isOpenAiDone('[DONE]')).toBe(true);
    expect(isOpenAiDone(delta)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Message shaping
// ---------------------------------------------------------------------------
describe('toAnthropicMessages', () => {
  it('appends the user turn and merges consecutive same-role turns', () => {
    const msgs = toAnthropicMessages(
      [
        { role: 'user', text: 'a' },
        { role: 'user', text: 'b' },
        { role: 'assistant', text: 'c' },
      ],
      'd',
    );
    expect(msgs).toEqual([
      { role: 'user', content: 'a\n\nb' },
      { role: 'assistant', content: 'c' },
      { role: 'user', content: 'd' },
    ]);
  });
  it('drops leading assistant turns so it starts with user', () => {
    const msgs = toAnthropicMessages([{ role: 'assistant', text: 'hi' }], 'q');
    expect(msgs[0].role).toBe('user');
  });
});

describe('toOpenAiMessages', () => {
  it('puts system first, then history, then user', () => {
    const msgs = toOpenAiMessages('SYS', [{ role: 'assistant', text: 'prev' }], 'now');
    expect(msgs).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'assistant', content: 'prev' },
      { role: 'user', content: 'now' },
    ]);
  });
  it('omits an empty system message', () => {
    const msgs = toOpenAiMessages('  ', [], 'hi');
    expect(msgs).toEqual([{ role: 'user', content: 'hi' }]);
  });
});

// ---------------------------------------------------------------------------
// ApiKeyStore — refuse-persist + redaction (AC21)
// ---------------------------------------------------------------------------
function makeBackend(encryptionAvailable: boolean): KeyStoreBackend & { disk: Buffer | null } {
  const state = { disk: null as Buffer | null };
  return {
    disk: null,
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (plain: string) => Buffer.from(`enc:${plain}`, 'utf-8'),
    decryptString: (buf: Buffer) => buf.toString('utf-8').replace(/^enc:/, ''),
    readFile: async () => state.disk,
    writeFile: async (buf: Buffer) => {
      state.disk = buf;
    },
    removeFile: async () => {
      state.disk = null;
    },
    get diskRef() {
      return state.disk;
    },
  } as unknown as KeyStoreBackend & { disk: Buffer | null };
}

describe('ApiKeyStore', () => {
  it('keyLast4 returns the last 4 chars', () => {
    expect(keyLast4('sk-abcd1234')).toBe('1234');
    expect(keyLast4('xy')).toBe('xy');
  });

  it('persists encrypted when safeStorage is available', async () => {
    const backend = makeBackend(true);
    const store = new ApiKeyStore(backend);
    const res = await store.setApiKey('claude', 'sk-secret-9999');
    expect(res.persisted).toBe(true);
    const status = await store.getKeyStatus('claude');
    expect(status).toEqual({ connected: true, keyLast4: '9999', persisted: true });
    // A fresh store over the same backend can read it back (encrypted at rest).
    const reloaded = new ApiKeyStore(backend);
    expect(await reloaded.getApiKey('claude')).toBe('sk-secret-9999');
  });

  it('REFUSES disk persistence and keeps keys in memory only when encryption is unavailable', async () => {
    const backend = makeBackend(false);
    const writeSpy = vi.spyOn(backend, 'writeFile');
    const store = new ApiKeyStore(backend);
    const res = await store.setApiKey('openrouter', 'or-key-4321');
    expect(res.persisted).toBe(false);
    expect(writeSpy).not.toHaveBeenCalled(); // never wrote plaintext
    // Usable in this session...
    expect(await store.getApiKey('openrouter')).toBe('or-key-4321');
    const status = await store.getKeyStatus('openrouter');
    expect(status.connected).toBe(true);
    expect(status.persisted).toBe(false);
    // ...but a different store instance cannot recover it (memory-only).
    const reloaded = new ApiKeyStore(backend);
    expect(await reloaded.getApiKey('openrouter')).toBeNull();
  });

  it('never returns full key material through status', async () => {
    const store = new ApiKeyStore(makeBackend(true));
    await store.setApiKey('claude', 'sk-very-secret-key-7777');
    const status = await store.getKeyStatus('claude');
    expect(JSON.stringify(status)).not.toContain('very-secret');
    expect(status.keyLast4).toBe('7777');
  });

  it('deletes keys', async () => {
    const store = new ApiKeyStore(makeBackend(true));
    await store.setApiKey('claude', 'sk-1234');
    await store.deleteApiKey('claude');
    expect(await store.getApiKey('claude')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Model catalog — custom-id fallback (AC22)
// ---------------------------------------------------------------------------
describe('model catalog', () => {
  it('every curated model carries a provider-bound humanize engine id', () => {
    for (const m of getCuratedModels()) {
      expect(m.humanizeEngineId).toBe(humanizeEngineIdForProvider(m.provider));
    }
  });
  it('makeCustomModel marks the entry custom and attaches the engine id', () => {
    const m = makeCustomModel('openrouter', '  vendor/new-model  ');
    expect(m).toMatchObject({ provider: 'openrouter', id: 'vendor/new-model', custom: true, humanizeEngineId: 'openrouter' });
  });
  it('resolveModelRef falls back to a custom ref for unknown ids (no lockout)', () => {
    const catalog = getCuratedModels();
    expect(isKnownModel(catalog, 'claude', 'claude-sonnet-4-6')).toBe(true);
    const resolved = resolveModelRef(catalog, 'claude', 'claude-future-99');
    expect(resolved.custom).toBe(true);
    expect(resolved.id).toBe('claude-future-99');
  });
});

// ---------------------------------------------------------------------------
// ProviderRegistry — routing, gating, no silent fallback (AC21-25)
// ---------------------------------------------------------------------------
function fakeProvider(
  id: AiProvider['id'],
  connected: boolean,
  onStream: (req: AiChatRequest, onEvent: (e: AiChatEvent) => void) => void,
  models: ModelRef[] = [],
): AiProvider & { streamCalls: number } {
  const status: ProviderAuthStatus = {
    provider: id,
    authKind: id === 'chatgpt' ? 'oauth' : 'api_key',
    connected,
    label: id,
  };
  return {
    id,
    authKind: status.authKind,
    streamCalls: 0,
    async getAuthStatus() {
      return status;
    },
    async listModels() {
      return models;
    },
    async streamChat(req, onEvent) {
      (this as { streamCalls: number }).streamCalls++;
      onStream(req, onEvent);
    },
  } as AiProvider & { streamCalls: number };
}

function fakeKeyStore(): ApiKeyStore {
  return new ApiKeyStore(makeBackend(true));
}

function baseReq(provider: AiProvider['id'], id = 'm'): AiChatRequest {
  return { instructions: 'i', history: [], userText: 'u', model: { provider, id } };
}

describe('ProviderRegistry routing', () => {
  it('routes only to the selected provider', async () => {
    const claude = fakeProvider('claude', true, (_r, e) => {
      e({ kind: 'delta', text: 'C' });
      e({ kind: 'done', text: 'C' });
    });
    const openrouter = fakeProvider('openrouter', true, (_r, e) => e({ kind: 'done', text: 'O' }));
    const chatgpt = fakeProvider('chatgpt', true, (_r, e) => e({ kind: 'done', text: 'G' }));
    const map: ProviderMap = { chatgpt, claude, openrouter };
    const reg = new ProviderRegistry(fakeKeyStore(), map);

    const events: AiChatEvent[] = [];
    await reg.streamProviderChat(baseReq('claude'), (e) => events.push(e));
    expect((claude as { streamCalls: number }).streamCalls).toBe(1);
    expect((openrouter as { streamCalls: number }).streamCalls).toBe(0);
    expect((chatgpt as { streamCalls: number }).streamCalls).toBe(0);
    expect(events.map((e) => e.kind)).toContain('done');
  });

  it('emits an auth error and does NOT call the provider when disconnected (no silent fallback)', async () => {
    const claude = fakeProvider('claude', false, () => {
      throw new Error('should not be called');
    });
    const map: ProviderMap = {
      chatgpt: fakeProvider('chatgpt', true, (_r, e) => e({ kind: 'done', text: 'G' })),
      claude,
      openrouter: fakeProvider('openrouter', true, (_r, e) => e({ kind: 'done', text: 'O' })),
    };
    const reg = new ProviderRegistry(fakeKeyStore(), map);
    const events: AiChatEvent[] = [];
    await reg.streamProviderChat(baseReq('claude'), (e) => events.push(e));
    expect((claude as { streamCalls: number }).streamCalls).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'error', errorKind: 'auth' });
  });

  it('hasAnyAuth reflects whether any provider is connected (zero-auth gating)', async () => {
    const allOff: ProviderMap = {
      chatgpt: fakeProvider('chatgpt', false, () => {}),
      claude: fakeProvider('claude', false, () => {}),
      openrouter: fakeProvider('openrouter', false, () => {}),
    };
    expect(await new ProviderRegistry(fakeKeyStore(), allOff).hasAnyAuth()).toBe(false);

    const oneOn: ProviderMap = {
      chatgpt: fakeProvider('chatgpt', false, () => {}),
      claude: fakeProvider('claude', true, () => {}),
      openrouter: fakeProvider('openrouter', false, () => {}),
    };
    expect(await new ProviderRegistry(fakeKeyStore(), oneOn).hasAnyAuth()).toBe(true);
  });

  it('setApiKey rejects chatgpt (sign-in, not key)', async () => {
    const reg = new ProviderRegistry(fakeKeyStore(), {
      chatgpt: fakeProvider('chatgpt', true, () => {}),
      claude: fakeProvider('claude', true, () => {}),
      openrouter: fakeProvider('openrouter', true, () => {}),
    });
    await expect(reg.setApiKey('chatgpt', 'x')).rejects.toThrow(/sign-in/);
  });

  it('getAvailableModels merges curated with live chatgpt models, deduped', async () => {
    const live: ModelRef[] = [
      { provider: 'chatgpt', id: 'gpt-5.4-mini', label: 'dup', humanizeEngineId: 'openai', requiresAuth: true },
      { provider: 'chatgpt', id: 'gpt-live-new', label: 'new', humanizeEngineId: 'openai', requiresAuth: true },
    ];
    const reg = new ProviderRegistry(fakeKeyStore(), {
      chatgpt: fakeProvider('chatgpt', true, () => {}, live),
      claude: fakeProvider('claude', true, () => {}),
      openrouter: fakeProvider('openrouter', true, () => {}),
    });
    const models = await reg.getAvailableModels();
    const chatgptIds = models.filter((m) => m.provider === 'chatgpt').map((m) => m.id);
    expect(chatgptIds).toContain('gpt-live-new');
    expect(chatgptIds.filter((id) => id === 'gpt-5.4-mini')).toHaveLength(1); // deduped
  });
});

// ---------------------------------------------------------------------------
// BYO-key providers — missing key -> actionable auth error (AC23/24)
// ---------------------------------------------------------------------------
describe('BYO-key providers without a key', () => {
  it('Claude emits an auth error when no key is set', async () => {
    const provider = new ClaudeProvider(fakeKeyStore());
    const events: AiChatEvent[] = [];
    await provider.streamChat(baseReq('claude'), (e) => events.push(e));
    expect(events).toEqual([
      expect.objectContaining({ kind: 'error', errorKind: 'auth' }),
    ]);
    expect(events[0]).toMatchObject({ message: expect.stringContaining('API key') });
  });
  it('OpenRouter emits an auth error when no key is set', async () => {
    const provider = new OpenRouterProvider(fakeKeyStore());
    const events: AiChatEvent[] = [];
    await provider.streamChat(baseReq('openrouter'), (e) => events.push(e));
    expect(events[0]).toMatchObject({ kind: 'error', errorKind: 'auth' });
  });
});

// ---------------------------------------------------------------------------
// listModels derives from the curated catalog (no duplicate drift) — PR-1
// ---------------------------------------------------------------------------
describe('BYO-key listModels derives from the curated catalog', () => {
  it('ClaudeProvider.listModels mirrors the curated claude rows exactly', async () => {
    const provider = new ClaudeProvider(fakeKeyStore());
    const models = await provider.listModels();
    const curated = getCuratedModels().filter((m) => m.provider === 'claude');
    // Derived, not a hand-maintained dup: ids/labels/order match the catalog.
    expect(models.map((m) => m.id)).toEqual(curated.map((m) => m.id));
    expect(models.map((m) => m.label)).toEqual(curated.map((m) => m.label));
    // Current Claude ids, smoke-verified via `claude -p --model <id>` (opus-4-8 /
    // sonnet-4-6 accepted directly; the prior opus-4-1 is a legacy alias the CLI
    // auto-remaps to opus-4-8). See the PR body for the recorded smoke transcript.
    expect(models.map((m) => m.id)).toEqual([
      'claude-opus-4-8',
      'claude-sonnet-5',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
    ]);
    expect(models.every((m) => m.provider === 'claude' && m.requiresAuth === true)).toBe(true);
    expect(models.every((m) => m.humanizeEngineId === 'claude')).toBe(true);
  });

  it('OpenRouterProvider.listModels mirrors the curated openrouter rows exactly', async () => {
    const provider = new OpenRouterProvider(fakeKeyStore());
    const models = await provider.listModels();
    const curated = getCuratedModels().filter((m) => m.provider === 'openrouter');
    expect(models.map((m) => m.id)).toEqual(curated.map((m) => m.id));
    expect(models.map((m) => m.label)).toEqual(curated.map((m) => m.label));
    // The OpenRouter Claude slug is kept UNCHANGED (no live smoke → no migration).
    expect(models.map((m) => m.id)).toContain('anthropic/claude-sonnet-4.5');
    expect(models.every((m) => m.provider === 'openrouter' && m.requiresAuth === true)).toBe(true);
    expect(models.every((m) => m.humanizeEngineId === 'openrouter')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// OpenRouter provider — end-to-end streaming via mocked fetch
// ---------------------------------------------------------------------------
function streamingResponse(chunks: string[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status });
}

describe('OpenRouterProvider streaming (mocked fetch)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('assembles deltas and finishes on [DONE]', async () => {
    const store = new ApiKeyStore(makeBackend(true));
    await store.setApiKey('openrouter', 'or-test-key');
    const provider = new OpenRouterProvider(store);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        streamingResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'lo' } }] })}\n\n`,
          'data: [DONE]\n\n',
        ]),
      ),
    );

    const events: AiChatEvent[] = [];
    await provider.streamChat(baseReq('openrouter', 'x-ai/grok-4'), (e) => events.push(e));
    const deltas = events.filter((e) => e.kind === 'delta').map((e) => (e as { text: string }).text);
    expect(deltas.join('')).toBe('Hello');
    const done = events.find((e) => e.kind === 'done') as { text: string } | undefined;
    expect(done?.text).toBe('Hello');
  });

  it('surfaces a classified auth error on HTTP 401', async () => {
    const store = new ApiKeyStore(makeBackend(true));
    await store.setApiKey('openrouter', 'bad');
    const provider = new OpenRouterProvider(store);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })));
    const events: AiChatEvent[] = [];
    await provider.streamChat(baseReq('openrouter'), (e) => events.push(e));
    expect(events[0]).toMatchObject({ kind: 'error', errorKind: 'auth' });
  });
});

// ===========================================================================
// LOCAL PROVIDERS (G002 / Phase A1) — Ollama + LM Studio
// ===========================================================================

/** JSON Response helper for mocked discovery endpoints. */
function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A fake local provider with static-connected auth and a custom listModels. */
function localFakeProvider(
  id: 'ollama' | 'lmstudio',
  listModels: () => Promise<ModelRef[]>,
): AiProvider {
  return {
    id,
    authKind: 'local',
    async getAuthStatus() {
      return { provider: id, authKind: 'local', connected: true, label: id } as ProviderAuthStatus;
    },
    listModels,
    async streamChat() {
      /* unused */
    },
  } as AiProvider;
}

/** A local provider whose listModels is a spy (for cache dedup assertions). */
function cacheFakeProvider(id: 'ollama' | 'lmstudio', listImpl: () => Promise<ModelRef[]>) {
  return {
    id,
    authKind: 'local',
    getAuthStatus: async () =>
      ({ provider: id, authKind: 'local', connected: true, label: id }) as ProviderAuthStatus,
    listModels: vi.fn(listImpl),
    streamChat: async () => {},
  } as unknown as AiProvider & { listModels: ReturnType<typeof vi.fn> };
}

function localModelRef(provider: 'ollama' | 'lmstudio', id: string): ModelRef {
  return { provider, id, label: id, humanizeEngineId: 'openai', requiresAuth: false };
}

// ---------------------------------------------------------------------------
// local-config — localhost-only URL validation
// ---------------------------------------------------------------------------
describe('normalizeLocalBaseUrl', () => {
  it('accepts localhost http(s) URLs and strips path / trailing slash', () => {
    expect(normalizeLocalBaseUrl('http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434');
    expect(normalizeLocalBaseUrl('http://127.0.0.1:11434/')).toBe('http://127.0.0.1:11434');
    expect(normalizeLocalBaseUrl('http://localhost:1234/v1/')).toBe('http://localhost:1234');
    expect(normalizeLocalBaseUrl('https://localhost')).toBe('https://localhost');
    expect(normalizeLocalBaseUrl('http://[::1]:1234')).toBe('http://[::1]:1234');
  });
  it('rejects remote hosts, file URLs, non-http schemes, and malformed input', () => {
    expect(normalizeLocalBaseUrl('http://example.com:11434')).toBeNull();
    expect(normalizeLocalBaseUrl('http://127.0.0.1.evil.com')).toBeNull();
    expect(normalizeLocalBaseUrl('file:///etc/passwd')).toBeNull();
    expect(normalizeLocalBaseUrl('ftp://localhost')).toBeNull();
    expect(normalizeLocalBaseUrl('not a url')).toBeNull();
    expect(normalizeLocalBaseUrl('')).toBeNull();
    expect(normalizeLocalBaseUrl(undefined)).toBeNull();
  });
});

describe('parseLocalConfig', () => {
  it('falls back to defaults for malformed JSON or remote URLs', () => {
    expect(parseLocalConfig('not json')).toEqual({
      ollama: 'http://127.0.0.1:11434',
      lmstudio: 'http://127.0.0.1:1234',
    });
    expect(
      parseLocalConfig(JSON.stringify({ ollama: 'http://evil.com', lmstudio: 'http://localhost:4321' })),
    ).toEqual({ ollama: 'http://127.0.0.1:11434', lmstudio: 'http://localhost:4321' });
  });
});

describe('LocalConfigStore', () => {
  function memConfigBackend(initial: string | null = null) {
    const state = { raw: initial };
    const backend: LocalConfigBackend & { state: { raw: string | null } } = {
      state,
      readFile: async () => state.raw,
      writeFile: async (json: string) => {
        state.raw = json;
      },
    };
    return backend;
  }

  it('returns defaults when nothing is stored', async () => {
    const store = new LocalConfigStore(memConfigBackend());
    expect(await store.get()).toEqual({
      ollama: 'http://127.0.0.1:11434',
      lmstudio: 'http://127.0.0.1:1234',
    });
  });

  it('normalizes and persists valid localhost URLs', async () => {
    const backend = memConfigBackend();
    const store = new LocalConfigStore(backend);
    const next = await store.set({ ollama: 'http://localhost:9999/' });
    expect(next.ollama).toBe('http://localhost:9999');
    expect(JSON.parse(backend.state.raw!).ollama).toBe('http://localhost:9999');
    // lmstudio untouched
    expect(next.lmstudio).toBe('http://127.0.0.1:1234');
  });

  it('rejects remote / file URLs and persists nothing', async () => {
    const backend = memConfigBackend();
    const store = new LocalConfigStore(backend);
    await expect(store.set({ lmstudio: 'http://evil.com' })).rejects.toThrow();
    await expect(store.set({ ollama: 'file:///etc/hosts' })).rejects.toThrow();
    expect(backend.state.raw).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// LocalModelCache — instant snapshot, in-flight dedup, 500ms hard timeout
// ---------------------------------------------------------------------------
describe('LocalModelCache', () => {
  it('snapshot is empty before refresh and populated after', async () => {
    const cache = new LocalModelCache();
    const ollama = cacheFakeProvider('ollama', async () => [localModelRef('ollama', 'llama3')]);
    expect(cache.snapshot()).toEqual([]);
    await cache.refreshInBackground([ollama]);
    expect(cache.snapshot().map((m) => m.id)).toEqual(['llama3']);
  });

  it('isStale is true before any refresh and false right after', async () => {
    const cache = new LocalModelCache();
    expect(cache.isStale()).toBe(true);
    await cache.refreshInBackground([cacheFakeProvider('ollama', async () => [])]);
    expect(cache.isStale()).toBe(false);
  });

  it('dedups concurrent in-flight refreshes (joins, calls listModels once)', async () => {
    const cache = new LocalModelCache();
    const ollama = cacheFakeProvider('ollama', async () => [localModelRef('ollama', 'llama3')]);
    const a = cache.refreshInBackground([ollama]);
    const b = cache.refreshInBackground([ollama]);
    expect(a).toBe(b);
    await a;
    expect(ollama.listModels).toHaveBeenCalledTimes(1);
  });

  it('applies a 500ms hard timeout and converges to [] when a provider hangs', async () => {
    vi.useFakeTimers();
    try {
      const cache = new LocalModelCache();
      const ollama = cacheFakeProvider('ollama', () => new Promise<ModelRef[]>(() => {}));
      const p = cache.refreshInBackground([ollama]);
      await vi.advanceTimersByTimeAsync(500);
      await p;
      expect(cache.snapshot()).toEqual([]);
      expect(cache.lastError('ollama')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// local discovery 500ms timeout (provider level) — never-resolving fetch
// ---------------------------------------------------------------------------
describe('local fetch 500ms timeout', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('returns [] when the local server never responds (hard timeout aborts discovery)', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const ollama = new OllamaProvider(() => 'http://127.0.0.1:11434');
    const lmstudio = new LmStudioProvider(() => 'http://127.0.0.1:1234');
    const op = ollama.listModels();
    const lp = lmstudio.listModels();
    await vi.advanceTimersByTimeAsync(500);
    await expect(op).resolves.toEqual([]);
    await expect(lp).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Non-blocking discovery + zero-auth invariants
// ---------------------------------------------------------------------------
describe('ProviderRegistry local discovery is non-blocking', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('getAvailableModels returns cloud models while local discovery hangs', async () => {
    vi.useFakeTimers();
    const hang = () => new Promise<ModelRef[]>(() => {});
    const reg = new ProviderRegistry(fakeKeyStore(), {
      chatgpt: fakeProvider('chatgpt', true, () => {}, []),
      claude: fakeProvider('claude', true, () => {}),
      openrouter: fakeProvider('openrouter', true, () => {}),
      ollama: localFakeProvider('ollama', hang),
      lmstudio: localFakeProvider('lmstudio', hang),
    });
    const models = await reg.getAvailableModels(true);
    // Cloud catalog is present immediately…
    expect(models.some((m) => m.provider === 'claude')).toBe(true);
    expect(models.some((m) => m.provider === 'chatgpt')).toBe(true);
    expect(models.some((m) => m.provider === 'openrouter')).toBe(true);
    // …and local models are simply absent (cache snapshot still empty), not awaited.
    expect(models.some((m) => m.provider === 'ollama')).toBe(false);
    expect(models.some((m) => m.provider === 'lmstudio')).toBe(false);
    // Drain the hung background refresh so it times out cleanly.
    await vi.advanceTimersByTimeAsync(500);
  });

  it('merges the local cache snapshot, deduped by provider:id', async () => {
    const cache = new LocalModelCache();
    await cache.refreshInBackground([
      cacheFakeProvider('ollama', async () => [
        localModelRef('ollama', 'llama3'),
        localModelRef('ollama', 'llama3'),
      ]),
    ]);
    const reg = new ProviderRegistry(
      fakeKeyStore(),
      {
        chatgpt: fakeProvider('chatgpt', true, () => {}),
        claude: fakeProvider('claude', true, () => {}),
        openrouter: fakeProvider('openrouter', true, () => {}),
        ollama: localFakeProvider('ollama', async () => []),
      },
      cache,
    );
    const models = await reg.getAvailableModels();
    expect(models.filter((m) => m.provider === 'ollama').map((m) => m.id)).toEqual(['llama3']);
  });

  it('local providers report static connected auth without a network probe', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')));
    vi.stubGlobal('fetch', fetchSpy);
    const ollama = new OllamaProvider(() => 'http://127.0.0.1:11434');
    const lmstudio = new LmStudioProvider(() => 'http://127.0.0.1:1234');
    expect(await ollama.getAuthStatus()).toMatchObject({
      provider: 'ollama',
      authKind: 'local',
      connected: true,
      label: 'Ollama',
    });
    expect(await lmstudio.getAuthStatus()).toMatchObject({
      provider: 'lmstudio',
      authKind: 'local',
      connected: true,
      label: 'LM Studio',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('hasAnyAuth: offline local with no discovered models does not satisfy auth (and never probes the network)', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')));
    vi.stubGlobal('fetch', fetchSpy);
    const reg = new ProviderRegistry(fakeKeyStore(), {
      // every cloud provider disconnected
      chatgpt: fakeProvider('chatgpt', false, () => {}),
      claude: fakeProvider('claude', false, () => {}),
      openrouter: fakeProvider('openrouter', false, () => {}),
      ollama: new OllamaProvider(() => 'http://127.0.0.1:11434'),
      lmstudio: new LmStudioProvider(() => 'http://127.0.0.1:1234'),
    });
    // A real discovery probe fails (offline) → empty list, NOT an auth failure.
    expect(await (reg.getProvider('ollama') as AiProvider).listModels()).toEqual([]);
    // With no cloud auth AND no discovered local models, the app has nothing the
    // user can actually use, so hasAnyAuth is false (the renderer shows the sign-in
    // nudge instead of letting a chat fail). Local providers report a static
    // connected:true, but that alone must NOT spoof auth. Crucially, the auth path
    // still never probes the network — it only reads the local-model cache snapshot.
    const fetchCallsBeforeAuth = fetchSpy.mock.calls.length;
    expect(await reg.hasAnyAuth()).toBe(false);
    expect(fetchSpy.mock.calls.length).toBe(fetchCallsBeforeAuth); // no auth-time fetch
    // Local providers themselves still report a static connected status (discovery).
    const localStatuses = (await reg.getAuthStatuses()).filter((s) => s.authKind === 'local');
    expect(localStatuses.length).toBe(2);
    expect(localStatuses.every((s) => s.connected)).toBe(true);
  });

  it('hasAnyAuth stays true when cloud is connected even if the local server is offline', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')));
    vi.stubGlobal('fetch', fetchSpy);
    const reg = new ProviderRegistry(fakeKeyStore(), {
      chatgpt: fakeProvider('chatgpt', true, () => {}), // cloud connected
      ollama: new OllamaProvider(() => 'http://127.0.0.1:11434'),
      lmstudio: new LmStudioProvider(() => 'http://127.0.0.1:1234'),
    });
    // Cloud auth alone satisfies hasAnyAuth; a dead local server is irrelevant and
    // the auth path performs no network probe.
    const before = fetchSpy.mock.calls.length;
    expect(await reg.hasAnyAuth()).toBe(true);
    expect(fetchSpy.mock.calls.length).toBe(before);
  });

  it('setApiKey rejects local providers (run locally, no API key)', async () => {
    const reg = new ProviderRegistry(fakeKeyStore(), {
      ollama: localFakeProvider('ollama', async () => []),
      lmstudio: localFakeProvider('lmstudio', async () => []),
    });
    await expect(reg.setApiKey('ollama', 'x')).rejects.toThrow(/do not use an API key/);
    await expect(reg.setApiKey('lmstudio', 'x')).rejects.toThrow(/do not use an API key/);
  });

  it('streamProviderChat surfaces a NETWORK error (not auth) for an offline local server', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))));
    const reg = new ProviderRegistry(fakeKeyStore(), {
      ollama: new OllamaProvider(() => 'http://127.0.0.1:11434'),
    });
    const events: AiChatEvent[] = [];
    await reg.streamProviderChat(baseReq('ollama', 'llama3'), (e) => events.push(e));
    expect(events.some((e) => e.kind === 'error' && (e as { errorKind?: string }).errorKind === 'auth')).toBe(false);
    expect(events.at(-1)).toMatchObject({ kind: 'error', errorKind: 'network' });
  });
});

// ---------------------------------------------------------------------------
// Ollama provider — /api/tags + /api/show discovery, /api/chat NDJSON streaming
// ---------------------------------------------------------------------------
describe('Ollama NDJSON parsing (pure)', () => {
  it('extracts message.content deltas', () => {
    expect(extractOllamaChatDelta(JSON.stringify({ message: { content: '안녕' } }))).toBe('안녕');
    expect(extractOllamaChatDelta(JSON.stringify({ message: {} }))).toBe('');
    expect(extractOllamaChatDelta('not json')).toBe('');
  });
  it('detects done and error lines', () => {
    expect(isOllamaChatDone(JSON.stringify({ done: true }))).toBe(true);
    expect(isOllamaChatDone(JSON.stringify({ done: false }))).toBe(false);
    expect(isOllamaChatDone('not json')).toBe(false);
    expect(ollamaChatErrorMessage(JSON.stringify({ error: 'model not found' }))).toBe('model not found');
    expect(ollamaChatErrorMessage(JSON.stringify({ message: { content: 'x' } }))).toBeNull();
  });
  it('extracts a context length from /api/show model_info', () => {
    expect(extractOllamaContextLength({ model_info: { 'llama.context_length': 8192 } })).toBe(8192);
    expect(extractOllamaContextLength({ model_info: { 'llama.context_length': 0 } })).toBeUndefined();
    expect(extractOllamaContextLength({})).toBeUndefined();
    expect(extractOllamaContextLength(null)).toBeUndefined();
  });
});

describe('OllamaProvider (mocked fetch)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lists /api/tags models and enriches context window from /api/show', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { body?: string }) => {
        if (url.endsWith('/api/tags')) {
          return jsonResponse({ models: [{ name: 'llama3:8b' }, { name: 'qwen2' }] });
        }
        if (url.endsWith('/api/show')) {
          const name = JSON.parse(init!.body!).name;
          const ctx = name === 'llama3:8b' ? 8192 : 0;
          return jsonResponse({ model_info: { 'llama.context_length': ctx } });
        }
        return new Response('not found', { status: 404 });
      }),
    );
    const provider = new OllamaProvider(() => 'http://127.0.0.1:11434');
    const models = await provider.listModels();
    expect(models.map((m) => m.id)).toEqual(['llama3:8b', 'qwen2']);
    expect(models.every((m) => m.provider === 'ollama' && m.requiresAuth === false)).toBe(true);
    expect(models.find((m) => m.id === 'llama3:8b')?.contextWindow).toBe(8192);
    expect(models.find((m) => m.id === 'qwen2')?.contextWindow).toBeUndefined();
  });

  it('returns [] when /api/tags fails (server offline), without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))));
    const provider = new OllamaProvider(() => 'http://127.0.0.1:11434');
    await expect(provider.listModels()).resolves.toEqual([]);
  });

  it('streams NDJSON deltas and finishes on done:true', async () => {
    const lines = [
      JSON.stringify({ message: { role: 'assistant', content: '안' }, done: false }) + '\n',
      JSON.stringify({ message: { role: 'assistant', content: '녕' }, done: false }) + '\n',
      JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }) + '\n',
    ];
    vi.stubGlobal('fetch', vi.fn(async () => streamingResponse(lines)));
    const provider = new OllamaProvider(() => 'http://127.0.0.1:11434');
    const events: AiChatEvent[] = [];
    await provider.streamChat(baseReq('ollama', 'llama3'), (e) => events.push(e));
    const deltas = events.filter((e) => e.kind === 'delta').map((e) => (e as { text: string }).text);
    expect(deltas.join('')).toBe('안녕');
    expect((events.find((e) => e.kind === 'done') as { text: string } | undefined)?.text).toBe('안녕');
  });

  it('surfaces an in-stream NDJSON error as a provider error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => streamingResponse([JSON.stringify({ error: 'model not found' }) + '\n'])),
    );
    const provider = new OllamaProvider(() => 'http://127.0.0.1:11434');
    const events: AiChatEvent[] = [];
    await provider.streamChat(baseReq('ollama', 'nope'), (e) => events.push(e));
    expect(events[0]).toMatchObject({ kind: 'error', errorKind: 'provider' });
    expect((events[0] as { message: string }).message).toContain('model not found');
  });
});

// ---------------------------------------------------------------------------
// LM Studio provider — /v1/models discovery, OpenAI-compatible SSE streaming
// ---------------------------------------------------------------------------
describe('LmStudioProvider (mocked fetch)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lists loaded /v1/models', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ data: [{ id: 'qwen2.5-7b-instruct' }, { id: 'llama-3.1-8b' }] })),
    );
    const provider = new LmStudioProvider(() => 'http://127.0.0.1:1234');
    const models = await provider.listModels();
    expect(models.map((m) => m.id)).toEqual(['qwen2.5-7b-instruct', 'llama-3.1-8b']);
    expect(models.every((m) => m.provider === 'lmstudio' && m.requiresAuth === false)).toBe(true);
  });

  it('returns [] when /v1/models fails (server offline)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))));
    const provider = new LmStudioProvider(() => 'http://127.0.0.1:1234');
    await expect(provider.listModels()).resolves.toEqual([]);
  });

  it('streams OpenAI-compatible SSE deltas and finishes on [DONE]', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        streamingResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'He' } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'llo' } }] })}\n\n`,
          'data: [DONE]\n\n',
        ]),
      ),
    );
    const provider = new LmStudioProvider(() => 'http://127.0.0.1:1234');
    const events: AiChatEvent[] = [];
    await provider.streamChat(baseReq('lmstudio', 'qwen2.5'), (e) => events.push(e));
    const deltas = events.filter((e) => e.kind === 'delta').map((e) => (e as { text: string }).text);
    expect(deltas.join('')).toBe('Hello');
  });

  it('surfaces a classified network error when the server is offline', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))));
    const provider = new LmStudioProvider(() => 'http://127.0.0.1:1234');
    const events: AiChatEvent[] = [];
    await provider.streamChat(baseReq('lmstudio', 'qwen2.5'), (e) => events.push(e));
    expect(events[0]).toMatchObject({ kind: 'error', errorKind: 'network' });
  });
});
