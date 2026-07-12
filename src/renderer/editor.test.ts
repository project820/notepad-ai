// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('rejects real CodeMirror document transactions while fenced and accepts them after rollback', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    const onChange = vi.fn();
    editor = createEditor(host, { initialDoc: 'draft', onChange });

    editor.setMutationFence(true);
    editor.view.dispatch({ changes: { from: 5, insert: '!' } });

    expect(editor.getDoc()).toBe('draft');
    expect(onChange).not.toHaveBeenCalled();

    editor.setMutationFence(false);
    editor.view.dispatch({ changes: { from: 5, insert: '!' } });

    expect(editor.getDoc()).toBe('draft!');
    expect(onChange).toHaveBeenCalledWith('draft!');
  });
});
