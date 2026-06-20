import { previewElementToLineRange, SRC_START_ATTR } from './source-preview-map';

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
 * Collect the *finest* tagged preview elements whose source range intersects the
 * editor selection `span`. "Finest" means leaf elements: when a tagged block has
 * a tagged descendant that also intersects, only the descendant is returned — so
 * selecting one list item lights that `<li>`, not the whole `<ul>`. A block with
 * no finer tagged child (a paragraph, a heading) is returned whole. Document
 * order, capped at {@link SYNC_HIGHLIGHT_CAP}. Reads the DOM but stays framework-
 * free (testable under happy-dom).
 */
export function computePreviewHighlightTargets(previewRoot: Element, span: LineSpan | null): Element[] {
  if (!span) return [];
  const lo = Math.min(span.fromLine, span.toLine);
  const hi = Math.max(span.fromLine, span.toLine);
  const hits: Element[] = [];
  for (const el of Array.from(previewRoot.querySelectorAll('[' + SRC_START_ATTR + ']'))) {
    const r = previewElementToLineRange(el);
    if (!r) continue;
    const s = Math.min(r.startLine, r.endLine);
    const e = Math.max(r.startLine, r.endLine);
    if (e < lo || s > hi) continue; // disjoint from the selection
    hits.push(el);
  }
  // `querySelectorAll` yields preorder (document) order, so any tagged descendant
  // of `hits[i]` is the very next hit — keep an element only when it has no such
  // descendant in the set. O(n), and the cap bounds a select-all.
  const leaves: Element[] = [];
  for (let i = 0; i < hits.length; i++) {
    const next = hits[i + 1];
    if (next && hits[i].contains(next)) continue; // has a finer hit inside → not a leaf
    leaves.push(hits[i]);
    if (leaves.length >= SYNC_HIGHLIGHT_CAP) break;
  }
  return leaves;
}

/**
 * Reconcile {@link PREVIEW_SYNC_CLASS} so that exactly the elements in `targets`
 * carry it — elements no longer targeted lose the class. Idempotent. `targets`
 * may be top-level blocks or nested sub-blocks (list items, table rows).
 */
export function applyPreviewHighlight(previewRoot: Element, targets: Iterable<Element>): void {
  const want = new Set(targets);
  for (const el of Array.from(previewRoot.querySelectorAll('.' + PREVIEW_SYNC_CLASS))) {
    if (!want.has(el)) el.classList.remove(PREVIEW_SYNC_CLASS);
  }
  for (const el of want) el.classList.add(PREVIEW_SYNC_CLASS);
}

/** Remove {@link PREVIEW_SYNC_CLASS} from every preview block carrying it. */
export function clearPreviewHighlight(previewRoot: Element): void {
  previewRoot.querySelectorAll('.' + PREVIEW_SYNC_CLASS).forEach((el) => el.classList.remove(PREVIEW_SYNC_CLASS));
}

/**
 * Walk up from `node` to the nearest preview element carrying a source range
 * (a nested sub-block or, failing that, the top-level block), stopping at
 * `previewRoot`, and return its 1-based inclusive line range.
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
    applyPreviewHighlight(root, computePreviewHighlightTargets(root, span));
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
