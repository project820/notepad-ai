// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { createPreview } from '../preview';
import { htmlToMarkdown } from '../html-to-md';
import {
  computeSyncTargets,
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
import type { SourceLineRange } from '../source-preview-map';
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
// → blocks: {0,[1,1]} h1, {1,[3,3]} p, {2,[5,7]} ul, {3,[8,8]} blockquote
const DOC = ['# Title', '', 'para one', '', '- a', '- b', '', '> quote'].join('\n');

const MAP: SourceLineRange[] = [
  { mapId: 0, startLine: 1, endLine: 1 },
  { mapId: 1, startLine: 3, endLine: 3 },
  { mapId: 2, startLine: 5, endLine: 7 },
  { mapId: 3, startLine: 8, endLine: 8 },
];

/** Highlighted preview blocks, by data-map-id, in document order. */
function highlightedIds(root: Element): string[] {
  return Array.from(root.querySelectorAll('.' + PREVIEW_SYNC_CLASS)).map((el) => el.getAttribute('data-map-id') ?? '');
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

describe('computeSyncTargets — editor span → preview mapIds (pure)', () => {
  it('returns the mapIds of every block intersecting the span', () => {
    expect(computeSyncTargets(MAP, { fromLine: 3, toLine: 6 })).toEqual([1, 2]);
    expect(computeSyncTargets(MAP, { fromLine: 1, toLine: 1 })).toEqual([0]);
    expect(computeSyncTargets(MAP, { fromLine: 5, toLine: 5 })).toEqual([2]);
    expect(computeSyncTargets(MAP, { fromLine: 1, toLine: 8 })).toEqual([0, 1, 2, 3]);
  });

  it('returns [] for a null span or an empty map', () => {
    expect(computeSyncTargets(MAP, null)).toEqual([]);
    expect(computeSyncTargets([], { fromLine: 1, toLine: 1 })).toEqual([]);
  });

  it('caps a huge selection at SYNC_HIGHLIGHT_CAP blocks', () => {
    const big: SourceLineRange[] = Array.from({ length: 300 }, (_, i) => ({
      mapId: i,
      startLine: i + 1,
      endLine: i + 1,
    }));
    const ids = computeSyncTargets(big, { fromLine: 1, toLine: 300 });
    expect(ids).toHaveLength(SYNC_HIGHLIGHT_CAP);
    expect(ids[0]).toBe(0);
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
  it('marks exactly the targeted blocks and diffs away the rest on the next apply', () => {
    const preview = mountPreview();
    preview.setDoc(DOC);

    applyPreviewHighlight(preview.el, [1, 2]);
    expect(highlightedIds(preview.el)).toEqual(['1', '2']);

    // Re-apply a different target set: previously-lit blocks lose the class.
    applyPreviewHighlight(preview.el, [0]);
    expect(highlightedIds(preview.el)).toEqual(['0']);

    // Empty set clears everything.
    applyPreviewHighlight(preview.el, []);
    expect(highlightedIds(preview.el)).toEqual([]);
  });

  it('clearPreviewHighlight strips the class from every block', () => {
    const preview = mountPreview();
    preview.setDoc(DOC);
    applyPreviewHighlight(preview.el, [0, 1, 2, 3]);
    expect(highlightedIds(preview.el)).toEqual(['0', '1', '2', '3']);
    clearPreviewHighlight(preview.el);
    expect(highlightedIds(preview.el)).toEqual([]);
  });
});

describe('previewNodeToLineRange — nearest tagged ancestor', () => {
  it('walks up from a nested node to the enclosing top-level block', () => {
    const preview = mountPreview();
    preview.setDoc(DOC);
    const li = preview.el.querySelector('li')!;
    const textInLi = li.firstChild ?? li;
    expect(previewNodeToLineRange(textInLi, preview.el)).toEqual({ startLine: 5, endLine: 7 });

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
  it('highlights the covered blocks, clears its own editor highlight, and reacts to the gate', () => {
    const preview = mountPreview();
    preview.setDoc(DOC);
    const ed = fakeEditor();
    let active = true;
    const sync = createSelectionSync({
      getPreviewRoot: () => preview.el,
      getSourceMap: () => preview.getSourceMap(),
      editor: ed.target,
      isActive: () => active,
      getSelection: () => null,
    });

    sync.syncEditorToPreview({ fromLine: 3, toLine: 6 });
    expect(highlightedIds(preview.el)).toEqual(['1', '2']);
    // Editor is the source → its own (preview-driven) highlight is dropped.
    expect(ed.getClears()).toBeGreaterThan(0);
    // Editor → preview never sets editor line highlights.
    expect(ed.setCalls).toEqual([]);

    // Empty selection clears the preview highlight.
    sync.syncEditorToPreview(null);
    expect(highlightedIds(preview.el)).toEqual([]);

    // When inactive (non-split / converted HTML), any selection clears.
    sync.syncEditorToPreview({ fromLine: 1, toLine: 8 });
    expect(highlightedIds(preview.el)).toEqual(['0', '1', '2', '3']);
    active = false;
    sync.syncEditorToPreview({ fromLine: 1, toLine: 8 });
    expect(highlightedIds(preview.el)).toEqual([]);
  });
});

describe('createSelectionSync — preview → editor', () => {
  it('highlights the editor lines for the selected block(s)', () => {
    const preview = mountPreview();
    preview.setDoc(DOC);
    const ed = fakeEditor();
    let sel: Selection | null = null;
    const sync = createSelectionSync({
      getPreviewRoot: () => preview.el,
      getSourceMap: () => preview.getSourceMap(),
      editor: ed.target,
      isActive: () => true,
      getSelection: () => sel,
    });

    // Selection inside the blockquote (line 8).
    const bq = preview.el.querySelector('blockquote')!;
    sel = fakeSelection(bq, bq, false);
    sync.syncPreviewToEditor();
    expect(ed.setCalls.at(-1)).toEqual([8]);

    // Drag spanning the para (line 3) through the blockquote (line 8) → union.
    const para = preview.el.children[1]; // top-level <p> "para one"
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
      getSourceMap: () => preview.getSourceMap(),
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
    applyPreviewHighlight(preview.el, [0, 1]); // pretend an editor-driven highlight exists
    const sync = createSelectionSync({
      getPreviewRoot: () => preview.el,
      getSourceMap: () => preview.getSourceMap(),
      editor: ed.target,
      isActive: () => false,
      getSelection: () => fakeSelection(bq, bq, false),
    });

    sync.syncPreviewToEditor();
    expect(ed.setCalls).toEqual([]);
    expect(ed.getClears()).toBeGreaterThan(0);
    // Preview is the active source → its editor-origin block highlight is dropped.
    expect(highlightedIds(preview.el)).toEqual([]);
  });

  it('ignores selections that live outside the preview pane', () => {
    const preview = mountPreview();
    preview.setDoc(DOC);
    const ed = fakeEditor();
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    const sync = createSelectionSync({
      getPreviewRoot: () => preview.el,
      getSourceMap: () => preview.getSourceMap(),
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
      getSourceMap: () => preview.getSourceMap(),
      editor: ed.target,
      isActive: () => true,
      getSelection: () => null,
    });
    applyPreviewHighlight(preview.el, [0, 1, 2, 3]);
    sync.clearAll();
    expect(highlightedIds(preview.el)).toEqual([]);
    expect(ed.getClears()).toBeGreaterThan(0);
  });

  it('the highlight class never leaks into the saved markdown', () => {
    const preview = mountPreview();
    preview.setDoc(DOC);
    applyPreviewHighlight(preview.el, [0, 1, 2, 3]);

    const out = htmlToMarkdown(preview.el.innerHTML);
    expect(out).not.toMatch(/preview-sync-highlight/);
    expect(out).not.toMatch(/class=/);
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
