import { describe, it, expect } from 'vitest';
import { ProviderRegistry, type ProviderMap } from '../main/ai/provider-registry';
import type { AiProvider, AiProviderId, AuthKind, ModelRef, ProviderAuthStatus } from '../main/ai/types';
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
