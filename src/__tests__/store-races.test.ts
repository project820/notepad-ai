/**
 * store-races.test.ts — persistence single-flight + serialization (Phase 4, H-25/H-26).
 *
 * The ApiKeyStore / LocalConfigStore init race dropped data when two mutations
 * interleaved (one read the disk after the other had set). These cover the
 * single-flight load and serialized mutations that fix it, plus the
 * commit-after-durable-write guarantee for LocalConfigStore.
 */

import { describe, it, expect } from 'vitest';
import { ApiKeyStore, type KeyStoreBackend } from '../main/ai/api-key-store';
import { LocalConfigStore } from '../main/ai/local-config';
import type { LocalConfigBackend } from '../main/ai/local-config';

/** Fake encrypted key backend (identity "encryption"); counts reads. */
function makeKeyBackend() {
  let stored: Buffer | null = null;
  let reads = 0;
  const backend: KeyStoreBackend = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(s, 'utf-8'),
    decryptString: (b) => b.toString('utf-8'),
    readFile: async () => {
      reads += 1;
      return stored;
    },
    writeFile: async (b) => {
      stored = b;
    },
    removeFile: async () => {
      stored = null;
    },
  };
  return { backend, get reads() { return reads; }, get diskJson() { return stored ? stored.toString('utf-8') : null; } };
}

describe('ApiKeyStore — single-flight + serialized mutations (H-25)', () => {
  it('two concurrent setApiKey calls both survive (no lost write)', async () => {
    const h = makeKeyBackend();
    const store = new ApiKeyStore(h.backend);
    await Promise.all([store.setApiKey('claude', 'AAAA1234'), store.setApiKey('openrouter', 'BBBB5678')]);
    expect(await store.getApiKey('claude')).toBe('AAAA1234');
    expect(await store.getApiKey('openrouter')).toBe('BBBB5678');
    const disk = JSON.parse(h.diskJson ?? '{}');
    expect(disk.claude).toBe('AAAA1234');
    expect(disk.openrouter).toBe('BBBB5678');
  });

  it('loads the disk at most once across concurrent operations', async () => {
    const h = makeKeyBackend();
    const store = new ApiKeyStore(h.backend);
    await Promise.all([
      store.getApiKey('claude'),
      store.setApiKey('claude', 'AAAA1234'),
      store.getApiKey('openrouter'),
    ]);
    expect(h.reads).toBe(1);
  });
});

function makeLocalBackend(initial: string | null = null) {
  let stored = initial;
  let failNext = false;
  const backend: LocalConfigBackend = {
    readFile: async () => stored,
    writeFile: async (json) => {
      if (failNext) {
        failNext = false;
        throw new Error('disk full');
      }
      stored = json;
    },
  };
  return { backend, get diskJson() { return stored; }, failOnce() { failNext = true; } };
}

describe('LocalConfigStore — single-flight + commit-after-write (H-26)', () => {
  it('two concurrent set() calls both persist (no clobber)', async () => {
    const h = makeLocalBackend();
    const store = new LocalConfigStore(h.backend);
    await Promise.all([
      store.set({ ollama: 'http://localhost:11434' }),
      store.set({ lmstudio: 'http://localhost:1234' }),
    ]);
    const cfg = await store.get();
    expect(cfg.ollama).toContain('11434');
    expect(cfg.lmstudio).toContain('1234');
  });

  it('does NOT activate a new URL in runtime when the durable write fails', async () => {
    const h = makeLocalBackend();
    const store = new LocalConfigStore(h.backend);
    const before = (await store.get()).ollama;
    h.failOnce();
    await expect(store.set({ ollama: 'http://localhost:9999' })).rejects.toThrow('disk full');
    // Runtime config must be unchanged (commit happens only after a successful write).
    expect((await store.get()).ollama).toBe(before);
  });

  it('rejects a remote URL and persists nothing', async () => {
    const h = makeLocalBackend();
    const store = new LocalConfigStore(h.backend);
    await expect(store.set({ ollama: 'http://evil.example' })).rejects.toThrow();
    expect(h.diskJson).toBeNull();
  });
});
