import { constants as fsConstants } from 'node:fs';
import { open as openFile, type FileHandle as NodeFileHandle } from 'node:fs/promises';

import { ASSET_SOURCE_READ_MAX_BYTES } from '../shared/html-export-assets';
import type { FileIdentity } from './path-identity';
import type { ExplicitAssetFileGrant } from './file-grants';
import { identityFromStat } from './path-identity';

const NOFOLLOW_FLAG = fsConstants.O_NOFOLLOW;
const NONBLOCK_FLAG = fsConstants.O_NONBLOCK;
const ASSET_NOFOLLOW_SUPPORTED = typeof NOFOLLOW_FLAG === 'number' && NOFOLLOW_FLAG !== 0;
const ASSET_NONBLOCK_SUPPORTED = typeof NONBLOCK_FLAG === 'number' && NONBLOCK_FLAG !== 0;
export const ASSET_OPEN_FLAGS = ASSET_NOFOLLOW_SUPPORTED && ASSET_NONBLOCK_SUPPORTED
  ? fsConstants.O_RDONLY | NOFOLLOW_FLAG | NONBLOCK_FLAG
  : fsConstants.O_RDONLY;

const READ_CHUNK_BYTES = 64 * 1024;

export interface FdStat {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  isFile(): boolean;
}

export interface AssetFileHandle {
  stat(): Promise<FdStat>;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ readonly bytesRead: number }>;
  close(): Promise<void>;
}

/** Minimal descriptor-only filesystem seam for deterministic authority tests. */
export interface AssetReadFs {
  open(path: string, flags: number): Promise<AssetFileHandle>;
}
async function statNodeAssetHandle(handle: NodeFileHandle): Promise<FdStat> {
  const snapshot = await handle.stat({ bigint: true });
  if (typeof snapshot.dev !== 'bigint'
    || typeof snapshot.ino !== 'bigint'
    || typeof snapshot.size !== 'bigint'
    || typeof snapshot.mtimeNs !== 'bigint'
    || typeof snapshot.ctimeNs !== 'bigint') {
    throw new Error('descriptor stats must use bigint precision');
  }
  return {
    dev: snapshot.dev,
    ino: snapshot.ino,
    size: snapshot.size,
    mtimeNs: snapshot.mtimeNs,
    ctimeNs: snapshot.ctimeNs,
    isFile: () => snapshot.isFile(),
  };
}

/** Production descriptor-only adapter; it never performs a path read or stat. */
export const nodeAssetReadFs: AssetReadFs = {
  async open(path, flags) {
    const handle = await openFile(path, flags);
    return {
      stat: () => statNodeAssetHandle(handle),
      async read(buffer, offset, length, position) {
        const { bytesRead } = await handle.read(buffer, offset, length, position);
        return { bytesRead };
      },
      close: () => handle.close(),
    };
  },
};

type FdBoundReadErrorKind =
  | 'open-failed'
  | 'not-regular-file'
  | 'identity-mismatch'
  | 'too-large'
  | 'read-failed'
  | 'changed-during-read'
  | 'close-failed';

export type FdBoundReadResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly error: FdBoundReadErrorKind };

export type AssetReadErrorKind = Exclude<FdBoundReadErrorKind, 'too-large'> | 'asset-too-large';

export type AssetReadResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly error: AssetReadErrorKind };

export interface IdentityBoundReadGrant {
  readonly realpath: string;
  readonly identity: FileIdentity;
}

function sameSnapshot(before: FdStat, after: FdStat): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs;
}

/**
 * Reads an authorized file through a single no-follow descriptor. The optional
 * cap bounds the allocation and the descriptor read; without one the pre-stat
 * size remains the only bound.
 */
export async function readFdBoundFile(
  grant: IdentityBoundReadGrant,
  fs: AssetReadFs,
  maxBytes = Number.MAX_SAFE_INTEGER - 1,
): Promise<FdBoundReadResult> {
  if (!ASSET_NOFOLLOW_SUPPORTED || !ASSET_NONBLOCK_SUPPORTED || !Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    return { ok: false, error: 'open-failed' };
  }

  let handle: AssetFileHandle;
  try {
    handle = await fs.open(grant.realpath, ASSET_OPEN_FLAGS);
  } catch {
    return { ok: false, error: 'open-failed' };
  }

  let buffer: Uint8Array | undefined;
  let result: FdBoundReadResult | undefined;
  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      result = { ok: false, error: 'not-regular-file' };
    } else if (identityFromStat(before) !== grant.identity) {
      result = { ok: false, error: 'identity-mismatch' };
    } else if (before.size < 0n || before.size > BigInt(maxBytes)) {
      result = { ok: false, error: 'too-large' };
    } else {
      const maximumReadBytes = maxBytes + 1;
      const allocationBytes = Math.min(Number(before.size) + 1, maximumReadBytes);
      buffer = new Uint8Array(allocationBytes);
      let offset = 0;
      let reachedEnd = false;

      while (offset < allocationBytes) {
        const length = Math.min(READ_CHUNK_BYTES, allocationBytes - offset);
        const { bytesRead } = await handle.read(buffer, offset, length, offset);
        if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > length) {
          result = { ok: false, error: 'read-failed' };
          break;
        }
        if (bytesRead === 0) {
          reachedEnd = true;
          break;
        }
        offset += bytesRead;
      }

      if (!result) {
        const after = await handle.stat();
        if (!sameSnapshot(before, after)) {
          result = { ok: false, error: 'changed-during-read' };
        } else if (!reachedEnd || offset > maxBytes) {
          result = { ok: false, error: 'too-large' };
        } else if (offset !== Number(before.size)) {
          result = { ok: false, error: 'read-failed' };
        } else {
          result = { ok: true, bytes: buffer.subarray(0, offset) };
        }
      }
    }
  } catch {
    result = { ok: false, error: 'read-failed' };
  }

  try {
    await handle.close();
  } catch {
    buffer?.fill(0);
    return { ok: false, error: 'close-failed' };
  }
  if (!result?.ok) buffer?.fill(0);
  return result ?? { ok: false, error: 'read-failed' };
}

/** Reads an explicitly selected asset through the frozen asset-size cap. */
export async function readFdBoundAsset(
  grant: ExplicitAssetFileGrant,
  fs: AssetReadFs,
): Promise<AssetReadResult> {
  const result = await readFdBoundFile(grant, fs, ASSET_SOURCE_READ_MAX_BYTES);
  if (!result.ok) {
    return {
      ok: false,
      error: result.error === 'too-large' ? 'asset-too-large' : result.error,
    };
  }
  return result;
}
