import { describe, it, expect } from 'vitest';
import { ProviderRegistry, type ProviderMap } from '../main/ai/provider-registry';
import type { AiChatEvent, AiChatRequest, AiProvider, AiProviderId, AuthKind, ModelRef, ProviderAuthStatus } from '../main/ai/types';
import type { LocalModelCache } from '../main/ai/local-model-cache';
import type { ApiKeyStore } from '../main/ai/api-key-store';

/** Minimal provider stub — only getAuthStatus matters for hasAnyAuth. */
function provider(id: AiProviderId, authKind: AuthKind, connected: boolean): AiProvider {
  return {
    id,
    authKind,
    async getAuthStatus(): Promise<ProviderAuthStatus> {
      return { provider: id, authKind, connected, label: id };
    },
    async listModels() {
      return [];
    },
    async *streamChat() {
      /* unused */
    },
  } as unknown as AiProvider;
}

/** Fake local-model cache returning a fixed snapshot. */
function cacheWith(models: ModelRef[]): LocalModelCache {
  return {
    snapshot: () => models,
    isStale: () => false,
    refreshInBackground: async () => {},
  } as unknown as LocalModelCache;
}

const noKeys = {} as unknown as ApiKeyStore;
const localModel: ModelRef = { provider: 'ollama', id: 'llama3', label: 'llama3' } as ModelRef;

describe('ProviderRegistry.hasAnyAuth — local is discovery, not auth', () => {
  it('is true when a cloud provider is connected', async () => {
    const map: ProviderMap = {
      chatgpt: provider('chatgpt', 'oauth', true),
      ollama: provider('ollama', 'local', true),
    };
    const reg = new ProviderRegistry(noKeys, map, cacheWith([]));
    expect(await reg.hasAnyAuth()).toBe(true);
  });

  it('is FALSE when only local providers are present but they have no discovered models (offline)', async () => {
    // Local providers statically report connected:true; without models they must
    // NOT satisfy hasAnyAuth, so the user still gets the sign-in nudge.
    const map: ProviderMap = {
      chatgpt: provider('chatgpt', 'oauth', false),
      ollama: provider('ollama', 'local', true),
      lmstudio: provider('lmstudio', 'local', true),
    };
    const reg = new ProviderRegistry(noKeys, map, cacheWith([]));
    expect(await reg.hasAnyAuth()).toBe(false);
  });

  it('is true when a local server is up WITH discovered models, even with no cloud auth', async () => {
    const map: ProviderMap = {
      chatgpt: provider('chatgpt', 'oauth', false),
      ollama: provider('ollama', 'local', true),
    };
    const reg = new ProviderRegistry(noKeys, map, cacheWith([localModel]));
    expect(await reg.hasAnyAuth()).toBe(true);
  });

  it('is false when nothing is connected and no local models exist', async () => {
    const map: ProviderMap = {
      chatgpt: provider('chatgpt', 'oauth', false),
      claude: provider('claude', 'api_key', false),
    };
    const reg = new ProviderRegistry(noKeys, map, cacheWith([]));
    expect(await reg.hasAnyAuth()).toBe(false);
  });
});
function grokProvider(
  status: ProviderAuthStatus,
  onStream: (req: AiChatRequest, onEvent: (e: AiChatEvent) => void) => void = () => {},
): AiProvider & { streamCalls: number } {
  const result: AiProvider & { streamCalls: number } = {
    id: 'grok',
    authKind: 'cli',
    streamCalls: 0,
    async getAuthStatus() {
      return status;
    },
    async listModels() {
      return [];
    },
    async streamChat(req, onEvent) {
      result.streamCalls++;
      onStream(req, onEvent);
    },
  };
  return result;
}

const grokRequest: AiChatRequest = {
  instructions: 'system',
  history: [],
  userText: 'hello',
  model: { provider: 'grok', id: 'grok' },
};

describe('ProviderRegistry — Grok CLI readiness', () => {
  it('blocks a missing CLI with setup guidance without invoking streamChat', async () => {
    const grok = grokProvider({
      provider: 'grok',
      authKind: 'cli',
      connected: false,
      label: 'Grok (CLI)',
      installed: false,
      errorCode: 'grok_cli_setup_required',
    });
    const events: AiChatEvent[] = [];

    await new ProviderRegistry(noKeys, { grok }, cacheWith([])).streamProviderChat(grokRequest, (event) => events.push(event));

    expect(grok.streamCalls).toBe(0);
    expect(events).toEqual([{
      kind: 'error',
      message: 'Grok CLI is unavailable. Install it and run `grok login` in a terminal.',
      errorKind: 'auth',
    }]);
  });

  it('attempts an installed CLI with unverified auth and preserves its command failure', async () => {
    const commandFailure: AiChatEvent = {
      kind: 'error',
      message: 'Grok CLI: sign in required',
      errorKind: 'auth',
    };
    const grok = grokProvider({
      provider: 'grok',
      authKind: 'cli',
      connected: false,
      authUnverified: true,
      label: 'Grok (CLI)',
      installed: true,
      errorCode: 'grok_cli_auth_unknown',
    }, (_req, onEvent) => onEvent(commandFailure));
    const events: AiChatEvent[] = [];

    await new ProviderRegistry(noKeys, { grok }, cacheWith([])).streamProviderChat(grokRequest, (event) => events.push(event));

    expect(grok.streamCalls).toBe(1);
    expect(events).toEqual([commandFailure]);
  });

  it('counts only an installed, unverified Grok CLI as usable auth', async () => {
    const installed = grokProvider({
      provider: 'grok',
      authKind: 'cli',
      connected: false,
      authUnverified: true,
      label: 'Grok (CLI)',
      installed: true,
      errorCode: 'grok_cli_auth_unknown',
    });
    const missing = grokProvider({
      provider: 'grok',
      authKind: 'cli',
      connected: false,
      label: 'Grok (CLI)',
      installed: false,
      errorCode: 'grok_cli_setup_required',
    });

    await expect(new ProviderRegistry(noKeys, { grok: installed }, cacheWith([])).hasAnyAuth()).resolves.toBe(true);
    await expect(new ProviderRegistry(noKeys, { grok: missing }, cacheWith([])).hasAnyAuth()).resolves.toBe(false);
  });
});
