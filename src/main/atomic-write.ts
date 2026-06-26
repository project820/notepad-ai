/**
 * Atomic write primitive shared by the session store and the API-key store.
 *
 * The crash-safe sequence is: write to a unique sibling temp file, fsync it,
 * then `rename(2)` it over the target (atomic on POSIX), and best-effort fsync
 * the directory so the rename itself is durable. If anything before the rename
 * completes fails, the temp file is removed and the previous `target` is left
 * untouched.
 *
 * The fs layer is dependency-injected (`AtomicWriteBackend`) so the ordering
 * and failure-handling contract is unit-testable without touching the disk
 * (mirrors the `ApiKeyStore` / `StateFs` injectable-backend pattern).
 */

import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Injectable filesystem backend used by {@link atomicWrite}. */
export interface AtomicWriteBackend {
  /** Create `dir` (recursively) if it does not already exist. */
  mkdir(dir: string): Promise<void>;
  /** Write `data` to `tmp`, creating it with permission bits `mode`. */
  writeFile(tmp: string, data: string | Buffer, mode: number): Promise<void>;
  /** Atomically replace `target` with `tmp`. */
  rename(tmp: string, target: string): Promise<void>;
  /** Remove `p`; used to clean up the temp file on failure. */
  unlink(p: string): Promise<void>;
  /** Flush `p`'s contents to stable storage. */
  fsyncFile(p: string): Promise<void>;
  /** Optional: flush directory metadata so the rename is durable. Best-effort. */
  fsyncDir?(dir: string): Promise<void>;
  /** Return a fresh, collision-resistant id for the temp filename. */
  randomId(): string;
}

/**
 * Atomically write `data` to `target`.
 *
 * Order: mkdir(dir) -> writeFile(unique tmp, mode) -> fsyncFile(tmp) ->
 * rename(tmp, target) -> best-effort fsyncDir(dir). On any failure before the
 * rename completes, the temp file is unlinked and the error is rethrown so the
 * previous `target` is preserved intact.
 *
 * The temp filename uses `backend.randomId()` (never a fixed PID/timestamp) so
 * two writes issued in the same millisecond cannot pick the same temp path.
 */
export async function atomicWrite(
  target: string,
  data: string | Buffer,
  opts: { backend: AtomicWriteBackend; mode?: number },
): Promise<void> {
  const { backend } = opts;
  const mode = opts.mode ?? 0o600;
  const dir = path.dirname(target);
  const base = path.basename(target);

  await backend.mkdir(dir);
  const tmp = path.join(dir, `${base}.${backend.randomId()}.tmp`);
  try {
    await backend.writeFile(tmp, data, mode);
    await backend.fsyncFile(tmp);
    await backend.rename(tmp, target);
  } catch (err) {
    // Roll back the partial temp file; leave the prior `target` untouched.
    await backend.unlink(tmp).catch(() => {});
    throw err;
  }

  // The data is committed. Flushing the directory is a durability nicety only,
  // so swallow any error rather than failing an already-successful write.
  if (backend.fsyncDir) {
    await backend.fsyncDir(dir).catch(() => {});
  }
}

/** fsync `p` (opened with `flags`) best-effort; swallow unsupported/IO errors. */
async function bestEffortFsync(p: string, flags: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(p, flags);
    await handle.sync();
  } catch {
    // Best-effort durability — e.g. directory fsync is unsupported on Windows.
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/**
 * Real `node:fs/promises`-backed implementation. fsync uses `fs.open` +
 * `handle.sync()` and tolerates failures. Not exercised by the unit tests,
 * which inject a fake backend instead.
 */
export function nodeAtomicBackend(): AtomicWriteBackend {
  return {
    async mkdir(dir: string): Promise<void> {
      await fs.mkdir(dir, { recursive: true });
    },
    async writeFile(tmp: string, data: string | Buffer, mode: number): Promise<void> {
      await fs.writeFile(tmp, data, { mode });
    },
    async rename(tmp: string, target: string): Promise<void> {
      await fs.rename(tmp, target);
    },
    async unlink(p: string): Promise<void> {
      await fs.unlink(p);
    },
    async fsyncFile(p: string): Promise<void> {
      await bestEffortFsync(p, 'r+');
    },
    async fsyncDir(dir: string): Promise<void> {
      await bestEffortFsync(dir, 'r');
    },
    randomId(): string {
      return randomUUID();
    },
  };
}
