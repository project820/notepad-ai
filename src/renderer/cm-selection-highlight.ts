import { StateEffect, StateField, RangeSetBuilder, type EditorState } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view';

/**
 * Display-only line highlighting for selection sync (G004 — Selection sync A).
 *
 * A {@link StateField} holds a set of line decorations (`.cm-sync-highlight`) for
 * a caller-supplied set of 1-based lines. The highlight is purely cosmetic — it
 * carries no document changes, so it never enters the undo history and never
 * affects the editor's own selection or the saved markdown. It is rebuilt
 * wholesale whenever the caller sets new lines, and dropped automatically on any
 * document edit (the held line numbers go stale), leaving the wiring to recompute
 * it from the next selection event.
 */

/** Effect carrying the new set of 1-based lines to highlight (empty clears). */
const setHighlightEffect = StateEffect.define<number[]>();

const lineHighlight = Decoration.line({ class: 'cm-sync-highlight' });

function buildLineDecorations(state: EditorState, lines: number[]): DecorationSet {
  if (lines.length === 0) return Decoration.none;
  const total = state.doc.lines;
  const valid = Array.from(new Set(lines))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= total)
    .sort((a, b) => a - b);
  if (valid.length === 0) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  for (const lineNo of valid) {
    const line = state.doc.line(lineNo);
    builder.add(line.from, line.from, lineHighlight);
  }
  return builder.finish();
}

const highlightField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setHighlightEffect)) {
        return buildLineDecorations(tr.state, effect.value);
      }
    }
    // A document edit invalidates the held line numbers; drop the highlight and
    // let the wiring recompute it from the next selection event.
    if (tr.docChanged) return Decoration.none;
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Extension enabling {@link setHighlightedLines} / {@link clearHighlight}. */
export const selectionHighlightField = highlightField;

/** Highlight exactly `lines` (1-based, deduped/clamped/sorted). Empty clears. */
export function setHighlightedLines(view: EditorView, lines: number[]): void {
  view.dispatch({ effects: setHighlightEffect.of(lines) });
}

/** Remove all sync highlighting (no-op when nothing is highlighted). */
export function clearHighlight(view: EditorView): void {
  const current = view.state.field(highlightField, false);
  if (current && current.size > 0) {
    view.dispatch({ effects: setHighlightEffect.of([]) });
  }
}
