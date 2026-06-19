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
  it('accepts the three provider ids and rejects others', () => {
    expect(isAiProviderId('chatgpt')).toBe(true);
    expect(isAiProviderId('claude')).toBe(true);
    expect(isAiProviderId('openrouter')).toBe(true);
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
    expect(isKnownModel(catalog, 'claude', 'claude-sonnet-4-5')).toBe(true);
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
