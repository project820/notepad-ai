/**
 * Canonical filesystem identity helpers.
 *
 * Paths are only locators. Authority records pair a canonical realpath with the
 * filesystem's bigint device/inode identity so aliases and replacements fail
 * closed.
 */

import path from 'node:path';

declare const fileIdentityBrand: unique symbol;
export type FileIdentity = string & { readonly [fileIdentityBrand]: true };

type CanonicalPathKind = 'file' | 'directory' | 'other';

export interface IdentityStat {
  readonly dev: bigint;
  readonly ino: bigint;
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface IdentityFs {
  realpath(p: string): Promise<string>;
  stat(p: string): Promise<IdentityStat>;
  /**
   * Inspect a directory entry without following its final symlink. Required to
   * distinguish a missing target from a dangling symlink.
   */
  lstat?(p: string): Promise<IdentityStat>;
}

export interface CanonicalPathIdentity {
  readonly realpath: string;
  readonly identity: FileIdentity;
  readonly kind: CanonicalPathKind;
}
export type CanonicalTargetLookup =
  | { readonly state: 'present'; readonly identity: CanonicalPathIdentity }
  | { readonly state: 'absent' }
  | { readonly state: 'error' };

/** The sole encoding for filesystem identities used by path and fd checks. */
export function identityFromStat(
  stat: Pick<IdentityStat, 'dev' | 'ino'>,
): FileIdentity {
  return `${stat.dev}:${stat.ino}` as FileIdentity;
}
/** True when target's canonical path is root itself or a descendant. */
export function isCanonicalPathWithinRoot(rootRealpath: string, targetRealpath: string): boolean {
  const relative = path.relative(rootRealpath, targetRealpath);
  if (relative === '..' || relative.startsWith('..' + path.sep)) return false;
  return !path.isAbsolute(relative);
}

/**
 * Resolve an existing target to its canonical path, identity, and kind.
 * Returns null when resolution or stat fails.
 */
export async function canonicalIdentity(
  target: string,
  fs: IdentityFs,
): Promise<CanonicalPathIdentity | null> {
  try {
    const realpath = await fs.realpath(target);
    const stat = await fs.stat(realpath);
    const kind: CanonicalPathKind = stat.isFile()
      ? 'file'
      : stat.isDirectory()
        ? 'directory'
        : 'other';
    return { realpath, identity: identityFromStat(stat), kind };
  } catch {
    return null;
  }
}
/**
 * Resolve a save target while distinguishing verified absence from a failed
 * lookup. A dangling final symlink is present to lstat but fails realpath, so
 * it is never treated as a new file. Backends without lstat fail closed.
 */
export async function lookupCanonicalTarget(
  target: string,
  fs: IdentityFs,
): Promise<CanonicalTargetLookup> {
  try {
    const realpath = await fs.realpath(target);
    const stat = await fs.stat(realpath);
    const kind: CanonicalPathKind = stat.isFile()
      ? 'file'
      : stat.isDirectory()
        ? 'directory'
        : 'other';
    return {
      state: 'present',
      identity: { realpath, identity: identityFromStat(stat), kind },
    };
  } catch (error) {
    if (!isEnoent(error) || !fs.lstat) return { state: 'error' };
    try {
      await fs.lstat(target);
      return { state: 'error' };
    } catch (lstatError) {
      return isEnoent(lstatError) ? { state: 'absent' } : { state: 'error' };
    }
  }
}

/**
 * Canonical save target for a possibly-new file. The parent must resolve to an
 * existing directory; no textual fallback is permitted.
 */
export async function canonicalNewTarget(target: string, fs: IdentityFs): Promise<string | null> {
  try {
    const parentRealpath = await fs.realpath(path.dirname(target));
    const parentStat = await fs.stat(parentRealpath);
    if (!parentStat.isDirectory()) return null;
    return path.join(parentRealpath, path.basename(target));
  } catch {
    return null;
  }
}

/** True when target's canonical path is root itself or a descendant. */
export async function isRealpathWithinRoot(
  root: string,
  target: string,
  fs: IdentityFs,
): Promise<boolean> {
  try {
    const realRoot = await fs.realpath(root);
    const realTarget = await fs.realpath(target);
    return isCanonicalPathWithinRoot(realRoot, realTarget);
  } catch {
    return false;
  }
}
function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}
