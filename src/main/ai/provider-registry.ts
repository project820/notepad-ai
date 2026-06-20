/**
 * Provider registry — the single routing surface for AI auth, models, and chat.
 *
 * Routing rule (locked): a chat request goes ONLY to its selected provider.
 * There is never a silent fallback to a different provider — an unauthenticated
 * or failing provider surfaces an actionable error instead.
 *
 * The registry is dependency-injected with its providers so routing/gating is
 * unit-testable without Electron. Only the ChatGPT adapter transitively pulls
 * in Electron, so the default factory lazy-requires it.
 */

import { ApiKeyStore, type KeyStoreBackend } from './api-key-store';
import { ClaudeProvider } from './claude-provider';
import { OpenRouterProvider } from './openrouter-provider';
import { getCuratedModels } from './model-catalog';
import { LmStudioProvider } from './lmstudio-provider';
import { OllamaProvider } from './ollama-provider';
import { LocalModelCache } from './local-model-cache';
import {
  DEFAULT_LMSTUDIO_BASE_URL,
  DEFAULT_OLLAMA_BASE_URL,
  LocalConfigStore,
  createElectronLocalConfigBackend,
  defaultLocalConfig,
  type LocalProviderConfig,
} from './local-config';
import {
  AiProviderError,
  isAiProviderId,
  type AiChatEvent,
  type AiChatRequest,
  type AiProvider,
  type AiProviderId,
  type ModelRef,
  type ProviderAuthStatus,
} from './types';

export type ProviderMap = Partial<Record<AiProviderId, AiProvider>>;

export class ProviderRegistry {
  constructor(
    private keys: ApiKeyStore,
    private providers: ProviderMap,
    private localCache: LocalModelCache = new LocalModelCache(),
    private localConfig?: LocalConfigStore,
  ) {}

  /** Local (Ollama / LM Studio) providers currently registered. */
  private localProviders(): AiProvider[] {
    return Object.values(this.providers).filter(
      (p): p is AiProvider => p != null && p.authKind === 'local',
    );
  }

  getProvider(id: AiProviderId): AiProvider | undefined {
    return this.providers[id];
  }

  async getAuthStatuses(): Promise<ProviderAuthStatus[]> {
    const providers = Object.values(this.providers).filter((p): p is AiProvider => p != null);
    return Promise.all(providers.map((p) => p.getAuthStatus()));
  }

  async hasAnyAuth(): Promise<boolean> {
    const statuses = await this.getAuthStatuses();
    // A cloud provider (oauth/api_key) reporting connected means usable.
    if (statuses.some((s) => s.connected && s.authKind !== 'local')) return true;
    // Local providers always report `connected: true` (discovery, not auth), so
    // they must NOT alone satisfy "has auth" — only count them when the server is
    // actually up AND has discovered models (mirrors the renderer's zero-auth notice).
    return this.localCache.snapshot().length > 0;
  }

  /**
   * Curated catalog merged with live ChatGPT models and the local model cache
   * SNAPSHOT (deduped by `provider:id`). Local discovery is NEVER awaited here:
   * we merge only the current cache snapshot and kick a background refresh when
   * the cache is stale or `force` is set — so a slow/offline local server can
   * never block the cloud picker.
   */
  async getAvailableModels(force = false): Promise<ModelRef[]> {
    const curated = getCuratedModels();
    let live: ModelRef[] = [];
    try {
      live = (await this.providers.chatgpt?.listModels()) ?? [];
    } catch {
      live = [];
    }
    const locals = this.localProviders();
    if (locals.length > 0 && (force || this.localCache.isStale())) {
      // Fire-and-forget: must not block the cloud model list.
      void this.localCache.refreshInBackground(locals);
    }
    const localModels = this.localCache.snapshot();
    const seen = new Set<string>();
    const merged: ModelRef[] = [];
    for (const m of [...curated, ...live, ...localModels]) {
      const key = `${m.provider}:${m.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(m);
    }
    return merged;
  }

  async setApiKey(provider: AiProviderId, key: string): Promise<{ persisted: boolean }> {
    if (provider === 'chatgpt') {
      throw new AiProviderError('provider', 'ChatGPT uses sign-in, not an API key.');
    }
    if (provider === 'ollama' || provider === 'lmstudio') {
      throw new AiProviderError(
        'provider',
        'Local providers run on your machine and do not use an API key. Set the server URL in AI settings.',
      );
    }
    return this.keys.setApiKey(provider, key);
  }

  async deleteApiKey(provider: AiProviderId): Promise<void> {
    await this.keys.deleteApiKey(provider);
  }

  /** Current local provider base URLs. */
  async getLocalConfig(): Promise<LocalProviderConfig> {
    if (!this.localConfig) return defaultLocalConfig();
    return this.localConfig.get();
  }

  /**
   * Update local provider base URLs (validated to localhost http(s)). Kicks a
   * background model-cache refresh so the new endpoint is reflected on the next
   * picker call.
   */
  async setLocalConfig(partial: Partial<LocalProviderConfig>): Promise<LocalProviderConfig> {
    if (!this.localConfig) {
      throw new AiProviderError('provider', 'Local provider configuration is unavailable.');
    }
    const next = await this.localConfig.set(partial);
    const locals = this.localProviders();
    if (locals.length > 0) void this.localCache.refreshInBackground(locals);
    return next;
  }

  /**
   * Route a chat request to its selected provider. Validates auth first so a
   * disconnected provider yields an actionable error rather than a raw failure.
   * Never falls back to a different provider.
   */
  async streamProviderChat(req: AiChatRequest, onEvent: (e: AiChatEvent) => void): Promise<void> {
    if (!isAiProviderId(req.model.provider)) {
      onEvent({
        kind: 'error',
        message: `Unknown provider "${String(req.model.provider)}". Pick a model in AI settings.`,
        errorKind: 'provider',
      });
      return;
    }
    const provider = this.providers[req.model.provider];
    if (!provider) {
      onEvent({
        kind: 'error',
        message: `${req.model.provider} is not available yet. Pick another model in AI settings.`,
        errorKind: 'provider',
      });
      return;
    }
    // Local providers are discovery, not auth: skip the auth gate entirely so a
    // local server being offline surfaces as a network error from streamChat(),
    // not as a misleading auth error.
    if (provider.authKind !== 'local') {
      const status = await provider.getAuthStatus();
      if (!status.connected) {
        onEvent({
          kind: 'error',
          message: `${status.label} is not connected. Open AI settings to sign in or add a key.`,
          errorKind: 'auth',
        });
        return;
      }
    }
    await provider.streamChat(req, onEvent);
  }
}

// --------------------------------------------------------------------------
// Electron-bound singleton
// --------------------------------------------------------------------------

function createElectronKeyBackend(): KeyStoreBackend {
  const { app, safeStorage } = require('electron') as typeof import('electron');
  const { promises: fs } = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const filePath = () => path.join(app.getPath('userData'), 'ai-api-keys.bin');
  return {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (plain) => safeStorage.encryptString(plain),
    decryptString: (buf) => safeStorage.decryptString(buf),
    readFile: async () => {
      try {
        return await fs.readFile(filePath());
      } catch {
        return null;
      }
    },
    writeFile: async (buf) => {
      await fs.mkdir(path.dirname(filePath()), { recursive: true });
      await fs.writeFile(filePath(), buf);
    },
    removeFile: async () => {
      try {
        await fs.unlink(filePath());
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * Build the production provider map. Lazy-requires the Electron-bound ChatGPT
 * adapter. Local providers read their base URL lazily from `localConfig` so a
 * settings change takes effect on the next discovery without a rebuild.
 */
export function buildDefaultProviders(keys: ApiKeyStore, localConfig?: LocalConfigStore): ProviderMap {
  const { ChatGptProvider } = require('./chatgpt-provider') as typeof import('./chatgpt-provider');
  const getOllamaBaseUrl = async () => (await localConfig?.get())?.ollama ?? DEFAULT_OLLAMA_BASE_URL;
  const getLmStudioBaseUrl = async () => (await localConfig?.get())?.lmstudio ?? DEFAULT_LMSTUDIO_BASE_URL;
  return {
    chatgpt: new ChatGptProvider(),
    claude: new ClaudeProvider(keys),
    openrouter: new OpenRouterProvider(keys),
    ollama: new OllamaProvider(getOllamaBaseUrl),
    lmstudio: new LmStudioProvider(getLmStudioBaseUrl),
  };
}

let singleton: ProviderRegistry | null = null;

export function getRegistry(): ProviderRegistry {
  if (!singleton) {
    const keys = new ApiKeyStore(createElectronKeyBackend());
    const localConfig = new LocalConfigStore(createElectronLocalConfigBackend());
    const localCache = new LocalModelCache();
    singleton = new ProviderRegistry(keys, buildDefaultProviders(keys, localConfig), localCache, localConfig);
  }
  return singleton;
}
