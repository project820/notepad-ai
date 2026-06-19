import { EditorSelection, Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

export type FormatAction =
  | 'bold'
  | 'italic'
  | 'strike'
  | 'code'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'quote'
  | 'ul'
  | 'ol'
  | 'task'
  | 'link'
  | 'image'
  | 'codeblock'
  | 'hr';

// =========================================================
// CM6 (raw markdown source) formatting
// =========================================================

function wrap(view: EditorView, before: string, after = before) {
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

function applyLinePrefix(view: EditorView, prefix: string, opts?: { exclusive?: boolean; toggle?: boolean }) {
  const { state } = view;
  const changes = state.changeByRange((range) => {
    const startLine = state.doc.lineAt(range.from);
    const endLine = state.doc.lineAt(range.to);
    let cursor = range.head;
    const edits: { from: number; insert: string; to?: number }[] = [];
    for (let n = startLine.number; n <= endLine.number; n++) {
      const line = state.doc.line(n);
      const text = line.text;
      // Toggle off heading/quote if same prefix exists
      const headingMatch = /^(#{1,6})\s/.exec(text);
      const quoteMatch = /^>\s?/.exec(text);
      const listMatch = /^([-*+]|\d+\.)\s/.exec(text);
      const taskMatch = /^[-*+]\s\[[ xX]\]\s/.exec(text);
      if (opts?.toggle && text.startsWith(prefix)) {
        edits.push({ from: line.from, to: line.from + prefix.length, insert: '' });
        continue;
      }
      if (opts?.exclusive) {
        // strip any existing leading markdown line marker before applying new one
        const toStrip =
          taskMatch?.[0] ?? headingMatch?.[0] ?? quoteMatch?.[0] ?? listMatch?.[0] ?? '';
        if (toStrip) {
          edits.push({ from: line.from, to: line.from + toStrip.length, insert: prefix });
          continue;
        }
      }
      edits.push({ from: line.from, insert: prefix });
    }
    return {
      changes: edits.map((e) => (e.to != null ? { from: e.from, to: e.to, insert: e.insert } : { from: e.from, insert: e.insert })),
      range: EditorSelection.cursor(cursor),
    };
  });
  view.dispatch(state.update(changes, { scrollIntoView: true }));
  view.focus();
}

function insertOrdered(view: EditorView) {
  const { state } = view;
  const changes = state.changeByRange((range) => {
    const startLine = state.doc.lineAt(range.from);
    const endLine = state.doc.lineAt(range.to);
    const edits: { from: number; to?: number; insert: string }[] = [];
    let n = 1;
    for (let i = startLine.number; i <= endLine.number; i++) {
      const line = state.doc.line(i);
      const stripped = line.text.replace(/^([-*+]|\d+\.)\s/, '');
      edits.push({ from: line.from, to: line.to, insert: `${n}. ${stripped}` });
      n++;
    }
    return { changes: edits, range: EditorSelection.cursor(range.head) };
  });
  view.dispatch(state.update(changes, { scrollIntoView: true }));
  view.focus();
}

function insertLink(view: EditorView) {
  const url = window.prompt('Link URL', 'https://');
  if (!url) return;
  const { state } = view;
  const changes = state.changeByRange((range) => {
    if (range.empty) {
      const text = `[](${url})`;
      return {
        changes: { from: range.from, insert: text },
        range: EditorSelection.cursor(range.from + 1),
      };
    }
    const sel = state.sliceDoc(range.from, range.to);
    const insert = `[${sel}](${url})`;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.range(range.from, range.from + insert.length),
    };
  });
  view.dispatch(state.update(changes, { scrollIntoView: true }));
  view.focus();
}

function insertImage(view: EditorView) {
  const url = window.prompt('Image URL', 'https://');
  if (!url) return;
  const alt = window.prompt('Alt text (optional)', '') ?? '';
  const insert = `![${alt}](${url})`;
  view.dispatch({
    changes: { from: view.state.selection.main.from, insert },
    scrollIntoView: true,
  });
  view.focus();
}

function insertCodeBlock(view: EditorView) {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.from);
  const insert = `\n\`\`\`\n\n\`\`\`\n`;
  const at = line.to;
  view.dispatch({
    changes: { from: at, insert },
    selection: EditorSelection.cursor(at + 5),
    scrollIntoView: true,
  });
  view.focus();
}

function insertHr(view: EditorView) {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.from);
  view.dispatch({
    changes: { from: line.to, insert: `\n\n---\n` },
    scrollIntoView: true,
  });
  view.focus();
}

export function applyToEditor(view: EditorView, action: FormatAction) {
  switch (action) {
    case 'bold': return wrap(view, '**');
    case 'italic': return wrap(view, '_');
    case 'strike': return wrap(view, '~~');
    case 'code': return wrap(view, '`');
    case 'h1': return applyLinePrefix(view, '# ', { exclusive: true });
    case 'h2': return applyLinePrefix(view, '## ', { exclusive: true });
    case 'h3': return applyLinePrefix(view, '### ', { exclusive: true });
    case 'quote': return applyLinePrefix(view, '> ', { exclusive: true });
    case 'ul': return applyLinePrefix(view, '- ', { exclusive: true });
    case 'ol': return insertOrdered(view);
    case 'task': return applyLinePrefix(view, '- [ ] ', { exclusive: true });
    case 'link': return insertLink(view);
    case 'image': return insertImage(view);
    case 'codeblock': return insertCodeBlock(view);
    case 'hr': return insertHr(view);
  }
}

// =========================================================
// Preview (rich rendered HTML) formatting using execCommand.
// Returns true if it actually changed the DOM.
// =========================================================

export function applyToPreview(action: FormatAction): boolean {
  const doc = document;
  const exec = (cmd: string, value?: string) => doc.execCommand(cmd, false, value);
  switch (action) {
    case 'bold': return exec('bold');
    case 'italic': return exec('italic');
    case 'strike': return exec('strikeThrough');
    case 'code': {
      // Wrap selection in <code>
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return false;
      const range = sel.getRangeAt(0);
      if (range.collapsed) return false;
      const code = doc.createElement('code');
      try {
        code.appendChild(range.extractContents());
        range.insertNode(code);
        range.selectNodeContents(code);
        sel.removeAllRanges();
        sel.addRange(range);
        return true;
      } catch {
        return false;
      }
    }
    case 'h1': return exec('formatBlock', 'h1');
    case 'h2': return exec('formatBlock', 'h2');
    case 'h3': return exec('formatBlock', 'h3');
    case 'quote': return exec('formatBlock', 'blockquote');
    case 'ul': return exec('insertUnorderedList');
    case 'ol': return exec('insertOrderedList');
    case 'task': {
      // Insert a checkbox at cursor; turndown will see input[type=checkbox] and serialize to "[ ]"
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return false;
      const range = sel.getRangeAt(0);
      const input = doc.createElement('input');
      input.type = 'checkbox';
      input.setAttribute('data-md-task', '1');
      range.insertNode(input);
      range.setStartAfter(input);
      range.setEndAfter(input);
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    }
    case 'link': {
      const url = window.prompt('Link URL', 'https://');
      if (!url) return false;
      return exec('createLink', url);
    }
    case 'image': {
      const url = window.prompt('Image URL', 'https://');
      if (!url) return false;
      return exec('insertImage', url);
    }
    case 'codeblock': {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return false;
      const range = sel.getRangeAt(0);
      const pre = doc.createElement('pre');
      const code = doc.createElement('code');
      try {
        code.appendChild(range.extractContents());
        pre.appendChild(code);
        range.insertNode(pre);
        return true;
      } catch {
        return false;
      }
    }
    case 'hr': return exec('insertHorizontalRule');
  }
}
