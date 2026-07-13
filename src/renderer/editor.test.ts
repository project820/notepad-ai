// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorSelection, StateEffect } from '@codemirror/state';
import { createEditor } from './editor';

describe('editor mutation fence', () => {
  let host: HTMLDivElement | null = null;
  let editor: ReturnType<typeof createEditor> | null = null;

  afterEach(() => {
    editor?.view.destroy();
    editor = null;
    host?.remove();
    host = null;
  });

  it('rejects filter-bypassing document transactions while fenced and accepts them after rollback', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    const onChange = vi.fn();
    editor = createEditor(host, { initialDoc: 'draft', onChange });

    editor.setMutationFence(true);
    editor.view.dispatch({ changes: { from: 5, insert: '!' }, filter: false });

    expect(editor.getDoc()).toBe('draft');
    expect(onChange).not.toHaveBeenCalled();

    editor.setMutationFence(false);
    editor.view.dispatch({ changes: { from: 5, insert: '!' }, filter: false });

    expect(editor.getDoc()).toBe('draft!');
    expect(onChange).toHaveBeenCalledWith('draft!');
  });

  it('allows selection-only transactions while fenced', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    editor = createEditor(host, { initialDoc: 'draft', onChange: vi.fn() });

    editor.setMutationFence(true);
    editor.view.dispatch({ selection: EditorSelection.cursor(2), filter: false });

    expect(editor.view.state.selection.main.head).toBe(2);
  });

  it('keeps the dispatch fence after reconfiguration removes state extensions', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    editor = createEditor(host, { initialDoc: 'draft', onChange: vi.fn() });

    editor.setMutationFence(true);
    editor.view.dispatch({ effects: StateEffect.reconfigure.of([]), filter: false });
    editor.view.dispatch({ changes: { from: 5, insert: '!' }, filter: false });

    expect(editor.getDoc()).toBe('draft');
  });
});
describe('task checkbox mouse targets', () => {
  let host: HTMLDivElement | null = null;
  let editor: ReturnType<typeof createEditor> | null = null;

  afterEach(() => {
    editor?.view.destroy();
    host?.remove();
    editor = null;
    host = null;
  });

  it('toggles only the checkbox input and leaves nearby text clicks as editor events', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    editor = createEditor(host, { initialDoc: '- [ ] task.', onChange: vi.fn() });
    const checkbox = editor.view.dom.querySelector<HTMLInputElement>('.cm-task-checkbox input')!;
    const line = editor.view.dom.querySelector<HTMLElement>('.cm-line')!;

    line.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(editor.getDoc()).toBe('- [ ] task.');

    checkbox.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(editor.getDoc()).toBe('- [x] task.');
  });
});
