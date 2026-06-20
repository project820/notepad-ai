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

/** One preview↔editor block measurement fed to {@link computeLineAlignmentSpacers}. */
export type LineAlignmentBlock = {
  /** 1-based source line the block starts on (the spacer is inserted before it). */
  line: number;
  /**
   * Top of the rendered preview block in the preview pane's **content space**
   * (block rect top − preview-scroller rect top + preview scrollTop), so it is
   * the block's absolute offset within the scrollable content — scroll-invariant.
   */
  previewTop: number;
  /**
   * Top of this block's editor line in the editor pane's content space
   * (line coords top − cm-scroller rect top + cm scrollTop), measured WITHOUT
   * spacers (its natural position). Same per-pane content-space convention as
   * `previewTop`, so the difference `previewTop − editorTop` is a real gap.
   */
  editorTop: number;
};

export type LineAlignmentInput = {
  blocks: readonly LineAlignmentBlock[];
  /** Per-spacer height cap (px). Clamped to {@link MAX_SPACER_PX}. */
  maxSpacerPx?: number;
};

function clampCap(v: number | undefined): number {
  if (v == null || !Number.isFinite(v) || v <= 0) return MAX_SPACER_PX;
  return Math.min(v, MAX_SPACER_PX);
}

/**
 * Pure: compute the spacer heights that align each editor block top with its
 * preview block top, **without ever compressing** (spacers only add space). The
 * rendered preview is the source of truth; the raw editor is padded down to it.
 *
 * For block `i`, the desired total spacer height above it is
 * `previewTop[i] - editorTop[i]`. Because earlier spacers also push block `i`
 * down, the running accumulator is monotonic non-decreasing: a block that would
 * need *less* cumulative space than already accrued (its editor line already sits
 * past its preview block) gets a 0 spacer, never a negative one. Each individual
 * spacer is clamped to `[0, maxSpacerPx]`. Zero-height spacers are omitted.
 *
 * The FIRST block participates like any other — its `previewTop - editorTop`
 * becomes the first spacer (absorbing the per-pane origin/padding difference), so
 * alignment is correct from the first block. Tops MUST therefore be same-origin
 * content-space values (see {@link LineAlignmentBlock}); do NOT pre-normalize
 * them to the first block, which would force its gap to 0 and leave every block
 * shifted by that error.
 *
 * No DOM.
 */
export function computeLineAlignmentSpacers(input: LineAlignmentInput): LineSpacer[] {
  const blocks = input?.blocks ?? [];
  if (blocks.length === 0) return [];
  const cap = clampCap(input.maxSpacerPx);
  const out: LineSpacer[] = [];
  let running = 0; // cumulative spacer height accrued above the current block
  for (const b of blocks) {
    if (!Number.isInteger(b.line) || b.line < 1) continue;
    if (!Number.isFinite(b.previewTop) || !Number.isFinite(b.editorTop)) continue;
    // Total spacer wanted above this block so its editor line meets the preview top.
    const target = b.previewTop - b.editorTop;
    let add = target - running; // extra beyond what earlier spacers already added
    if (add <= 0) continue; // no compression: negative/zero → skip, running unchanged
    if (add > cap) add = cap;
    running += add;
    out.push({ line: b.line, heightPx: add });
  }
  return out;
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
    // A document edit invalidates the held line numbers; drop the spacers and let
    // the wiring recompute them from the next measurement.
    if (tr.docChanged) return Decoration.none;
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
