/**
 * overview-traversal.ts
 *
 * v1.1 feature: Context-layer resolver for the 3-layer prompt system.
 *
 * Implements ancestor-directory traversal to locate Overview.md files in
 * the folder hierarchy above a given document.  The result (closest-first
 * ordered list) is the "Overview chain" that gets injected into AI prompts
 * via the 7-layer context stack.
 *
 * ROLLBACK SAFETY:
 *   - This module is purely additive.  No existing code calls it in v1.0 code paths.
 *   - When the "3-layer prompts" feature toggle is OFF the caller never invokes
 *     findOverviewChain, so v1.0 behaviour is fully preserved.
 *   - Absence of Overview.md files at any level is handled gracefully (returns []).
 *   - Errors from the filesystem (permissions, missing paths) never throw; they
 *     are silently skipped so the editor never crashes.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

/** An entry in the resolved Overview chain. */
export interface OverviewEntry {
  /** Absolute path to the Overview.md file. */
  filePath: string;
  /** Depth relative to the document's own directory.
   *  0 = same directory, 1 = one level up, 2 = two levels up, … */
  depth: number;
}

/**
 * Walk upward from the directory containing `filePath` to `workspaceRoot`
 * (inclusive) and collect every Overview.md found along the way.
 *
 * Ordering: the entry closest to the document comes first (depth 0, 1, 2, …).
 * This matches the "closer-wins" conflict-resolution rule described in the
 * Claude Code CLAUDE.md cascade pattern referenced in the v1.1 Seed.
 *
 * Boundary rules:
 *   - Traversal NEVER goes above `workspaceRoot`.
 *   - `workspaceRoot` itself IS checked (inclusive).
 *   - If `filePath` is not inside `workspaceRoot`, an empty array is returned
 *     immediately (no traversal, no crash).
 *   - A non-existent or non-file Overview.md is skipped silently.
 *
 * @param filePath      Absolute path to the document being edited.
 * @param workspaceRoot Absolute path to the workspace/project root directory.
 * @returns             Ordered array of {@link OverviewEntry} objects, closest first.
 *                      Returns [] when no Overview.md is found anywhere in the chain.
 */
export async function findOverviewChain(
  filePath: string,
  workspaceRoot: string,
): Promise<OverviewEntry[]> {
  // Normalise both paths so comparisons are reliable regardless of trailing
  // slashes or mixed separators.
  const normalizedRoot = path.resolve(workspaceRoot);
  const normalizedFile = path.resolve(filePath);
  let currentDir = path.dirname(normalizedFile);

  // Guard: if the document lives outside the workspace, return nothing.
  // We check both "inside with separator" and "is exactly the root" to avoid
  // false positives like root=/a matching currentDir=/ab.
  const insideWorkspace =
    currentDir === normalizedRoot ||
    currentDir.startsWith(normalizedRoot + path.sep);

  if (!insideWorkspace) {
    return [];
  }

  const results: OverviewEntry[] = [];
  let depth = 0;

  while (true) {
    const overviewPath = path.join(currentDir, 'Overview.md');

    try {
      const stat = await fs.stat(overviewPath);
      // Only include regular files — not directories named Overview.md.
      if (stat.isFile()) {
        results.push({ filePath: overviewPath, depth });
      }
    } catch {
      // ENOENT (not found) or EACCES (permission denied) — skip silently.
    }

    // Stop after processing the workspace root; never go higher.
    if (currentDir === normalizedRoot) break;

    const parent = path.dirname(currentDir);

    // Safety valve: stop if dirname() returns the same path (filesystem root).
    if (parent === currentDir) break;

    currentDir = parent;
    depth += 1;
  }

  return results;
}

/**
 * Convenience helper that returns only the file paths from a chain,
 * omitting depth metadata.  Useful when callers just need ordered paths.
 *
 * @param filePath      Absolute path to the document being edited.
 * @param workspaceRoot Absolute path to the workspace/project root directory.
 * @returns             Ordered array of absolute paths to Overview.md files,
 *                      closest first.  Returns [] when none found.
 */
export async function findOverviewPaths(
  filePath: string,
  workspaceRoot: string,
): Promise<string[]> {
  const chain = await findOverviewChain(filePath, workspaceRoot);
  return chain.map((e) => e.filePath);
}
