// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { EditorState, EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history } from '@codemirror/commands';
import { applyToEditor } from '../formatting';

const openViews: EditorView[] = [];

afterEach(() => {
  // Destroy every mounted view so CodeMirror cancels its deferred requestMeasure
  // timer. Otherwise the timer fires after happy-dom tears the window down and
  // throws "this.win.requestAnimationFrame is not a function", which surfaces as
  // an unhandled error and makes the whole `npm test` run exit non-zero.
  for (const v of openViews.splice(0)) v.destroy();
  document.body.innerHTML = '';
});

function mount(doc: string, from: number, to: number): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(from, to),
    extensions: [history()],
  });
  const view = new EditorView({ state, parent });
  openViews.push(view);
  return view;
}

describe('format wrap is a toggle (highlight cancel / re-apply fix)', () => {
  it('wraps a plain selection with ==…==', () => {
    const view = mount('hello world', 6, 11); // "world"
    applyToEditor(view, 'highlight');
    expect(view.state.doc.toString()).toBe('hello ==world==');
  });

  it('UN-wraps when the selection itself includes the markers (==world==)', () => {
    const view = mount('hello ==world==', 6, 15); // selects "==world=="
    applyToEditor(view, 'highlight');
    expect(view.state.doc.toString()).toBe('hello world');
  });

  it('UN-wraps when the markers sit just outside the selection (==<world>==)', () => {
    const view = mount('hello ==world==', 8, 13); // selects inner "world"
    applyToEditor(view, 'highlight');
    expect(view.state.doc.toString()).toBe('hello world');
  });

  it('re-applying does NOT keep adding markers (toggle round-trips)', () => {
    const view = mount('keep this', 5, 9); // "this"
    applyToEditor(view, 'highlight'); // → keep ==this==
    expect(view.state.doc.toString()).toBe('keep ==this==');
    // a fresh selection over the now-wrapped token toggles it back off
    const view2 = mount('keep ==this==', 5, 13); // selects "==this=="
    applyToEditor(view2, 'highlight');
    expect(view2.state.doc.toString()).toBe('keep this');
    expect(view2.state.doc.toString()).not.toContain('====');
  });

  it('toggles bold (**) the same way', () => {
    const view = mount('a b c', 2, 3); // "b"
    applyToEditor(view, 'bold');
    expect(view.state.doc.toString()).toBe('a **b** c');
    const view2 = mount('a **b** c', 2, 7); // "**b**"
    applyToEditor(view2, 'bold');
    expect(view2.state.doc.toString()).toBe('a b c');
  });
});
