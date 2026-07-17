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
import type { ChatGptProvider } from './chatgpt-provider';
import { atomicWrite, nodeAtomicBackend } from '../atomic-write';
import { ComposedClaudeProvider } from './claude-composed';
import { ComposedGrokProvider } from './grok-composed';
import { nodeCliSpawn } from './cli-runner';
import { OpenRouterProvider } from './openrouter-provider';
import { applyModelDisplayPolicy } from './model-display-policy';
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
import { supportsVision } from './vision-capabilities';
import { runOcr, type OcrRunner } from './ocr';
import {
  sanitizeReasoning,
  type ReasoningCapabilitiesSnapshot,
  type ReasoningCapabilityContext,
} from './reasoning-capabilities';

import { isProviderAuthAttemptable } from '../../shared/provider-auth-status';

/** Bound cloud live-catalog wait on the HTML inventory path (local entry must not stall). */
const HTML_CLOUD_INVENTORY_TIMEOUT_MS = 1_500;
export type ProviderMap = Partial<Record<AiProviderId, AiProvider>>;


export class ProviderRegistry {
  constructor(
    private keys: ApiKeyStore,
    private providers: ProviderMap,
    private localCache: LocalModelCache = new LocalModelCache(),
    private localConfig?: LocalConfigStore,
    /** OCR runner for the non-vision image fallback (injectable for tests). */
    private ocr: OcrRunner = runOcr,
    /** Explicit capability seam for focused transport tests. Production leaves this unset. */
    private reasoningContextOverride?: ReasoningCapabilityContext,
  ) {}
  private reasoningSnapshotGeneration = 0;
  private reasoningAccountFingerprint = '';
  /**
   * Single-flight guard for live cloud listModels on the HTML path. Held until
   * the cloud promise settles (not merely until the caller-facing race returns)
   * so repeated wizard opens cannot stack unbounded cloud catalog calls.
   */
  private htmlCloudInventoryInFlight: Promise<ModelRef[]> | null = null;

  private bumpReasoningSnapshot(): void {
    this.reasoningSnapshotGeneration++;
  }

  private reasoningContext(): ReasoningCapabilityContext {
    return this.reasoningContextOverride ?? {
      featureEnabled: false,
      accountAvailableModels: new Set(),
      transportVerifiedEffortsByModel: {},
      snapshotGeneration: this.reasoningSnapshotGeneration,
    };
  }

  async getReasoningCapabilities(): Promise<ReasoningCapabilitiesSnapshot> {
    const chatgpt = this.providers.chatgpt;
    let accountModels: string[] = [];
    let accountFingerprint = 'signed-out';

    if (chatgpt) {
      try {
        const status = await chatgpt.getAuthStatus();
        accountFingerprint = `${status.connected}:${status.accountLabel ?? ''}`;
        if (status.connected) {
          accountModels = (await chatgpt.listAccountModels?.() ?? []).map((model) => model.id).sort();
          accountFingerprint += `:${accountModels.join('\u0000')}`;
        }
      } catch {
        accountFingerprint = 'unavailable';
      }
    }

    if (accountFingerprint !== this.reasoningAccountFingerprint) {
      this.reasoningAccountFingerprint = accountFingerprint;
      this.bumpReasoningSnapshot();
    }

    return {
      featureEnabled: false,
      snapshotGeneration: this.reasoningSnapshotGeneration,
      models: [],
      accountModels,
    };
  }

  /** Local (Ollama / LM Studio) providers currently registered. */
  private localProviders(): AiProvider[] {
    return Object.values(this.providers).filter(
      (p): p is AiProvider => p != null && p.authKind === 'local',
    );
  }

  getProvider(id: AiProviderId): AiProvider | undefined {
    return this.providers[id];
  }
  /** Records a locally observed subscription CLI result without changing API-key state. */
  recordCliAuthResult(provider: 'claude' | 'grok', state: 'succeeded' | 'unknown' | 'auth_failed'): void {
    const target = this.providers[provider] as { recordCliAuthResult?: (next: 'succeeded' | 'unknown' | 'auth_failed') => void } | undefined;
    target?.recordCliAuthResult?.(state);
  }

  async getAuthStatuses(): Promise<ProviderAuthStatus[]> {
    const providers = Object.values(this.providers).filter((p): p is AiProvider => p != null);
    return Promise.all(providers.map((p) => p.getAuthStatus()));
  }

  async hasGrokApiKey(): Promise<boolean> {
    return (await this.keys.getKeyStatus('grok')).connected;
  }

  async hasAnyAuth(): Promise<boolean> {
    const statuses = await this.getAuthStatuses();
    // A cloud provider reporting connected or an installed CLI with unverified auth may be usable.
    if (statuses.some((s) => s.authKind !== 'local' && isProviderAuthAttemptable(s))) return true;
    // Local providers always report `connected: true` (discovery, not auth), so
    // they must NOT alone satisfy "has auth" — only count them when the server is
    // actually up AND has discovered models (mirrors the renderer's zero-auth notice).
    return this.localCache.snapshot().length > 0;
  }
  private async routeAwareCuratedModels(): Promise<ModelRef[]> {
    const grokApiConnected = this.providers.grok !== undefined && await this.hasGrokApiKey();
    return applyModelDisplayPolicy(getCuratedModels()).filter(
      (model) => model.provider !== 'grok'
        || model.id !== 'grok-composer-2.5-fast'
        || grokApiConnected,
    );
  }
  /**
   * Curated catalog merged with every registered cloud provider's model list and
   * the local model-cache snapshot (deduped by `provider:id`). Local discovery is
   * NEVER awaited here, so an offline local server cannot block cloud pickers.
   */
  async getAvailableModels(force = false): Promise<ModelRef[]> {
    if (force) this.bumpReasoningSnapshot();
    const cloudProviders = Object.values(this.providers).filter(
      (provider): provider is AiProvider => provider != null && provider.authKind !== 'local',
    );
    const live = (
      await Promise.all(cloudProviders.map(async (provider) => {
        try {
          return applyModelDisplayPolicy(await provider.listModels());
        } catch {
          return [] as ModelRef[];
        }
      }))
    ).flat();
    const curated = await this.routeAwareCuratedModels();
    const locals = this.localProviders();
    if (locals.length > 0 && (force || this.localCache.isStale())) {
      // Fire-and-forget: must not block the cloud model list.
      void this.localCache.refreshInBackground(locals);
    }
    const localModels = applyModelDisplayPolicy(this.localCache.snapshot());
    const seen = new Set<string>();
    const merged: ModelRef[] = [];
    for (const model of [...curated, ...live, ...localModels]) {
      const key = `${model.provider}:${model.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(model);
    }
    return merged;
  }

  /**
   * HTML export inventory keeps the cloud display policy while preserving raw
   * discovered local models. HTML has its own allowlist and must be able to
   * inspect LM Studio models that chat intentionally hides.
   *
   * Unlike chat inventory, forced/stale HTML discovery is awaited: the renderer
   * uses the returned local providers as capability evidence, so a fire-and-forget
   * empty snapshot would falsely route the wizard to "no usable local model".
   * Discovery stays hard-bounded by LocalModelCache (500ms timeout per provider).
   *
   * Local refresh is started before cloud inventory and awaited first. Cloud
   * listModels is bounded for the caller and single-flighted until settlement so
   * a hanging ChatGPT/live catalog cannot block HTML entry or be re-spawned on
   * every wizard open (curated cloud IDs remain available either way).
   */
  async getAvailableModelsForHtmlExport(force = false): Promise<ModelRef[]> {
    if (force) this.bumpReasoningSnapshot();
    const cloudProviders = Object.values(this.providers).filter(
      (provider): provider is AiProvider => provider != null && provider.authKind !== 'local',
    );
    const locals = this.localProviders();
    // Start bounded local discovery BEFORE cloud inventory work.
    const localRefresh =
      locals.length > 0 && (force || this.localCache.isStale())
        ? this.localCache.refreshInBackground(locals)
        : Promise.resolve();
    // Single-flight cloud inventory for the lifetime of the live promise.
    let livePromise = this.htmlCloudInventoryInFlight;
    if (!livePromise) {
      livePromise = Promise.all(
        cloudProviders.map(async (provider) => {
          try {
            return applyModelDisplayPolicy(await provider.listModels());
          } catch {
            return [] as ModelRef[];
          }
        }),
      )
        .then((batches) => batches.flat())
        .finally(() => {
          this.htmlCloudInventoryInFlight = null;
        });
      this.htmlCloudInventoryInFlight = livePromise;
    }
    await localRefresh;
    // Bound cloud wait so local-only entry is not starved by a slow live catalog.
    const live = await Promise.race([
      livePromise,
      new Promise<ModelRef[]>((resolve) => {
        setTimeout(() => resolve([]), HTML_CLOUD_INVENTORY_TIMEOUT_MS);
      }),
    ]);
    const curated = await this.routeAwareCuratedModels();
    const seen = new Set<string>();
    const merged: ModelRef[] = [];
    for (const model of [...curated, ...live, ...this.localCache.snapshot()]) {
      const key = `${model.provider}:${model.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(model);
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
      if (!isProviderAuthAttemptable(status)) {
        onEvent({
          kind: 'error',
          // CLI providers carry actionable install/login guidance in status.error;
          // prefer it over the generic sign-in/key message (G006).
          message: status.error
            ?? (status.errorCode === 'grok_cli_setup_required'
              ? 'Grok CLI is unavailable. Install it and run `grok login` in a terminal.'
              : `${status.label} is not connected. Open AI settings to sign in or add a key.`),
          errorKind: 'auth',
        });
        return;
      }
    }
    // Multimodal fallback (D2): a vision-capable model receives images directly;
    // anything else (local models, unverified custom, ChatGPT) gets the images
    // OCR'd to text here so the request still works. OCR failure is surfaced, not
    // silently dropped.
    let outgoing = req;
    if (req.images && req.images.length > 0 && !supportsVision(req.model.provider, req.model.id)) {
      try {
        const ocrText = await this.ocr(req.images, req.signal);
        const note = ocrText.trim()
          ? `\n\n[Image OCR context]\n${ocrText.trim()}`
          : '\n\n[Image OCR context]\n(no text recognized in the attached image)';
        outgoing = { ...req, userText: `${req.userText}${note}`, images: undefined };
      } catch (err) {
        onEvent({
          kind: 'error',
          message: `Could not read the attached image (OCR failed): ${err instanceof Error ? err.message : String(err)}`,
          errorKind: 'provider',
        });
        return;
      }
    }
    outgoing = sanitizeReasoning(outgoing, this.reasoningContext());
    await provider.streamChat(outgoing, onEvent);
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
      await atomicWrite(filePath(), buf, { backend: nodeAtomicBackend(), mode: 0o600 });
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
function buildDefaultProviders(keys: ApiKeyStore, localConfig?: LocalConfigStore): ProviderMap {
  type ChatGptProviderConstructor = new () => ChatGptProvider;
  const { ChatGptProvider } = require('./chatgpt-provider') as { ChatGptProvider: ChatGptProviderConstructor };
  const getOllamaBaseUrl = async () => (await localConfig?.get())?.ollama ?? DEFAULT_OLLAMA_BASE_URL;
  const getLmStudioBaseUrl = async () => (await localConfig?.get())?.lmstudio ?? DEFAULT_LMSTUDIO_BASE_URL;
  const cliSpawn = nodeCliSpawn();
  return {
    chatgpt: new ChatGptProvider(),
    // Claude routes CLI-first (claude -p) with Anthropic API fallback (G006).
    claude: new ComposedClaudeProvider(keys, cliSpawn),
    openrouter: new OpenRouterProvider(keys),
    ollama: new OllamaProvider(getOllamaBaseUrl),
    lmstudio: new LmStudioProvider(getLmStudioBaseUrl),
    // Grok uses xAI's API when a key is saved, otherwise the local CLI.
    grok: new ComposedGrokProvider(keys, cliSpawn),
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
