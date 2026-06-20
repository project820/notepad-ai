import { StateEffect, StateField, RangeSetBuilder, type EditorState } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';

/**
 * Raw line alignment for split view (G005 — Line alignment B).
 *
 * Inserts vertical block-widget *spacers* in front of selected source lines so
 * the raw-markdown editor's blocks line up vertically with the matching rendered
 * preview blocks (built on top of the G003 source↔preview map; the same map A /
 * selection-sync consumes). The spacers are **display-only**:
 *
 *  - They are CM block widgets, never document text — so they never enter the
 *    undo history and never affect the saved markdown (Turndown / the editor doc
 *    never see them).
 *  - The held set is rebuilt wholesale on every {@link setLineSpacers} call and
 *    dropped automatically on any document edit (the line numbers go stale),
 *    leaving the wiring to recompute it.
 *
 * Heights are clamped here defensively (negative → 0, capped at
 * {@link MAX_SPACER_PX}); the geometry itself is decided by the pure
 * {@link computeLineAlignmentSpacers} helper so it can be unit-tested without a
 * DOM or a live CodeMirror view.
 */

/** Absolute per-spacer height cap (px). Guards against pathological geometry. */
export const MAX_SPACER_PX = 4000;

/** A spacer to insert before a 1-based source `line`, `heightPx` tall. */
export type LineSpacer = { line: number; heightPx: number };

/** One block measured in BOTH panes at their natural (spacer-free) positions. */
export type LineAlignmentBlock = {
  /** 1-based source line the block starts on (editor spacer inserted before it). */
  line: number;
  /** The preview block's `data-map-id` (preview spacer is inserted before it). */
  mapId: number;
  /**
   * Top of the rendered preview block in the preview pane's content space
   * (block rect top − preview-scroller rect top + preview scrollTop) — the
   * block's absolute offset within the scrollable content, scroll-invariant.
   */
  previewTop: number;
  /**
   * Top of this block's editor line in the editor pane's content space, measured
   * WITHOUT spacers (its natural position). Use the CM6 height map
   * (`view.lineBlockAt(pos).top`) so off-screen lines are measurable too.
   */
  editorTop: number;
};

/** A display-only spacer for a preview block, keyed by its `data-map-id`. */
export type PreviewSpacer = { mapId: number; heightPx: number };

/** The spacers that align both panes block-for-block. */
export type AlignmentResult = {
  editorSpacers: LineSpacer[];
  previewSpacers: PreviewSpacer[];
};

function clampCap(v: number | undefined): number {
  if (v == null || !Number.isFinite(v) || v <= 0) return MAX_SPACER_PX;
  return Math.min(v, MAX_SPACER_PX);
}

/**
 * Pure: compute the spacers that align each block's top in BOTH panes
 * (bidirectional). Because raw editor text height can't be removed, alignment is
 * achieved by only ADDING space: for each block the taller pane stays put and the
 * shorter pane gets a spacer down to it. Running accumulators (`eAcc`, `pAcc`)
 * track the space already added above the current block in each pane, so the
 * comparison is done in the post-spacer coordinate space and every block's top
 * ends up at `max(editorTop+eAcc, previewTop+pAcc)` in both panes.
 *
 * Each block contributes a spacer to AT MOST one pane (the shorter one); the
 * other gets 0. The first block participates like any other, absorbing the
 * per-pane origin/padding difference. Each add is clamped to `[0, maxSpacerPx]`;
 * zero adds are omitted. Tops MUST be same-origin content-space values per pane.
 *
 * No DOM.
 */
export function computeBidirectionalAlignment(
  blocks: readonly LineAlignmentBlock[],
  maxSpacerPx: number = MAX_SPACER_PX,
): AlignmentResult {
  const cap = clampCap(maxSpacerPx);
  const editorSpacers: LineSpacer[] = [];
  const previewSpacers: PreviewSpacer[] = [];
  let eAcc = 0; // space already added above the current block in the editor
  let pAcc = 0; // space already added above the current block in the preview
  for (const b of blocks) {
    if (!Number.isInteger(b.line) || b.line < 1) continue;
    if (!Number.isInteger(b.mapId)) continue;
    if (!Number.isFinite(b.editorTop) || !Number.isFinite(b.previewTop)) continue;
    const eCur = b.editorTop + eAcc;
    const pCur = b.previewTop + pAcc;
    const aligned = Math.max(eCur, pCur);
    let eAdd = aligned - eCur; // >= 0
    let pAdd = aligned - pCur; // >= 0
    if (eAdd > cap) eAdd = cap;
    if (pAdd > cap) pAdd = cap;
    if (eAdd > 0) {
      editorSpacers.push({ line: b.line, heightPx: eAdd });
      eAcc += eAdd;
    }
    if (pAdd > 0) {
      previewSpacers.push({ mapId: b.mapId, heightPx: pAdd });
      pAcc += pAdd;
    }
  }
  return { editorSpacers, previewSpacers };
}

/** Block widget that occupies a fixed vertical gap and nothing else. */
class SpacerWidget extends WidgetType {
  constructor(readonly heightPx: number) {
    super();
  }
  eq(other: SpacerWidget) {
    return other.heightPx === this.heightPx;
  }
  toDOM() {
    const el = document.createElement('div');
    el.className = 'cm-line-align-spacer';
    el.style.height = `${this.heightPx}px`;
    el.setAttribute('aria-hidden', 'true');
    el.contentEditable = 'false';
    return el;
  }
  get estimatedHeight() {
    return this.heightPx;
  }
  ignoreEvent() {
    return false;
  }
}

/** Effect carrying the new spacer set (empty clears). */
const setSpacersEffect = StateEffect.define<LineSpacer[]>();

function buildSpacerDecorations(state: EditorState, spacers: readonly LineSpacer[]): DecorationSet {
  if (spacers.length === 0) return Decoration.none;
  const total = state.doc.lines;
  // Dedupe by line (last wins) while clamping heights — negative → 0, capped.
  const byLine = new Map<number, number>();
  for (const s of spacers) {
    if (!Number.isInteger(s.line) || s.line < 1 || s.line > total) continue;
    let h = Number.isFinite(s.heightPx) ? s.heightPx : 0;
    if (h < 0) h = 0;
    if (h > MAX_SPACER_PX) h = MAX_SPACER_PX;
    if (h <= 0) continue; // no point inserting an empty widget
    byLine.set(s.line, h);
  }
  if (byLine.size === 0) return Decoration.none;
  const lines = Array.from(byLine.keys()).sort((a, b) => a - b);
  const builder = new RangeSetBuilder<Decoration>();
  for (const lineNo of lines) {
    const line = state.doc.line(lineNo);
    builder.add(
      line.from,
      line.from,
      Decoration.widget({ widget: new SpacerWidget(byLine.get(lineNo)!), side: -1, block: true }),
    );
  }
  return builder.finish();
}

const spacerField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setSpacersEffect)) {
        return buildSpacerDecorations(tr.state, effect.value);
      }
    }
    // A document edit shifts line positions: map the held spacer widgets through
    // the change so the established vertical geometry travels WITH the text instead
    // of collapsing on the first keystroke (which jerks the text up until the
    // debounced realignment runs). The next measurement cleanly replaces them.
    if (tr.docChanged) return deco.map(tr.changes);
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Extension enabling {@link setLineSpacers} / {@link clearLineSpacers}. */
export const lineAlignmentField = spacerField;

/** Replace the held spacers with `spacers` (heights clamped; empty clears). */
export function setLineSpacers(view: EditorView, spacers: readonly LineSpacer[]): void {
  view.dispatch({ effects: setSpacersEffect.of([...spacers]) });
}

/** Remove every spacer (no-op when none are present). */
export function clearLineSpacers(view: EditorView): void {
  const current = view.state.field(spacerField, false);
  if (current && current.size > 0) {
    view.dispatch({ effects: setSpacersEffect.of([]) });
  }
}
