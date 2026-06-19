/**
 * API-key storage for BYO-key providers (Claude, OpenRouter).
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

type PersistShape = Partial<Record<AiProviderId, string>>;

export class ApiKeyStore {
  private memory = new Map<AiProviderId, string>();
  private diskLoaded = false;
  private disk: PersistShape = {};

  constructor(private backend: KeyStoreBackend) {}

  private async loadDisk(): Promise<void> {
    if (this.diskLoaded) return;
    this.diskLoaded = true;
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
  }

  private async persistDisk(): Promise<void> {
    const json = JSON.stringify(this.disk);
    const buf = this.backend.encryptString(json);
    await this.backend.writeFile(buf);
  }

  /**
   * Store a key. Returns whether it was persisted to disk (true) or held in
   * memory only because encryption is unavailable (false).
   */
  async setApiKey(provider: AiProviderId, key: string): Promise<{ persisted: boolean }> {
    const trimmed = key.trim();
    if (!trimmed) throw new Error('API key must not be empty.');
    this.memory.set(provider, trimmed);
    if (!this.backend.isEncryptionAvailable()) {
      // REFUSE PERSIST: never write plaintext to disk.
      return { persisted: false };
    }
    await this.loadDisk();
    this.disk[provider] = trimmed;
    await this.persistDisk();
    return { persisted: true };
  }

  async getApiKey(provider: AiProviderId): Promise<string | null> {
    const mem = this.memory.get(provider);
    if (mem) return mem;
    await this.loadDisk();
    return this.disk[provider] ?? null;
  }

  async deleteApiKey(provider: AiProviderId): Promise<void> {
    this.memory.delete(provider);
    await this.loadDisk();
    if (this.disk[provider] !== undefined) {
      delete this.disk[provider];
      if (this.backend.isEncryptionAvailable()) {
        await this.persistDisk();
      }
    }
  }

  async getKeyStatus(provider: AiProviderId): Promise<KeyStatus> {
    const key = await this.getApiKey(provider);
    if (!key) return { connected: false, persisted: false };
    const persistedOnDisk =
      this.backend.isEncryptionAvailable() && this.disk[provider] !== undefined;
    return { connected: true, keyLast4: keyLast4(key), persisted: persistedOnDisk };
  }
}
