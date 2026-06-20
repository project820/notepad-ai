// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { createPreview } from '../preview';
import { htmlToMarkdown } from '../html-to-md';
import {
  computePreviewHighlightTargets,
  applyPreviewHighlight,
  clearPreviewHighlight,
  previewNodeToLineRange,
  unionLineRange,
  lineRangeToLines,
  createSelectionSync,
  PREVIEW_SYNC_CLASS,
  SYNC_HIGHLIGHT_CAP,
  type EditorHighlightTarget,
} from '../selection-sync';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { selectionHighlightField, setHighlightedLines, clearHighlight } from '../cm-selection-highlight';

afterEach(() => {
  document.body.innerHTML = '';
});

function mountPreview() {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  return createPreview(parent);
}

// 1:# Title  2:(blank)  3:para one  4:(blank)  5:- a  6:- b  7:(blank)  8:> quote
// → top-level: {0,[1,1]} h1, {1,[3,3]} p, {2,[5,7]} ul, {3,[8,8]} blockquote
// → nested: li [5,5], li [6,7]; the lone blockquote paragraph stays the bq unit.
const DOC = ['# Title', '', 'para one', '', '- a', '- b', '', '> quote'].join('\n');

/** Highlighted preview elements as [tag, data-src-start, data-src-end], in
 *  document order — works for top-level blocks AND nested sub-blocks. */
function highlightedSpans(root: Element): Array<[string, string | null, string | null]> {
  return Array.from(root.querySelectorAll('.' + PREVIEW_SYNC_CLASS)).map((el) => [
    el.tagName.toLowerCase(),
    el.getAttribute('data-src-start'),
    el.getAttribute('data-src-end'),
  ]);
}

/** Render target elements as [tag, start, end] tuples for readable assertions. */
function highlightSpansOf(els: Element[]): Array<[string, string | null, string | null]> {
  return els.map((el) => [el.tagName.toLowerCase(), el.getAttribute('data-src-start'), el.getAttribute('data-src-end')]);
}

function fakeEditor() {
  const setCalls: number[][] = [];
  let clears = 0;
  const target: EditorHighlightTarget = {
    setHighlightedLines: (lines) => setCalls.push([...lines]),
    clearHighlight: () => {
      clears += 1;
    },
  };
  return { target, setCalls, getClears: () => clears };
}

/** Minimal Selection stub — only the fields the wiring reads. */
function fakeSelection(anchorNode: Node | null, focusNode: Node | null, collapsed: boolean): Selection {
  return {
    rangeCount: anchorNode ? 1 : 0,
    isCollapsed: collapsed,
    anchorNode,
    focusNode,
  } as unknown as Selection;
}

describe('computePreviewHighlightTargets — finest tagged elements in a span', () => {
  it('lights only the intersecting list item(s), never the whole list', () => {
    const preview = mountPreview();
    preview.setDoc(DOC);

    // A single line inside the list → just that <li>.
    const one = computePreviewHighlightTargets(preview.el, { fromLine: 5, toLine: 5 });
    expect(one.map((e) => e.tagName.toLowerCase())).toEqual(['li']);
    expect(one[0].getAttribute('data-src-start')).toBe('5');

    // A span crossing both items → both <li>, still not the enclosing <ul>.
    const both = computePreviewHighlightTargets(preview.el, { fromLine: 5, toLine: 6 });
    expect(both.map((e) => e.tagName.toLowerCase())).toEqual(['li', 'li']);
  });

  it('returns a paragraph / heading / blockquote whole (no finer tagged child)', () => {
    const preview = mountPreview();
    preview.setDoc(DOC);
    expect(computePreviewHighlightTargets(preview.el, { fromLine: 3, toLine: 3 }).map((e) => e.tagName.toLowerCase())).toEqual(['p']);
    expect(computePreviewHighlightTargets(preview.el, { fromLine: 1, toLine: 1 }).map((e) => e.tagName.toLowerCase())).toEqual(['h1']);
    // The blockquote's lone paragraph is not tagged → the <blockquote> is the unit.
    expect(computePreviewHighlightTargets(preview.el, { fromLine: 8, toLine: 8 }).map((e) => e.tagName.toLowerCase())).toEqual(['blockquote']);
  });

  it('mixes whole blocks and sub-blocks across a multi-block span', () => {
    const preview = mountPreview();
    preview.setDoc(DOC);
    // 3..8 covers the paragraph, both list items and the blockquote — the <ul>
    // wrapper is dropped in favour of its leaf <li> children.
    expect(highlightSpansOf(computePreviewHighlightTargets(preview.el, { fromLine: 3, toLine: 8 }))).toEqual([
      ['p', '3', '3'],
      ['li', '5', '5'],
      ['li', '6', '7'],
      ['blockquote', '8', '8'],
    ]);
  });

  it('splits a table to the row level and a multi-paragraph block per paragraph', () => {
    const preview = mountPreview();
    // 1:H row 2:sep 3:row a 4:row b  (blank)  6:> p1 7:> (blank) 8:> p2
    preview.setDoc(['| H1 | H2 |', '| -- | -- |', '| a1 | a2 |', '| b1 | b2 |', '', '> p1', '>', '> p2'].join('\n'));

    // Selecting a body row lights that <tr>, not the whole <table>.
    expect(computePreviewHighlightTargets(preview.el, { fromLine: 3, toLine: 3 }).map((e) => e.tagName.toLowerCase())).toEqual(['tr']);
    // A multi-paragraph blockquote splits per paragraph.
    expect(highlightSpansOf(computePreviewHighlightTargets(preview.el, { fromLine: 8, toLine: 8 }))).toEqual([['p', '8', '8']]);
  });

  it('returns [] for a null span and caps a select-all at SYNC_HIGHLIGHT_CAP', () => {
    const preview = mountPreview();
    expect(computePreviewHighlightTargets(preview.el, null)).toEqual([]);

    preview.setDoc(Array.from({ length: 300 }, (_, i) => `para ${i}`).join('\n\n'));
    const all = computePreviewHighlightTargets(preview.el, { fromLine: 1, toLine: 600 });
    expect(all).toHaveLength(SYNC_HIGHLIGHT_CAP);
  });
});

describe('lineRangeToLines / unionLineRange (pure)', () => {
  it('expands an inclusive range, order-agnostic', () => {
    expect(lineRangeToLines({ startLine: 5, endLine: 7 })).toEqual([5, 6, 7]);
    expect(lineRangeToLines({ startLine: 7, endLine: 5 })).toEqual([5, 6, 7]);
    expect(lineRangeToLines(null)).toEqual([]);
  });

  it('caps an enormous range at SYNC_HIGHLIGHT_CAP lines', () => {
    expect(lineRangeToLines({ startLine: 1, endLine: 5000 })).toHaveLength(SYNC_HIGHLIGHT_CAP);
  });

  it('unions two ranges, tolerating nulls', () => {
    expect(unionLineRange({ startLine: 3, endLine: 3 }, { startLine: 8, endLine: 8 })).toEqual({
      startLine: 3,
      endLine: 8,
    });
    expect(unionLineRange(null, { startLine: 8, endLine: 8 })).toEqual({ startLine: 8, endLine: 8 });
    expect(unionLineRange({ startLine: 2, endLine: 4 }, null)).toEqual({ startLine: 2, endLine: 4 });
    expect(unionLineRange(null, null)).toBeNull();
  });
});

describe('applyPreviewHighlight / clearPreviewHighlight — DOM reconcile (diff)', () => {
  it('marks exactly the targeted elements and diffs away the rest on the next apply', () => {
    const preview = mountPreview();
    preview.setDoc(DOC);
    const p = preview.el.children[1]; // <p> [3,3]
    const ul = preview.el.children[2]; // <ul> [5,7]
    const liA = ul.children[0]; // <li> [5,5]

    applyPreviewHighlight(preview.el, [p, liA]);
    expect(highlightedSpans(preview.el)).toEqual([
      ['p', '3', '3'],
      ['li', '5', '5'],
    ]);

    // Re-apply a different target set: previously-lit elements lose the class.
    applyPreviewHighlight(preview.el, [ul]);
    expect(highlightedSpans(preview.el)).toEqual([['ul', '5', '7']]);

    // Empty set clears everything.
    applyPreviewHighlight(preview.el, []);
    expect(highlightedSpans(preview.el)).toEqual([]);
  });

  it('clearPreviewHighlight strips the class from every element (nested included)', () => {
    const preview = mountPreview();
    preview.setDoc(DOC);
    applyPreviewHighlight(preview.el, Array.from(preview.el.querySelectorAll('[data-src-start]')));
    expect(highlightedSpans(preview.el).length).toBeGreaterThan(0);
    clearPreviewHighlight(preview.el);
    expect(highlightedSpans(preview.el)).toEqual([]);
  });
});

describe('previewNodeToLineRange — nearest tagged element (nested or top-level)', () => {
  it('resolves to the finest enclosing tagged sub-block', () => {
    const preview = mountPreview();
    preview.setDoc(DOC);
    // A node inside the first list item now resolves to that <li> ([5,5]), not the
    // whole <ul> ([5,7]) — the finer granularity selection sync relies on.
    const li = preview.el.querySelector('li')!;
    const textInLi = li.firstChild ?? li;
    expect(previewNodeToLineRange(textInLi, preview.el)).toEqual({ startLine: 5, endLine: 5 });

    // The blockquote has no finer tagged child → it stays the unit.
    const bq = preview.el.querySelector('blockquote')!;
    expect(previewNodeToLineRange(bq, preview.el)).toEqual({ startLine: 8, endLine: 8 });
  });

  it('returns null at/above the preview root or for a null node', () => {
    const preview = mountPreview();
    preview.setDoc(DOC);
    expect(previewNodeToLineRange(preview.el, preview.el)).toBeNull();
    expect(previewNodeToLineRange(null, preview.el)).toBeNull();
  });
});

describe('createSelectionSync — editor → preview', () => {
  it('highlights the finest covered sub-blocks, clears its own editor highlight, and reacts to the gate', () => {
    const preview = mountPreview();
    preview.setDoc(DOC);
    const ed = fakeEditor();
    let active = true;
    const sync = createSelectionSync({
      getPreviewRoot: () => preview.el,
      editor: ed.target,
      isActive: () => active,
      getSelection: () => null,
    });

    // Lines 3..6 → paragraph (whole) + both list items (not the <ul> wrapper).
    sync.syncEditorToPreview({ fromLine: 3, toLine: 6 });
    expect(highlightedSpans(preview.el)).toEqual([
      ['p', '3', '3'],
      ['li', '5', '5'],
      ['li', '6', '7'],
    ]);
    // Editor is the source → its own (preview-driven) highlight is dropped.
    expect(ed.getClears()).toBeGreaterThan(0);
    // Editor → preview never sets editor line highlights.
    expect(ed.setCalls).toEqual([]);

    // Selecting a single list line lights only that <li>, never the whole list.
    sync.syncEditorToPreview({ fromLine: 5, toLine: 5 });
    expect(highlightedSpans(preview.el)).toEqual([['li', '5', '5']]);

    // Empty selection clears the preview highlight.
    sync.syncEditorToPreview(null);
    expect(highlightedSpans(preview.el)).toEqual([]);

    // Whole-doc selection: leaf blocks only (ul replaced by its li children).
    sync.syncEditorToPreview({ fromLine: 1, toLine: 8 });
    expect(highlightedSpans(preview.el)).toEqual([
      ['h1', '1', '1'],
      ['p', '3', '3'],
      ['li', '5', '5'],
      ['li', '6', '7'],
      ['blockquote', '8', '8'],
    ]);

    // When inactive (non-split / converted HTML), any selection clears.
    active = false;
    sync.syncEditorToPreview({ fromLine: 1, toLine: 8 });
    expect(highlightedSpans(preview.el)).toEqual([]);
  });
});

describe('createSelectionSync — preview → editor', () => {
  it('highlights the editor lines for the selected sub-block(s)', () => {
    const preview = mountPreview();
    preview.setDoc(DOC);
    const ed = fakeEditor();
    let sel: Selection | null = null;
    const sync = createSelectionSync({
      getPreviewRoot: () => preview.el,
      editor: ed.target,
      isActive: () => true,
      getSelection: () => sel,
    });

    // Selection inside the second list item (line 6, span [6,7]).
    const secondLi = preview.el.querySelectorAll('li')[1];
    sel = fakeSelection(secondLi, secondLi, false);
    sync.syncPreviewToEditor();
    expect(ed.setCalls.at(-1)).toEqual([6, 7]);

    // Drag spanning the para (line 3) through the blockquote (line 8) → union.
    const para = preview.el.children[1]; // top-level <p> "para one"
    const bq = preview.el.querySelector('blockquote')!;
    sel = fakeSelection(para, bq, false);
    sync.syncPreviewToEditor();
    expect(ed.setCalls.at(-1)).toEqual([3, 4, 5, 6, 7, 8]);
  });

  it('clears (no set) for a collapsed caret in the preview', () => {
    const preview = mountPreview();
    preview.setDoc(DOC);
    const ed = fakeEditor();
    const bq = preview.el.querySelector('blockquote')!;
    const sync = createSelectionSync({
      getPreviewRoot: () => preview.el,
      editor: ed.target,
      isActive: () => true,
      getSelection: () => fakeSelection(bq, bq, true),
    });

    sync.syncPreviewToEditor();
    expect(ed.setCalls).toEqual([]);
    expect(ed.getClears()).toBeGreaterThan(0);
  });

  it('clears the editor highlight when inactive but the selection is in the preview', () => {
    const preview = mountPreview();
    preview.setDoc(DOC);
    const ed = fakeEditor();
    const bq = preview.el.querySelector('blockquote')!;
    applyPreviewHighlight(preview.el, [preview.el.children[0]]); // pretend an editor-driven highlight exists
    const sync = createSelectionSync({
      getPreviewRoot: () => preview.el,
      editor: ed.target,
      isActive: () => false,
      getSelection: () => fakeSelection(bq, bq, false),
    });

    sync.syncPreviewToEditor();
    expect(ed.setCalls).toEqual([]);
    expect(ed.getClears()).toBeGreaterThan(0);
    // Preview is the active source → its editor-origin block highlight is dropped.
    expect(highlightedSpans(preview.el)).toEqual([]);
  });

  it('ignores selections that live outside the preview pane', () => {
    const preview = mountPreview();
    preview.setDoc(DOC);
    const ed = fakeEditor();
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    const sync = createSelectionSync({
      getPreviewRoot: () => preview.el,
      editor: ed.target,
      isActive: () => true,
      getSelection: () => fakeSelection(outside, outside, false),
    });

    sync.syncPreviewToEditor();
    expect(ed.setCalls).toEqual([]);
    expect(ed.getClears()).toBe(0); // pure no-op, not even a clear
  });
});

describe('clearAll + Turndown isolation', () => {
  it('clearAll drops both directions', () => {
    const preview = mountPreview();
    preview.setDoc(DOC);
    const ed = fakeEditor();
    const sync = createSelectionSync({
      getPreviewRoot: () => preview.el,
      editor: ed.target,
      isActive: () => true,
      getSelection: () => null,
    });
    applyPreviewHighlight(preview.el, Array.from(preview.el.querySelectorAll('[data-src-start]')));
    sync.clearAll();
    expect(highlightedSpans(preview.el)).toEqual([]);
    expect(ed.getClears()).toBeGreaterThan(0);
  });

  it('the highlight class never leaks into the saved markdown (nested included)', () => {
    const preview = mountPreview();
    preview.setDoc(DOC);
    applyPreviewHighlight(preview.el, Array.from(preview.el.querySelectorAll('[data-src-start]')));

    const out = htmlToMarkdown(preview.el.innerHTML);
    expect(out).not.toMatch(/preview-sync-highlight/);
    expect(out).not.toMatch(/class=/);
    expect(out).not.toMatch(/data-src/);
    // Content still round-trips.
    expect(out).toContain('# Title');
    expect(out).toContain('para one');
    expect(out).toContain('> quote');
  });
});

describe('cm-selection-highlight — CM6 line-decoration field (runtime)', () => {
  it('sets, dedups/clamps, and clears highlighted lines without mutating the doc', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const doc = 'one\ntwo\nthree\nfour\nfive';
    const state = EditorState.create({ doc, extensions: [selectionHighlightField] });
    const view = new EditorView({ state, parent });
    const size = () => view.state.field(selectionHighlightField, false)?.size ?? -1;

    expect(size()).toBe(0);

    setHighlightedLines(view, [2, 4]);
    expect(size()).toBe(2);

    // Duplicates and out-of-range lines are filtered to the single valid line 3.
    setHighlightedLines(view, [3, 3, 99, 0, -1]);
    expect(size()).toBe(1);

    clearHighlight(view);
    expect(size()).toBe(0);
    // No-op clear when already empty must not throw.
    clearHighlight(view);
    expect(size()).toBe(0);

    // The highlight is display-only: it never altered the document text.
    expect(view.state.doc.toString()).toBe(doc);

    view.destroy();
  });
});
