/**
 * file-grants.ts — per-window filesystem capability grants (Phase 1 security gate).
 *
 * A renderer-supplied absolute path is NOT authority. The main process records
 * what the user actually granted this session — a workspace root chosen in the
 * open-folder dialog, or an individual file opened/saved through a dialog, the OS
 * "Open With" handoff, session restore, or a document conversion main itself
 * initiated. Every path-bearing IPC then checks the path against those grants:
 *
 *   - a file is allowed if it was granted directly, or it lives inside a granted
 *     workspace root (textual containment — realpath/inode identity is Phase 2);
 *   - a workspace listing is allowed only for a granted root.
 *
 * This closes the "saveFile('/etc/passwd')" / "listDir('/','/Users')" class of
 * arbitrary read/write/list the renderer path string used to grant by itself.
 *
 * Grants are keyed by `webContents.id` and released when the window closes.
 */

import path from 'node:path';
import { isWithinRoot } from './file-tree';

export class FileGrants {
  private workspaces = new Map<number, Set<string>>();
  private files = new Map<number, Set<string>>();

  private setFor(map: Map<number, Set<string>>, wcId: number): Set<string> {
    let s = map.get(wcId);
    if (!s) {
      s = new Set<string>();
      map.set(wcId, s);
    }
    return s;
  }

  /** Record that the user opened `root` as a workspace for this window. */
  grantWorkspace(wcId: number, root: string): void {
    this.setFor(this.workspaces, wcId).add(path.resolve(root));
  }

  /** Record that `filePath` was opened/saved through a trusted, user-driven path. */
  grantFile(wcId: number, filePath: string): void {
    this.setFor(this.files, wcId).add(path.resolve(filePath));
  }

  /** Drop every grant for a closed window. */
  release(wcId: number): void {
    this.workspaces.delete(wcId);
    this.files.delete(wcId);
  }

  /** True when `root` is exactly a workspace the user granted for this window. */
  isWorkspaceGranted(wcId: number, root: string): boolean {
    const resolved = path.resolve(root);
    return this.workspaces.get(wcId)?.has(resolved) ?? false;
  }

  /**
   * True when `filePath` was granted directly, or lives inside a granted
   * workspace root for this window.
   */
  isFileAllowed(wcId: number, filePath: string): boolean {
    const resolved = path.resolve(filePath);
    if (this.files.get(wcId)?.has(resolved)) return true;
    const roots = this.workspaces.get(wcId);
    if (roots) {
      for (const root of roots) {
        if (isWithinRoot(root, resolved)) return true;
      }
    }
    return false;
  }
}
