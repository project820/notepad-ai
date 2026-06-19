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

export type ProviderMap = Record<AiProviderId, AiProvider>;

export class ProviderRegistry {
  constructor(
    private keys: ApiKeyStore,
    private providers: ProviderMap,
  ) {}

  getProvider(id: AiProviderId): AiProvider {
    return this.providers[id];
  }

  async getAuthStatuses(): Promise<ProviderAuthStatus[]> {
    return Promise.all(Object.values(this.providers).map((p) => p.getAuthStatus()));
  }

  async hasAnyAuth(): Promise<boolean> {
    const statuses = await this.getAuthStatuses();
    return statuses.some((s) => s.connected);
  }

  /**
   * Curated catalog merged with live ChatGPT models (deduped). Each entry keeps
   * its provider identity and humanize engine id.
   */
  async getAvailableModels(): Promise<ModelRef[]> {
    const curated = getCuratedModels();
    let live: ModelRef[] = [];
    try {
      live = await this.providers.chatgpt.listModels();
    } catch {
      live = [];
    }
    const seen = new Set(curated.map((m) => `${m.provider}:${m.id}`));
    const merged = [...curated];
    for (const m of live) {
      const key = `${m.provider}:${m.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(m);
      }
    }
    return merged;
  }

  async setApiKey(provider: AiProviderId, key: string): Promise<{ persisted: boolean }> {
    if (provider === 'chatgpt') {
      throw new AiProviderError('provider', 'ChatGPT uses sign-in, not an API key.');
    }
    return this.keys.setApiKey(provider, key);
  }

  async deleteApiKey(provider: AiProviderId): Promise<void> {
    await this.keys.deleteApiKey(provider);
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
    const status = await provider.getAuthStatus();
    if (!status.connected) {
      onEvent({
        kind: 'error',
        message: `${status.label} is not connected. Open AI settings to sign in or add a key.`,
        errorKind: 'auth',
      });
      return;
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

/** Build the production provider map. Lazy-requires the Electron-bound ChatGPT adapter. */
export function buildDefaultProviders(keys: ApiKeyStore): ProviderMap {
  const { ChatGptProvider } = require('./chatgpt-provider') as typeof import('./chatgpt-provider');
  return {
    chatgpt: new ChatGptProvider(),
    claude: new ClaudeProvider(keys),
    openrouter: new OpenRouterProvider(keys),
  };
}

let singleton: ProviderRegistry | null = null;

export function getRegistry(): ProviderRegistry {
  if (!singleton) {
    const keys = new ApiKeyStore(createElectronKeyBackend());
    singleton = new ProviderRegistry(keys, buildDefaultProviders(keys));
  }
  return singleton;
}
