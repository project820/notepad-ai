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
 * A descriptor for a temp file created exclusively by the backend. Its identity
 * is captured from the same descriptor that received the document bytes.
 */
export interface ExclusiveTempFileHandle {
  writeFile(data: string | Buffer): Promise<void>;
  sync(): Promise<void>;
  stat(): Promise<{ dev: bigint; ino: bigint }>;
  close(): Promise<void>;
}

/** Narrow extension for callers that must keep a temp descriptor authoritative. */
export interface DescriptorAtomicWriteBackend extends AtomicWriteBackend {
  openExclusiveTemp(tmp: string, mode: number): Promise<ExclusiveTempFileHandle>;
}

export interface ExclusiveTempFile {
  readonly path: string;
  readonly identity: { readonly dev: bigint; readonly ino: bigint };
}

/**
 * Atomically write `data` to `target`.
 *
 * Order: mkdir(dir) -> writeFile(unique tmp, mode) -> fsyncFile(tmp) ->
 * beforeRename(tmp) -> rename(tmp, target) -> best-effort fsyncDir(dir). On any
 * failure before the rename completes, the temp file is unlinked and the error
 * is rethrown so the previous `target` is preserved intact.
 *
 * The temp filename uses `backend.randomId()` (never a fixed PID/timestamp) so
 * two writes issued in the same millisecond cannot pick the same temp path.
 */
export async function atomicWrite(
  target: string,
  data: string | Buffer,
  opts: {
    backend: AtomicWriteBackend;
    mode?: number;
    beforeRename?: (tempPath: string) => Promise<void>;
  },
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
    await opts.beforeRename?.(tmp);
    await backend.rename(tmp, target);
  } catch (err) {
    // Roll back the partial temp file; leave the prior `target` untouched.
    await backend.unlink(tmp).catch(() => {});
    throw err;
  }

  // The data is committed. Directory sync failures cannot undo the rename, but
  // unsupported filesystems are expected while other failures remain observable.
  if (backend.fsyncDir) {
    await backend.fsyncDir(dir).catch((err: unknown) => {
      if (!isUnsupportedFsyncError(err)) console.warn('[atomic-write] directory fsync failed', err);
    });
  }
}
/**
 * Atomically write through a single exclusively-created temp descriptor.
 *
 * `beforeWrite` runs after optional destination-directory preparation and
 * immediately before the exclusive create. `beforeRename` receives the fstat
 * identity of that same descriptor while it remains open, allowing callers to
 * verify the pathname was not swapped before rename.
 */
export async function atomicWriteWithExclusiveTemp(
  target: string,
  data: string | Buffer,
  opts: {
    backend: DescriptorAtomicWriteBackend;
    mode?: number;
    /** Create the target directory before writing; defaults to true. */
    prepareDirectory?: boolean;
    beforeWrite?: () => Promise<void>;
    beforeRename?: (temp: ExclusiveTempFile) => Promise<void>;
  },
): Promise<void> {
  const { backend } = opts;
  const mode = opts.mode ?? 0o600;
  const dir = path.dirname(target);
  const tmp = path.join(dir, `${path.basename(target)}.${backend.randomId()}.tmp`);
  let handle: ExclusiveTempFileHandle | undefined;
  let renamed = false;
  let tempCreated = false;

  if (opts.prepareDirectory ?? true) await backend.mkdir(dir);
  try {
    await opts.beforeWrite?.();
    handle = await backend.openExclusiveTemp(tmp, mode);
    tempCreated = true;
    await handle.writeFile(data);
    await handle.sync();
    const identity = await handle.stat();
    await opts.beforeRename?.({ path: tmp, identity });
    await backend.rename(tmp, target);
    renamed = true;
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
      handle = undefined;
    }
    if (tempCreated && !renamed) await backend.unlink(tmp).catch(() => {});
    throw error;
  } finally {
    if (handle) {
      await handle.close().catch(() => {
        console.warn('[atomic-write] post-rename descriptor close failed');
      });
    }
  }

  if (backend.fsyncDir) {
    await backend.fsyncDir(dir).catch((err: unknown) => {
      if (!isUnsupportedFsyncError(err)) console.warn('[atomic-write] directory fsync failed', err);
    });
  }
}

/** Flush a file to stable storage. */
async function strictFsync(p: string, flags: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(p, flags);
    await handle.sync();
  } finally {
    if (handle) await handle.close();
  }
}

function isUnsupportedFsyncError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    ['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes(String(err.code))
  );
}

/** Directory fsync is optional on some platforms; report real I/O failures. */
async function bestEffortDirectoryFsync(p: string): Promise<void> {
  try {
    await strictFsync(p, 'r');
  } catch (err) {
    if (!isUnsupportedFsyncError(err)) console.warn('[atomic-write] directory fsync failed', err);
  }
}

/**
 * Real `node:fs/promises`-backed implementation. File fsync is strict so a
 * failed flush cannot be followed by a rename; directory fsync is best-effort.
 */
export function nodeAtomicBackend(): DescriptorAtomicWriteBackend {
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
      await strictFsync(p, 'r+');
    },
    async openExclusiveTemp(tmp: string, mode: number): Promise<ExclusiveTempFileHandle> {
      const handle = await fs.open(tmp, 'wx', mode);
      return {
        async writeFile(data: string | Buffer): Promise<void> {
          await handle.writeFile(data);
        },
        async sync(): Promise<void> {
          await handle.sync();
        },
        async stat(): Promise<{ dev: bigint; ino: bigint }> {
          const stat = await handle.stat({ bigint: true });
          return { dev: stat.dev, ino: stat.ino };
        },
        async close(): Promise<void> {
          await handle.close();
        },
      };
    },
    async fsyncDir(dir: string): Promise<void> {
      await bestEffortDirectoryFsync(dir);
    },
    randomId(): string {
      return randomUUID();
    },
  };
}
