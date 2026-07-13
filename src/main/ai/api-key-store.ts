/**
 * API-key storage for BYO-key providers (Claude, OpenRouter, xAI/Grok).
 *
 * SECURITY POLICY (locked by ralplan consensus):
 * - Keys are encrypted at rest via Electron safeStorage (Keychain) ONLY.
 * - If safeStorage encryption is unavailable, persistence is REFUSED: keys are
 *   held in memory for the current session and NEVER written as plaintext.
 * - Status objects expose at most the last 4 characters of a key.
 *
 * The store is dependency-injected (`KeyStoreBackend`) so the refuse-persist
 * policy is unit-testable without Electron.
 */

import type { AiProviderId } from './types';

export interface KeyStoreBackend {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(buf: Buffer): string;
  readFile(): Promise<Buffer | null>;
  writeFile(buf: Buffer): Promise<void>;
  removeFile(): Promise<void>;
}

export type KeyStatus = {
  connected: boolean;
  keyLast4?: string;
  /** false = held in memory for this session only (encryption unavailable). */
  persisted: boolean;
};

/** Last 4 chars of a key for display. Pure. */
export function keyLast4(key: string): string {
  const trimmed = key.trim();
  return trimmed.length <= 4 ? trimmed : trimmed.slice(-4);
}
export const API_KEY_PROVIDERS = ['claude', 'openrouter', 'grok'] as const;

function isApiKeyProvider(provider: AiProviderId): boolean {
  return (API_KEY_PROVIDERS as readonly AiProviderId[]).includes(provider);
}

type PersistShape = Partial<Record<AiProviderId, string>>;

export class ApiKeyStore {
  private memory = new Map<AiProviderId, string>();
  private loadPromise: Promise<void> | null = null;
  private disk: PersistShape = {};
  /** Serializes setApiKey/deleteApiKey so concurrent writes never lose a key (H-25). */
  private mutationChain: Promise<unknown> = Promise.resolve();

  constructor(private backend: KeyStoreBackend) {}

  /** Single-flight disk load: concurrent callers share one read (no init race). */
  private loadDisk(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        if (!this.backend.isEncryptionAvailable()) return;
        const buf = await this.backend.readFile();
        if (!buf) return;
        try {
          const json = this.backend.decryptString(buf);
          const parsed = JSON.parse(json);
          if (parsed && typeof parsed === 'object') this.disk = parsed as PersistShape;
        } catch {
          // Corrupt/undecryptable store — ignore, treat as empty.
          this.disk = {};
        }
      })();
    }
    return this.loadPromise;
  }

  private async persistDisk(disk: PersistShape): Promise<void> {
    const json = JSON.stringify(disk);
    const buf = this.backend.encryptString(json);
    await this.backend.writeFile(buf);
  }

  /** Run a disk mutation serialized behind any in-flight one. */
  private mutate<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutationChain.then(fn);
    this.mutationChain = run.catch(() => {});
    return run;
  }

  /**
   * Store a key. Returns whether it was persisted to disk (true) or held in
   * memory only because encryption is unavailable (false). Disk mutations are
   * serialized so two concurrent sets cannot drop each other's key.
   */
  async setApiKey(provider: AiProviderId, key: string): Promise<{ persisted: boolean }> {
    if (!isApiKeyProvider(provider)) throw new Error(`${provider} does not use an API key.`);
    const trimmed = key.trim();
    if (!trimmed) throw new Error('API key must not be empty.');
    if (!this.backend.isEncryptionAvailable()) {
      // REFUSE PERSIST: never write plaintext to disk.
      this.memory.set(provider, trimmed);
      return { persisted: false };
    }
    return this.mutate(async () => {
      await this.loadDisk();
      const candidate = { ...this.disk, [provider]: trimmed };
      await this.persistDisk(candidate);
      this.disk = candidate;
      this.memory.set(provider, trimmed);
      return { persisted: true };
    });
  }

  async getApiKey(provider: AiProviderId): Promise<string | null> {
    const mem = this.memory.get(provider);
    if (mem) return mem;
    await this.loadDisk();
    return this.disk[provider] ?? null;
  }

  async deleteApiKey(provider: AiProviderId): Promise<void> {
    if (!this.backend.isEncryptionAvailable()) {
      this.memory.delete(provider);
      return;
    }
    await this.mutate(async () => {
      await this.loadDisk();
      if (this.disk[provider] === undefined) {
        this.memory.delete(provider);
        return;
      }
      const candidate = { ...this.disk };
      delete candidate[provider];
      await this.persistDisk(candidate);
      this.disk = candidate;
      this.memory.delete(provider);
    });
  }

  async getKeyStatus(provider: AiProviderId): Promise<KeyStatus> {
    const key = await this.getApiKey(provider);
    if (!key) return { connected: false, persisted: false };
    const persistedOnDisk =
      this.backend.isEncryptionAvailable() && this.disk[provider] !== undefined;
    return { connected: true, keyLast4: keyLast4(key), persisted: persistedOnDisk };
  }
}
