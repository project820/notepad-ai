import { EditorState, EditorSelection, Transaction } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, dropCursor } from '@codemirror/view';
import { history, historyKeymap, defaultKeymap, indentWithTab, undo, redo } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { markdownLiveDecorations } from './cm-decorations';
import { buildMarkdownTable } from './table-md';
import {
  selectionHighlightField,
  setHighlightedLines as cmSetHighlightedLines,
  clearHighlight as cmClearHighlight,
} from './cm-selection-highlight';
import { lineAlignmentField } from './cm-line-alignment';

type ChangeHandler = (doc: string) => void;
type SelectionHandler = (sel: { fromLine: number; toLine: number } | null) => void;

/**
 * CodeMirror 6 theme — fully driven by CSS variables so it follows the
 * app's data-theme without needing to swap CM theme extensions.
 */
const cssVarTheme = EditorView.theme({
  '&': {
    color: 'var(--color-ink)',
    backgroundColor: 'var(--color-canvas)',
    height: '100%',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--fs-editor, 15px)',
    lineHeight: '1.65',
    padding: '12px 20px',
  },
  '.cm-content': {
    caretColor: 'var(--color-primary)',
    color: 'var(--color-ink)',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-primary)' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--color-stone)',
    border: 'none',
    borderRight: '1px solid var(--color-hairline)',
  },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--color-mute)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--color-primary) 5%, transparent)' },
  '.cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--color-primary) 25%, transparent)',
  },
  '.cm-line': { color: 'var(--color-ink)' },
});

function wrapSelection(view: EditorView, before: string, after = before) {
  const { state } = view;
  const changes = state.changeByRange((range) => {
    if (range.empty) {
      const cursor = range.from + before.length;
      return {
        changes: { from: range.from, insert: before + after },
        range: EditorSelection.cursor(cursor),
      };
    }
    return {
      changes: [
        { from: range.from, insert: before },
        { from: range.to, insert: after },
      ],
      range: EditorSelection.range(range.from + before.length, range.to + before.length),
    };
  });
  view.dispatch(state.update(changes, { scrollIntoView: true, annotations: Transaction.userEvent.of('input.format') }));
  view.focus();
}

function insertLink(view: EditorView) {
  const { state } = view;
  const url = window.prompt('Link URL', 'https://');
  if (!url) return;
  const changes = state.changeByRange((range) => {
    if (range.empty) {
      const text = `[](${url})`;
      const cursor = range.from + 1;
      return {
        changes: { from: range.from, insert: text },
        range: EditorSelection.cursor(cursor),
      };
    }
    const selected = state.sliceDoc(range.from, range.to);
    const insert = `[${selected}](${url})`;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.range(range.from, range.from + insert.length),
    };
  });
  view.dispatch(state.update(changes, { scrollIntoView: true }));
  view.focus();
}

export type EditorHandle = {
  view: EditorView;
  getDoc: () => string;
  setDoc: (doc: string) => void;
  insertTable: (rows: number, cols: number) => void;
  focus: () => void;
  /** Undo / redo the CM6 edit history. */
  undo: () => void;
  redo: () => void;
  applyTheme: (dark: boolean) => void;
  /** Subscribe to selection changes; `null` is emitted when the selection is empty. */
  onSelectionChange: (cb: SelectionHandler) => void;
  /** Display-only: highlight the given 1-based lines (`.cm-sync-highlight`). */
  setHighlightedLines: (lines: number[]) => void;
  /** Display-only: remove all sync line highlighting. */
  clearHighlight: () => void;

};

export function createEditor(parent: HTMLElement, opts: { onChange: ChangeHandler; initialDoc?: string }): EditorHandle {
  const formatKeymap = keymap.of([
    {
      key: 'Mod-b',
      run: (view) => {
        wrapSelection(view, '**');
        return true;
      },
    },
    {
      key: 'Mod-i',
      run: (view) => {
        wrapSelection(view, '_');
        return true;
      },
    },
    {
      key: 'Mod-k',
      run: (view) => {
        insertLink(view);
        return true;
      },
    },
    {
      key: 'Mod-e',
      run: (view) => {
        wrapSelection(view, '`');
        return true;
      },
    },
  ]);

  const selectionListeners: SelectionHandler[] = [];

  const updateListener = EditorView.updateListener.of((update) => {
    if (update.docChanged) {
      opts.onChange(update.state.doc.toString());
    }
    if (update.selectionSet && selectionListeners.length > 0) {
      const main = update.state.selection.main;
      const span = main.empty
        ? null
        : {
            fromLine: update.state.doc.lineAt(main.from).number,
            toLine: update.state.doc.lineAt(main.to).number,
          };
      for (const cb of selectionListeners) cb(span);
    }
  });

  const state = EditorState.create({
    doc: opts.initialDoc ?? '',
    extensions: [
      lineNumbers(),
      highlightActiveLine(),
      drawSelection(),
      dropCursor(),
      history(),
      EditorView.lineWrapping,
      markdown({ base: markdownLanguage, codeLanguages: [] }),
      ...markdownLiveDecorations,
      selectionHighlightField,
      lineAlignmentField,
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      formatKeymap,
      updateListener,
      cssVarTheme,
    ],
  });

  const view = new EditorView({ state, parent });

  return {
    view,
    getDoc: () => view.state.doc.toString(),
    setDoc: (doc: string) => {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: doc },
      });
    },
    insertTable: (rows: number, cols: number) => {
      // import('./i18n') would create a cycle; require dynamic-ish access via document.documentElement.lang
      const locale = (document.documentElement.lang || 'en') as 'en' | 'ko';
      const table = buildMarkdownTable(rows, cols, locale);
      const { state } = view;
      const insertAt = state.selection.main.from;
      const prefix = insertAt > 0 && state.doc.sliceString(insertAt - 1, insertAt) !== '\n' ? '\n\n' : '';
      const suffix = '\n';
      view.dispatch({
        changes: { from: insertAt, insert: prefix + table + suffix },
        selection: EditorSelection.cursor(insertAt + prefix.length + table.length + suffix.length),
        scrollIntoView: true,
      });
      view.focus();
    },
    focus: () => view.focus(),
    undo: () => {
      undo(view);
      view.focus();
    },
    redo: () => {
      redo(view);
      view.focus();
    },
    // Kept for API compat — CM6 now follows CSS vars, so theme switching is a no-op here.
    applyTheme: (_dark: boolean) => {},
    onSelectionChange: (cb: SelectionHandler) => {
      selectionListeners.push(cb);
    },
    setHighlightedLines: (lines: number[]) => cmSetHighlightedLines(view, lines),
    clearHighlight: () => cmClearHighlight(view),
  };
}
