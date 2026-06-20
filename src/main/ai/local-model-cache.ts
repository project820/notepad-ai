/**
 * Background cache of locally-discovered models (Ollama / LM Studio).
 *
 * The cache is the seam that keeps local discovery OFF the `getAvailableModels()`
 * return path. The registry merges `snapshot()` (instant, synchronous) and kicks
 * `refreshInBackground()` (never awaited) — so a slow/offline local server can
 * never block the cloud model picker.
 *
 * Policy (locked by ralplan consensus):
 *  - `snapshot()` returns whatever is currently cached, immediately.
 *  - `refreshInBackground()` dedups concurrent refreshes (in-flight join).
 *  - Each provider's discovery runs under a 500ms HARD timeout.
 *  - A provider that fails (offline / network error / timeout) has its model
 *    list set to `[]` and its `lastError` retained for a non-auth settings hint.
 *    Offline is modeled as "no local models", never as an auth failure.
 */

import { LOCAL_DISCOVERY_TIMEOUT_MS, withLocalTimeout } from './local-config';
import type { AiProvider, AiProviderId, ModelRef } from './types';

/** Cache entries older than this are considered stale and trigger a refresh. */
const DEFAULT_STALE_MS = 30_000;

export class LocalModelCache {
  private modelsByProvider = new Map<AiProviderId, ModelRef[]>();
  private lastErrorByProvider = new Map<AiProviderId, string>();
  private lastStartedAt: number | null = null;
  private lastCompletedAt: number | null = null;
  private refreshInFlight: Promise<void> | null = null;

  constructor(
    private timeoutMs: number = LOCAL_DISCOVERY_TIMEOUT_MS,
    private staleMs: number = DEFAULT_STALE_MS,
    private now: () => number = () => Date.now(),
  ) {}

  /** Flattened snapshot of all cached local models. Immediate, never throws. */
  snapshot(): ModelRef[] {
    const out: ModelRef[] = [];
    for (const models of this.modelsByProvider.values()) out.push(...models);
    return out;
  }

  /** True when the cache has never completed a refresh or the last one is old. */
  isStale(): boolean {
    if (this.lastCompletedAt == null) return true;
    return this.now() - this.lastCompletedAt >= this.staleMs;
  }

  /** Last discovery error for a provider (for a non-auth settings hint), if any. */
  lastError(provider: AiProviderId): string | undefined {
    return this.lastErrorByProvider.get(provider);
  }

  /**
   * Refresh all given local providers in the background. Concurrent calls join
   * the in-flight refresh instead of starting a new one. Resolves when the
   * refresh completes; callers SHOULD NOT await it on the picker path.
   */
  refreshInBackground(providers: AiProvider[]): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.lastStartedAt = this.now();
    const run = Promise.all(providers.map((p) => this.refreshOne(p))).then(
      () => {
        this.lastCompletedAt = this.now();
        this.refreshInFlight = null;
      },
      () => {
        // refreshOne never rejects, but stay defensive so a hang can't pin state.
        this.lastCompletedAt = this.now();
        this.refreshInFlight = null;
      },
    );
    this.refreshInFlight = run;
    return run;
  }

  private async refreshOne(provider: AiProvider): Promise<void> {
    try {
      const models = await withLocalTimeout(() => provider.listModels(), this.timeoutMs);
      this.modelsByProvider.set(provider.id, models);
      this.lastErrorByProvider.delete(provider.id);
    } catch (e) {
      // Offline / slow / timeout: model the provider as having no local models.
      this.modelsByProvider.set(provider.id, []);
      this.lastErrorByProvider.set(provider.id, e instanceof Error ? e.message : String(e));
    }
  }
}
