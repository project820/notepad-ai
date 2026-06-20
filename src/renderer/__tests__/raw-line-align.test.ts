// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undo } from '@codemirror/commands';
import {
  computeBidirectionalAlignment,
  setLineSpacers,
  clearLineSpacers,
  lineAlignmentField,
  MAX_SPACER_PX,
  type LineAlignmentBlock,
  type AlignmentResult,
} from '../cm-line-alignment';

/** Resolve the post-spacer top of every block in BOTH panes. A spacer inserted
 *  before block k pushes block k and every later block down by its height. */
function appliedTops(blocks: readonly LineAlignmentBlock[], res: AlignmentResult): Array<{ e: number; p: number }> {
  const eAdd = blocks.map(() => 0);
  const pAdd = blocks.map(() => 0);
  for (const s of res.editorSpacers) {
    const k = blocks.findIndex((b) => b.line === s.line);
    if (k < 0) continue;
    for (let i = k; i < blocks.length; i++) eAdd[i] += s.heightPx;
  }
  for (const s of res.previewSpacers) {
    const k = blocks.findIndex((b) => b.mapId === s.mapId);
    if (k < 0) continue;
    for (let i = k; i < blocks.length; i++) pAdd[i] += s.heightPx;
  }
  return blocks.map((b, i) => ({ e: b.editorTop + eAdd[i], p: b.previewTop + pAdd[i] }));
}

describe('computeBidirectionalAlignment — pure spacer geometry (no DOM)', () => {
  it('returns empty spacer sets for empty input', () => {
    expect(computeBidirectionalAlignment([])).toEqual({ editorSpacers: [], previewSpacers: [] });
  });

  it('pushes the EDITOR down when its block sits above the preview block', () => {
    const blocks: LineAlignmentBlock[] = [
      { line: 1, mapId: 0, previewTop: 0, editorTop: 0 },
      { line: 5, mapId: 1, previewTop: 100, editorTop: 0 },
    ];
    const res = computeBidirectionalAlignment(blocks);
    expect(res.editorSpacers).toEqual([{ line: 5, heightPx: 100 }]);
    expect(res.previewSpacers).toEqual([]);
  });

  it('pushes the PREVIEW down when its block sits above the editor block (regression: not just the first block)', () => {
    // The old one-sided model skipped this — only the first block ever aligned.
    const blocks: LineAlignmentBlock[] = [
      { line: 3, mapId: 7, previewTop: 10, editorTop: 60 },
    ];
    const res = computeBidirectionalAlignment(blocks);
    expect(res.editorSpacers).toEqual([]);
    expect(res.previewSpacers).toEqual([{ mapId: 7, heightPx: 50 }]);
  });

  it('aligns EVERY block top in both panes even when editor height overtakes preview', () => {
    // Exactly the failure the user reported: after block 1, the raw editor
    // accumulates more height than the compact preview (e.g. a table). The old
    // model left every later block unaligned; bidirectional pads the preview.
    const blocks: LineAlignmentBlock[] = [
      { line: 1, mapId: 0, previewTop: 30, editorTop: 8 }, // preview header taller → editor +22
      { line: 2, mapId: 1, previewTop: 70, editorTop: 120 }, // raw table taller → preview catches up
      { line: 8, mapId: 2, previewTop: 110, editorTop: 240 }, // editor keeps running ahead
      { line: 14, mapId: 3, previewTop: 400, editorTop: 300 }, // preview pulls ahead again
    ];
    const res = computeBidirectionalAlignment(blocks);
    const tops = appliedTops(blocks, res);
    // The core invariant the user asked for: all lines aligned to the preview.
    tops.forEach(({ e, p }) => expect(e).toBeCloseTo(p, 6));
    // And both panes only ever grew (every block top >= its natural top).
    blocks.forEach((b, i) => {
      expect(tops[i].e).toBeGreaterThanOrEqual(b.editorTop);
      expect(tops[i].p).toBeGreaterThanOrEqual(b.previewTop);
    });
  });

  it('contributes a spacer to at most one pane per block', () => {
    const blocks: LineAlignmentBlock[] = [
      { line: 1, mapId: 0, previewTop: 0, editorTop: 0 },
      { line: 4, mapId: 1, previewTop: 200, editorTop: 50 },
      { line: 9, mapId: 2, previewTop: 60, editorTop: 400 },
    ];
    const res = computeBidirectionalAlignment(blocks);
    const editorLines = new Set(res.editorSpacers.map((s) => s.line));
    const previewIdx = new Set(res.previewSpacers.map((s) => blocks.findIndex((b) => b.mapId === s.mapId)));
    const editorIdx = new Set([...editorLines].map((line) => blocks.findIndex((b) => b.line === line)));
    // No block index appears in both spacer sets.
    for (const i of editorIdx) expect(previewIdx.has(i)).toBe(false);
  });

  it('caps each spacer at the supplied maxSpacerPx', () => {
    const res = computeBidirectionalAlignment([{ line: 2, mapId: 0, previewTop: 100000, editorTop: 0 }], 500);
    expect(res.editorSpacers).toEqual([{ line: 2, heightPx: 500 }]);
  });

  it('never lets maxSpacerPx exceed the absolute MAX_SPACER_PX cap', () => {
    const res = computeBidirectionalAlignment([{ line: 2, mapId: 0, previewTop: 1e9, editorTop: 0 }], 1e9);
    expect(res.editorSpacers[0].heightPx).toBe(MAX_SPACER_PX);
  });

  it('skips blocks with invalid line numbers, invalid mapIds, or non-finite tops', () => {
    const res = computeBidirectionalAlignment([
      { line: 0, mapId: 0, previewTop: 0, editorTop: 0 }, // invalid line
      { line: 2, mapId: 1.5, previewTop: 0, editorTop: 0 }, // invalid mapId
      { line: 3, mapId: 2, previewTop: NaN, editorTop: 0 }, // non-finite top
      { line: 4, mapId: 3, previewTop: 50, editorTop: 0 }, // valid → editor +50
    ]);
    expect(res.editorSpacers).toEqual([{ line: 4, heightPx: 50 }]);
    expect(res.previewSpacers).toEqual([]);
  });

  it('absorbs the first-block origin/padding difference (first block participates)', () => {
    const blocks: LineAlignmentBlock[] = [{ line: 1, mapId: 0, previewTop: 20, editorTop: 4 }];
    const res = computeBidirectionalAlignment(blocks);
    expect(res.editorSpacers).toEqual([{ line: 1, heightPx: 16 }]);
    const [{ e, p }] = appliedTops(blocks, res);
    expect(e).toBe(p);
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

  it('maps spacers through a document edit so geometry is preserved (no jump on keystroke)', () => {
    const view = mountEditor(DOC);
    setLineSpacers(view, [{ line: 3, heightPx: 30 }]);
    expect(view.state.field(lineAlignmentField).size).toBe(1);
    // A keystroke before the spacer used to collapse it instantly (text jumped up);
    // now the decoration is mapped through the change and survives until the next
    // measurement cleanly replaces it.
    view.dispatch({ changes: { from: 0, insert: 'x' } });
    expect(view.state.field(lineAlignmentField).size).toBe(1);
    // Clearing still removes it, and the edit never entered the document as text.
    clearLineSpacers(view);
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
