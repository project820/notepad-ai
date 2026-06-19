/**
 * overview-resolver.ts
 *
 * v1.1 feature: End-to-end Effective-Overview resolver for the 3-layer prompt system.
 *
 * Composes the traversal-backed OverviewMap collector (Sub-AC 12.3.2 —
 * {@link collectOverviewMaps}) with the cascade merger (AC 12.2 —
 * {@link mergeOverviewMaps}) to produce a single, authoritative
 * {@link OverviewMap} representing the effective context for a given document.
 *
 * This is the **final public entry point** for the Overview layer of the 7-layer
 * prompt stack.  Callers (Block AI, Side Chat, Bottom Chat, Quality Dial) invoke
 * this function once per AI request to obtain the merged context, then inject the
 * result into the prompt stack between the Owner.md layer and the @mention layer.
 *
 * ─── Composition pipeline ────────────────────────────────────────────────────
 *
 *   resolveEffectiveOverview(docPath, workspaceRoot, fs)
 *     │
 *     ├─ collectOverviewMaps(docPath, workspaceRoot, fs)
 *     │    Walks ancestor directories from doc → workspace root.
 *     │    Returns ordered OverviewMap[] (closest first, nulls filtered out).
 *     │
 *     └─ mergeOverviewMaps(maps)
 *          Applies closer-wins conflict-resolution rule.
 *          Returns a single, flat OverviewMap.
 *
 * ─── Design notes ────────────────────────────────────────────────────────────
 *
 * DEPENDENCY INJECTION — Like its constituent parts, this function accepts a
 * {@link FsReader} interface so that callers can inject in-memory stubs in unit
 * tests without touching the real filesystem.  Production callers pass
 * `node:fs/promises`.
 *
 * TOTAL FUNCTION — Never throws under normal operation.  When no Overview.md
 * files exist at any level, `collectOverviewMaps` returns `[]` and
 * `mergeOverviewMaps([])` returns `{ fields: {}, sections: {} }`.  Malformed
 * or empty Overview.md files produce empty-but-valid sub-maps that merge
 * cleanly.
 *
 * ROLLBACK SAFETY — This module is purely additive.  Callers guard invocations
 * behind the `promptLayersEnabled` feature toggle.  When the toggle is OFF the
 * caller never invokes `resolveEffectiveOverview`, so v1.0 behaviour is fully
 * preserved.  Each of the three constituent layers (collector, merger, resolver)
 * is independently disable-able without breaking the others.
 *
 * PROCESS SAFETY — Uses only `node:path` (pure computation) and the injected
 * FsReader.  Safe to use in the Electron main process; also usable in unit
 * tests with in-memory stubs.
 *
 * @module
 */

import { collectOverviewMaps, type FsReader } from './overview-map-collector';
import { mergeOverviewMaps, type OverviewMap } from './overview-parser';

// Re-export FsReader and OverviewMap so callers only need to import from this module.
export type { FsReader, OverviewMap };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolves the **effective Overview context** for a given document by walking
 * the ancestor directory hierarchy, reading each `Overview.md` found, and
 * merging all discovered maps into a single {@link OverviewMap} using the
 * closer-wins cascade rule.
 *
 * This is the top-level composition of Sub-AC 12.3.2 (collector) and AC 12.2
 * (merger) and serves as the canonical entry point for the Overview layer of
 * the 7-layer prompt stack.
 *
 * Merge semantics (closer-wins / child-wins):
 * - When the same field key or section heading appears at multiple levels,
 *   the definition from the directory **closest to the document** wins.
 * - All keys that appear at only one level are included uncontested.
 *
 * This mirrors the Claude Code CLAUDE.md cascade pattern referenced in the
 * v1.1 Seed: a subfolder's `Overview.md` overrides its parent's for the same
 * key while inheriting everything else.
 *
 * Boundary rules (inherited from {@link collectOverviewMaps}):
 *   - Traversal NEVER goes above `workspaceRoot`.
 *   - `workspaceRoot` itself IS checked (inclusive).
 *   - If `docPath` is not inside `workspaceRoot`, the result is an empty map
 *     (`{ fields: {}, sections: {} }`) — no traversal, no crash.
 *   - Absent or unreadable `Overview.md` files are silently skipped.
 *   - Malformed / empty `Overview.md` files produce empty-but-valid sub-maps
 *     (they are included in the merge, but contribute nothing).
 *
 * @param docPath       Absolute path to the document being edited.
 * @param workspaceRoot Absolute path to the workspace/project root directory.
 *                      Traversal stops here (inclusive).
 * @param fs            A {@link FsReader} implementation.  Pass
 *                      `node:fs/promises` in production code, or a stub object
 *                      in unit tests.
 *
 * @returns A Promise that resolves to the merged {@link OverviewMap}.
 *          - Returns `{ fields: {}, sections: {} }` when no `Overview.md`
 *            is found in any ancestor directory.
 *          - Returns the single map verbatim (shallow-copied) when only one
 *            `Overview.md` is present in the hierarchy.
 *          - Returns the cascade-merged map when multiple `Overview.md` files
 *            are present.
 *
 * @example
 * // Production usage (main process)
 * import { promises as nodefs } from 'node:fs';
 * const map = await resolveEffectiveOverview(
 *   '/workspace/project/docs/report.md',
 *   '/workspace/project',
 *   nodefs,
 * );
 * // map.fields.tone     → value from closest Overview.md that defines 'tone'
 * // map.fields.purpose  → value from closest Overview.md that defines 'purpose'
 * // map.sections['Style'] → body from closest Overview.md that defines '## Style'
 *
 * @example
 * // Test usage with an in-memory stub
 * const stub: FsReader = {
 *   readFile: async (p, _enc) => {
 *     const table: Record<string, string> = {
 *       '/ws/docs/Overview.md': 'tone: formal',
 *       '/ws/Overview.md':      'purpose: report\ntone: casual',
 *     };
 *     const content = table[p];
 *     if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
 *     return content;
 *   },
 * };
 * const map = await resolveEffectiveOverview('/ws/docs/report.md', '/ws', stub);
 * // map.fields.tone    === 'formal'   ← docs/ wins over ws/
 * // map.fields.purpose === 'report'   ← inherited from ws/ (uncontested)
 */
export async function resolveEffectiveOverview(
  docPath: string,
  workspaceRoot: string,
  fs: FsReader,
): Promise<OverviewMap> {
  // ── Step 1: Collect all Overview.md maps in the ancestor hierarchy ──────────
  // Returns an ordered array (closest first), with absent files filtered out.
  // Returns [] when docPath is outside workspaceRoot or no files exist.
  const maps = await collectOverviewMaps(docPath, workspaceRoot, fs);

  // ── Step 2: Merge all collected maps via closer-wins cascade ─────────────────
  // mergeOverviewMaps([]) → { fields: {}, sections: {} }  (safe for empty input)
  // mergeOverviewMaps([m]) → shallow copy of m            (single-element passthrough)
  // mergeOverviewMaps([m0, m1, …]) → merged map           (index 0 wins conflicts)
  return mergeOverviewMaps(maps);
}
