import {
  collectPreviewBlocks,
  previewElementToLineRange,
  rangeToLineSpan,
  type SourceLineRange,
} from './source-preview-map';

/**
 * Selection synchronization wiring (G004 — Selection sync A).
 *
 * Pure, DOM-light helpers that link an editor line selection to the preview's
 * rendered blocks and back, on top of the G003 source↔preview map. Highlighting
 * is **display-only**: it toggles CSS classes / CM line decorations and never
 * touches the markdown source, the saved document, or any selection model.
 *
 * Split-view only; the caller gates activation (preview mode + converted-HTML
 * state) and owns the RAF throttling. These functions are deliberately
 * framework-free so they can be unit-tested without Electron or a live
 * CodeMirror view.
 */

/** Class toggled on highlighted preview top-level blocks. Turndown ignores
 *  element classes, so it never leaks into the saved markdown. */
export const PREVIEW_SYNC_CLASS = 'preview-sync-highlight';

/** Upper bound on blocks/lines highlighted at once — guards against a select-all
 *  spanning hundreds of blocks from thrashing the DOM. */
export const SYNC_HIGHLIGHT_CAP = 200;

export type LineSpan = { fromLine: number; toLine: number };
export type LineRange = { startLine: number; endLine: number };

/**
 * Map an editor selection span to the `mapId`s of the preview blocks it covers.
 * Returns the (capped) ids in document order; a null/empty span yields `[]`.
 * Pure — no DOM.
 */
export function computeSyncTargets(map: readonly SourceLineRange[], span: LineSpan | null): number[] {
  if (!span || map.length === 0) return [];
  const ids = rangeToLineSpan(map, span.fromLine, span.toLine).map((r) => r.mapId);
  return ids.length > SYNC_HIGHLIGHT_CAP ? ids.slice(0, SYNC_HIGHLIGHT_CAP) : ids;
}

/**
 * Reconcile {@link PREVIEW_SYNC_CLASS} on the preview's top-level blocks so that
 * exactly the blocks in `mapIds` carry it (diff: blocks no longer targeted lose
 * the class). Idempotent.
 */
export function applyPreviewHighlight(previewRoot: Element, mapIds: readonly number[]): void {
  const want = new Set(mapIds);
  for (const { el, mapId } of collectPreviewBlocks(previewRoot)) {
    el.classList.toggle(PREVIEW_SYNC_CLASS, want.has(mapId));
  }
}

/** Remove {@link PREVIEW_SYNC_CLASS} from every preview block carrying it. */
export function clearPreviewHighlight(previewRoot: Element): void {
  previewRoot.querySelectorAll('.' + PREVIEW_SYNC_CLASS).forEach((el) => el.classList.remove(PREVIEW_SYNC_CLASS));
}

/**
 * Walk up from `node` to the nearest preview top-level block carrying a source
 * range (stopping at `previewRoot`), returning its 1-based inclusive line range.
 */
export function previewNodeToLineRange(node: Node | null, previewRoot: Element): LineRange | null {
  let el: Element | null =
    node == null ? null : node.nodeType === 1 /* ELEMENT_NODE */ ? (node as Element) : node.parentElement;
  while (el && el !== previewRoot) {
    const range = previewElementToLineRange(el);
    if (range) return range;
    el = el.parentElement;
  }
  return null;
}

/** Union two (possibly null) line ranges; null only when both are null. */
export function unionLineRange(a: LineRange | null, b: LineRange | null): LineRange | null {
  if (!a) return b;
  if (!b) return a;
  return { startLine: Math.min(a.startLine, b.startLine), endLine: Math.max(a.endLine, b.endLine) };
}

/** Expand an inclusive line range to an explicit, capped list of 1-based lines. */
export function lineRangeToLines(range: LineRange | null): number[] {
  if (!range) return [];
  const lo = Math.min(range.startLine, range.endLine);
  const hi = Math.max(range.startLine, range.endLine);
  const out: number[] = [];
  for (let n = lo; n <= hi && out.length < SYNC_HIGHLIGHT_CAP; n++) out.push(n);
  return out;
}

/** Minimal editor surface the sync needs — decoupled from the full EditorHandle. */
export type EditorHighlightTarget = {
  setHighlightedLines: (lines: number[]) => void;
  clearHighlight: () => void;
};

export type SelectionSyncDeps = {
  getPreviewRoot: () => Element;
  getSourceMap: () => readonly SourceLineRange[];
  editor: EditorHighlightTarget;
  /** True only in split view with the markdown (not converted-HTML) preview shown. */
  isActive: () => boolean;
  getSelection: () => Selection | null;
};

export type SelectionSync = {
  /** Editor selection changed → highlight covered preview blocks (or clear). */
  syncEditorToPreview: (span: LineSpan | null) => void;
  /** Preview selection changed → highlight covered editor lines (or clear). */
  syncPreviewToEditor: () => void;
  /** Drop every cross-pane highlight (both directions). */
  clearAll: () => void;
};

export function createSelectionSync(deps: SelectionSyncDeps): SelectionSync {
  function clearAll(): void {
    clearPreviewHighlight(deps.getPreviewRoot());
    deps.editor.clearHighlight();
  }

  function syncEditorToPreview(span: LineSpan | null): void {
    const root = deps.getPreviewRoot();
    // The editor is the active source: drop any preview-origin editor highlight.
    deps.editor.clearHighlight();
    if (!deps.isActive()) {
      clearPreviewHighlight(root);
      return;
    }
    applyPreviewHighlight(root, computeSyncTargets(deps.getSourceMap(), span));
  }

  function syncPreviewToEditor(): void {
    const root = deps.getPreviewRoot();
    const sel = deps.getSelection();
    // Only react to selections that live inside the preview pane.
    if (!sel || sel.rangeCount === 0 || !sel.anchorNode || !root.contains(sel.anchorNode)) return;
    // The preview is the active source: drop any editor-origin preview highlight.
    clearPreviewHighlight(root);
    if (!deps.isActive() || sel.isCollapsed) {
      deps.editor.clearHighlight();
      return;
    }
    const range = unionLineRange(
      previewNodeToLineRange(sel.anchorNode, root),
      previewNodeToLineRange(sel.focusNode, root),
    );
    const lines = lineRangeToLines(range);
    if (lines.length > 0) deps.editor.setHighlightedLines(lines);
    else deps.editor.clearHighlight();
  }

  return { syncEditorToPreview, syncPreviewToEditor, clearAll };
}
