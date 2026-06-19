/**
 * overview-map-collector.ts
 *
 * v1.1 feature: Traversal-backed OverviewMap collector for the 3-layer prompt system.
 *
 * Combines the ancestor-directory traversal logic (AC 12.1) with the
 * dependency-injected Overview reader (AC 12.3.1) to collect all
 * {@link OverviewMap} objects in the folder hierarchy above a given document.
 *
 * The returned list is ordered **closest-first** (the Overview.md in the same
 * directory as the document comes first, the workspace-root Overview.md comes
 * last).  This ordering is compatible with {@link mergeOverviewMaps}, which
 * applies the closer-wins conflict-resolution rule used by the v1.1 prompt
 * cascade.
 *
 * ─── Design notes ───────────────────────────────────────────────────────────
 *
 * DEPENDENCY INJECTION — The function accepts a {@link FsReader} interface
 * rather than importing `node:fs` directly.  Production callers pass
 * `node:fs/promises`; unit tests inject in-memory stubs without touching the
 * real filesystem.
 *
 * TRAVERSAL LOGIC — The path-walking loop mirrors the one in
 * {@link findOverviewChain} (overview-traversal.ts, AC 12.1) but replaces the
 * `fs.stat` check with a call to {@link readOverviewAt} so that the same FsReader
 * abstraction serves both existence detection and content parsing in one step.
 *
 * NULL FILTERING — Absent files (readOverviewAt returns null) are silently
 * skipped.  Only successfully parsed {@link OverviewMap} objects are included
 * in the result array.
 *
 * ROLLBACK SAFETY — This module is purely additive.  Callers guard invocations
 * behind the `promptLayersEnabled` feature toggle.  When the toggle is OFF the
 * caller never invokes collectOverviewMaps, so v1.0 behaviour is fully preserved.
 * Absence of all Overview.md files in the hierarchy returns [] — never a crash.
 *
 * PROCESS SAFETY — Uses only `node:path` (pure computation) and the injected
 * FsReader.  Safe to use in the Electron main process; may also be used in unit
 * tests with in-memory stubs.
 *
 * @module
 */

import path from 'node:path';
import { readOverviewAt, type FsReader } from './overview-reader';
import type { OverviewMap } from './overview-parser';

// Re-export FsReader so callers only need to import from this module.
export type { FsReader };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Walks ancestor directories from the document's parent directory up to
 * (and including) the workspace root, reads Overview.md at each level via the
 * provided filesystem reader, and returns an ordered list of successfully
 * parsed {@link OverviewMap} objects.
 *
 * Ordering: the entry closest to the document comes first (the Overview.md
 * in the same folder as the document), and the workspace-root entry comes last.
 * This matches the "closer-wins" cascade rule expected by {@link mergeOverviewMaps}.
 *
 * Boundary rules (inherited from the AC 12.1 traversal contract):
 *   - Traversal NEVER goes above `workspaceRoot`.
 *   - `workspaceRoot` itself IS checked (inclusive).
 *   - If `docPath` is not inside `workspaceRoot`, an empty array is returned
 *     immediately — no traversal, no crash.
 *   - Directories where the Overview.md is absent (null returned by reader)
 *     are silently skipped; they do NOT appear in the result array.
 *   - Malformed or empty Overview.md files produce an empty-but-valid
 *     {@link OverviewMap} (`{ fields: {}, sections: {} }`) rather than null,
 *     so they ARE included in the result.
 *
 * @param docPath       Absolute path to the document being edited.
 * @param workspaceRoot Absolute path to the workspace/project root directory.
 *                      Traversal stops here; this directory is checked last.
 * @param fs            A {@link FsReader} implementation.  Pass
 *                      `node:fs/promises` in production code, or a stub object
 *                      in unit tests.
 *
 * @returns A Promise that resolves to an ordered array of {@link OverviewMap}
 *          objects (closest first), with null (absent-file) entries filtered
 *          out.  Returns `[]` when no Overview.md is found in any ancestor, or
 *          when `docPath` is outside `workspaceRoot`.
 *
 * @example
 * // Production usage (main process)
 * import { promises as nodefs } from 'node:fs';
 * const maps = await collectOverviewMaps(
 *   '/workspace/project/docs/report.md',
 *   '/workspace/project',
 *   nodefs,
 * );
 * // maps[0] = Overview.md from docs/ (closest)
 * // maps[1] = Overview.md from project/ (workspace root)
 *
 * @example
 * // Test usage with an in-memory stub
 * const stub: FsReader = {
 *   readFile: async (p, _enc) => {
 *     const table: Record<string, string> = {
 *       '/ws/sub/Overview.md': 'tone: formal',
 *       '/ws/Overview.md': 'purpose: report',
 *     };
 *     const content = table[p];
 *     if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
 *     return content;
 *   },
 * };
 * const maps = await collectOverviewMaps('/ws/sub/doc.md', '/ws', stub);
 * // maps.length === 2, maps[0].fields.tone === 'formal'
 */
export async function collectOverviewMaps(
  docPath: string,
  workspaceRoot: string,
  fs: FsReader,
): Promise<OverviewMap[]> {
  // ── Normalise both paths so comparisons are reliable regardless of
  //    trailing slashes or mixed separators.
  const normalizedRoot = path.resolve(workspaceRoot);
  const normalizedFile = path.resolve(docPath);
  let currentDir = path.dirname(normalizedFile);

  // ── Guard: if the document lives outside the workspace, return nothing.
  //    Check both "inside with separator" and "is exactly the root" to avoid
  //    false positives like root=/a matching currentDir=/ab.
  const insideWorkspace =
    currentDir === normalizedRoot ||
    currentDir.startsWith(normalizedRoot + path.sep);

  if (!insideWorkspace) {
    return [];
  }

  const results: OverviewMap[] = [];

  // ── Ancestor traversal (mirrors findOverviewChain from overview-traversal.ts)
  //    Walk from the document's directory toward the workspace root, calling
  //    readOverviewAt at each level.  The reader returns null for absent files,
  //    which we silently skip.
  while (true) {
    const map = await readOverviewAt(currentDir, fs);
    if (map !== null) {
      results.push(map);
    }

    // Stop after processing the workspace root — never go higher.
    if (currentDir === normalizedRoot) break;

    const parent = path.dirname(currentDir);

    // Safety valve: stop if dirname() returns the same path (filesystem root).
    if (parent === currentDir) break;

    currentDir = parent;
  }

  return results;
}
