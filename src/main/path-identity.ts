/**
 * path-identity.ts — canonical filesystem identity + symlink-escape guard (Phase 2).
 *
 * Phase 1 used textual paths as ownership/grant keys. Two different strings can
 * point at one file (`./a` vs `a`, symlinks, hardlinks, case-folding on APFS), so
 * Phase 2 resolves a canonical identity via realpath + `dev:ino` and rejects a
 * target that realpath-escapes a granted root.
 *
 * The `fs` surface is injected so the logic is unit-testable without a real disk.
 */

import path from 'node:path';

export interface IdentityFs {
  realpath(p: string): Promise<string>;
  stat(p: string): Promise<{ dev: number; ino: number }>;
}

/**
 * Canonical identity of an EXISTING file: `${dev}:${ino}` plus its realpath.
 * Returns null when the path cannot be resolved (missing / unreadable).
 */
export async function canonicalIdentity(
  target: string,
  fs: IdentityFs,
): Promise<{ realpath: string; identity: string } | null> {
  try {
    const real = await fs.realpath(target);
    const st = await fs.stat(real);
    return { realpath: real, identity: `${st.dev}:${st.ino}` };
  } catch {
    return null;
  }
}

/**
 * Canonical save target for a possibly-NEW file: realpath the parent directory
 * (which must exist) and re-join the basename. Returns null when the parent is
 * unresolvable. Used to reserve a save slot before the file exists.
 */
export async function canonicalNewTarget(target: string, fs: IdentityFs): Promise<string | null> {
  try {
    const parentReal = await fs.realpath(path.dirname(target));
    return path.join(parentReal, path.basename(target));
  } catch {
    return null;
  }
}

/**
 * True when `target` resolves (via realpath) to `root` itself or a descendant.
 * Rejects symlinks whose real destination escapes the root, even when the textual
 * path looks contained.
 */
export async function isRealpathWithinRoot(
  root: string,
  target: string,
  fs: IdentityFs,
): Promise<boolean> {
  try {
    const realRoot = await fs.realpath(root);
    const realTarget = await fs.realpath(target);
    if (realTarget === realRoot) return true;
    const rel = path.relative(realRoot, realTarget);
    return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}
