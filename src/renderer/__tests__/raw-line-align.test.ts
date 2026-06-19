// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undo } from '@codemirror/commands';
import {
  computeLineAlignmentSpacers,
  setLineSpacers,
  clearLineSpacers,
  lineAlignmentField,
  MAX_SPACER_PX,
} from '../cm-line-alignment';

describe('computeLineAlignmentSpacers — pure spacer geometry (no DOM)', () => {
  it('returns an empty list for empty input (map absent / no blocks)', () => {
    expect(computeLineAlignmentSpacers({ blocks: [] })).toEqual([]);
  });

  it('adds the gap as a spacer when the editor block sits above its preview block', () => {
    // Block 1 anchors at 0/0 (no spacer); block 2 needs preview-editor = 100.
    expect(
      computeLineAlignmentSpacers({
        blocks: [
          { line: 1, previewTop: 0, editorTop: 0 },
          { line: 5, previewTop: 100, editorTop: 0 },
        ],
      }),
    ).toEqual([{ line: 5, heightPx: 100 }]);
  });

  it('clamps a negative gap to 0 (no compression) and emits no spacer', () => {
    // Editor line already sits below the preview block → would need negative space.
    expect(
      computeLineAlignmentSpacers({ blocks: [{ line: 3, previewTop: 10, editorTop: 60 }] }),
    ).toEqual([]);
  });

  it('keeps the cumulative offset monotonic — never compresses a later block', () => {
    const out = computeLineAlignmentSpacers({
      blocks: [
        { line: 1, previewTop: 0, editorTop: 0 }, // anchor → 0
        { line: 4, previewTop: 120, editorTop: 0 }, // wants cumulative 120 → +120
        { line: 8, previewTop: 60, editorTop: 40 }, // wants cumulative 20 < 120 → +0 (skip)
        { line: 12, previewTop: 300, editorTop: 40 }, // wants cumulative 260 > 120 → +140
      ],
    });
    expect(out).toEqual([
      { line: 4, heightPx: 120 },
      { line: 12, heightPx: 140 },
    ]);
    // Every emitted height is strictly positive and the running total only grows.
    let running = 0;
    for (const s of out) {
      expect(s.heightPx).toBeGreaterThan(0);
      running += s.heightPx;
    }
    expect(running).toBe(260);
  });

  it('caps each spacer at the supplied maxSpacerPx', () => {
    expect(
      computeLineAlignmentSpacers({
        blocks: [{ line: 2, previewTop: 100000, editorTop: 0 }],
        maxSpacerPx: 500,
      }),
    ).toEqual([{ line: 2, heightPx: 500 }]);
  });

  it('never lets maxSpacerPx exceed the absolute MAX_SPACER_PX cap', () => {
    const out = computeLineAlignmentSpacers({
      blocks: [{ line: 2, previewTop: 1e9, editorTop: 0 }],
      maxSpacerPx: 1e9,
    });
    expect(out[0].heightPx).toBe(MAX_SPACER_PX);
  });

  it('skips blocks with invalid line numbers or non-finite tops', () => {
    expect(
      computeLineAlignmentSpacers({
        blocks: [
          { line: 0, previewTop: 0, editorTop: 0 }, // invalid line
          { line: 2, previewTop: NaN, editorTop: 0 }, // non-finite top
          { line: 3, previewTop: 50, editorTop: 0 }, // valid → +50
        ],
      }),
    ).toEqual([{ line: 3, heightPx: 50 }]);
  });
});

const DOC = ['line 1', 'line 2', 'line 3', 'line 4'].join('\n');

function mountEditor(doc: string, extra: Extension[] = []): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const state = EditorState.create({ doc, extensions: [lineAlignmentField, ...extra] });
  return new EditorView({ state, parent });
}

/** Spacer heights held by the field, in document (position) order. */
function spacerHeights(view: EditorView): number[] {
  const out: number[] = [];
  const cursor = view.state.field(lineAlignmentField).iter();
  while (cursor.value) {
    out.push((cursor.value as { spec: { widget: { heightPx: number } } }).spec.widget.heightPx);
    cursor.next();
  }
  return out;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('setLineSpacers / clearLineSpacers — CM block-widget spacers', () => {
  it('inserts spacer widgets in line order without mutating the document text', () => {
    const view = mountEditor(DOC);
    setLineSpacers(view, [
      { line: 4, heightPx: 24 },
      { line: 2, heightPx: 40 },
    ]);
    expect(view.state.field(lineAlignmentField).size).toBe(2);
    expect(spacerHeights(view)).toEqual([40, 24]); // sorted by source position
    expect(view.state.doc.toString()).toBe(DOC); // display-only: doc untouched
    view.destroy();
  });

  it('clamps negative heights to 0 (dropped) and caps oversized heights', () => {
    const view = mountEditor(DOC);
    setLineSpacers(view, [
      { line: 1, heightPx: -50 }, // negative → dropped
      { line: 2, heightPx: MAX_SPACER_PX * 4 }, // over cap → clamped
    ]);
    expect(spacerHeights(view)).toEqual([MAX_SPACER_PX]);
    view.destroy();
  });

  it('clearLineSpacers removes every spacer', () => {
    const view = mountEditor(DOC);
    setLineSpacers(view, [{ line: 2, heightPx: 40 }]);
    expect(view.state.field(lineAlignmentField).size).toBe(1);
    clearLineSpacers(view);
    expect(view.state.field(lineAlignmentField).size).toBe(0);
    view.destroy();
  });

  it('drops spacers on a document edit (held line numbers go stale)', () => {
    const view = mountEditor(DOC);
    setLineSpacers(view, [{ line: 3, heightPx: 30 }]);
    expect(view.state.field(lineAlignmentField).size).toBe(1);
    view.dispatch({ changes: { from: 0, insert: 'x' } });
    expect(view.state.field(lineAlignmentField).size).toBe(0);
    view.destroy();
  });

  it('ignores out-of-range line numbers', () => {
    const view = mountEditor(DOC);
    setLineSpacers(view, [{ line: 999, heightPx: 30 }]);
    expect(view.state.field(lineAlignmentField).size).toBe(0);
    view.destroy();
  });

  it('a spacer dispatch is display-only — nothing enters the undo history', () => {
    const view = mountEditor(DOC, [history()]);
    setLineSpacers(view, [{ line: 2, heightPx: 40 }]);
    expect(undo(view)).toBe(false); // empty undo stack: the spacer added no doc step
    expect(view.state.doc.toString()).toBe(DOC);
    view.destroy();
  });
});
