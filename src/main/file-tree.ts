/**
 * file-tree.ts — main-process helpers for the v0.4 left-panel file tree (G004).
 *
 * Three concerns, each kept thin and pure so they are testable without Electron:
 *   - `listDirectory` / `buildDirectoryListing`: one-level lazy readdir with
 *     noise hidden, directories first, name-sorted; fs access is separated from
 *     the sort/filter logic.
 *   - `isWithinRoot`: path-traversal containment so a listing can never escape
 *     the workspace root.
 *   - `openFileInCurrentWindow`: the duplicate-path ownership guard for opening
 *     a file in the current window (mirrors `window-registry.resolvePathClaim`).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  extOf,
  fileKindForExt,
  isNoiseName,
  isOpenableExt,
  type FileTreeEntry,
} from '../shared/file-types';

// Re-exported so main-process callers can import the file-tree contract from here.
export type { FileTreeEntry } from '../shared/file-types';

/**
 * True when `targetPath` resolves to `rootPath` itself or a descendant of it.
 * Rejects `..` traversal and absolute escapes. Textual comparison (consistent
 * with the rest of the app's exact-path ownership model).
 */
export function isWithinRoot(rootPath: string, targetPath: string): boolean {
  const root = path.resolve(rootPath);
  const target = path.resolve(targetPath);
  if (target === root) return true;
  const rel = path.relative(root, target);
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Pure transform: filter noise, map to {@link FileTreeEntry}, and sort
 * directories-first then by name (case-insensitive, numeric-aware). No fs.
 */
export function buildDirectoryListing(
  rawEntries: ReadonlyArray<{ name: string; isDir: boolean }>,
  dirPath: string,
): FileTreeEntry[] {
  const mapped: FileTreeEntry[] = [];
  for (const entry of rawEntries) {
    if (isNoiseName(entry.name)) continue;
    const ext = entry.isDir ? '' : extOf(entry.name);
    mapped.push({
      name: entry.name,
      path: path.join(dirPath, entry.name),
      isDir: entry.isDir,
      ext,
      openable: !entry.isDir && isOpenableExt(ext),
      kind: entry.isDir ? 'folder' : fileKindForExt(ext),
    });
  }
  mapped.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1; // directories first
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
  return mapped;
}

/**
 * Read one level of `dirPath` (which MUST be inside `rootPath`). Throws when the
 * directory escapes the root (path traversal) — callers surface that as an
 * error, never a silent partial listing.
 */
export async function listDirectory(args: {
  rootPath: string;
  dirPath: string;
}): Promise<FileTreeEntry[]> {
  const { rootPath, dirPath } = args;
  if (!isWithinRoot(rootPath, dirPath)) {
    throw new Error(`path-escapes-root: "${dirPath}" is not within "${rootPath}"`);
  }
  const resolvedDir = path.resolve(dirPath);
  const dirents = await fs.readdir(resolvedDir, { withFileTypes: true });
  const raw = dirents.map((d) => ({ name: d.name, isDir: d.isDirectory() }));
  return buildDirectoryListing(raw, resolvedDir);
}

/**
 * True for an absolute local filesystem path that is safe to hand to
 * `shell.openPath` or to open in a window. Rejects non-strings, empty/whitespace,
 * URL/`file:` schemes, control characters, and relative paths.
 */
export function isSafeLocalAbsolutePath(input: unknown): input is string {
  if (typeof input !== 'string') return false;
  const value = input.trim();
  if (value.length === 0) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false; // scheme://…
  if (/^file:/i.test(value)) return false;
  if (/[\u0000-\u001f]/.test(value)) return false; // control chars / newlines
  if (!path.isAbsolute(value)) return false;
  // Reject any '..' segment: a legitimate absolute target (dialog/session/tree)
  // is already normalized, so a traversal segment signals a crafted path.
  if (value.split(/[\\/]/).includes('..')) return false;
  return true;
}

/** Result of {@link openFileInCurrentWindow}. */
export type OpenInCurrentResult =
  | { opened: true }
  | { opened: false; focusedOwner: true; ownerWindowId: number }
  | { opened: false; error: string };

/** Side effects injected so the open/focus decision is unit-testable. */
export interface OpenInCurrentEffects {
  /** Window registry lookup for the current owner of a path (or null). */
  ownerOfPath(absPath: string): { windowId: number } | null;
  /** Focus the owning window (no-op when it is gone). */
  focusOwner(ownerWindowId: number): void;
  /**
   * Open the file in the requesting window. The existing `openFilePath` path
   * claims ownership internally, so no separate claim is performed here.
   */
  openInRequester(absPath: string): Promise<void>;
}

/**
 * Open `target` in the requesting window, honoring the multi-window duplicate-
 * path ownership guard: if another live window already owns the path, focus that
 * owner instead of opening a second writer (never calls `openInRequester`).
 *
 * Mirrors `window-registry.resolvePathClaim` so the file tree can never bypass
 * the guard that protects `file:save` from two windows owning one document.
 */
export async function openFileInCurrentWindow(
  requesterWindowId: number,
  target: unknown,
  effects: OpenInCurrentEffects,
): Promise<OpenInCurrentResult> {
  if (!isSafeLocalAbsolutePath(target)) {
    return { opened: false, error: 'invalid-path' };
  }
  const absPath = path.resolve(target as string);
  const owner = effects.ownerOfPath(absPath);
  if (owner && owner.windowId !== requesterWindowId) {
    effects.focusOwner(owner.windowId);
    return { opened: false, focusedOwner: true, ownerWindowId: owner.windowId };
  }
  await effects.openInRequester(absPath);
  return { opened: true };
}
