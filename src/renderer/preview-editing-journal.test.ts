// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';

import { initPreviewEditing } from './preview-editing';

describe('preview editing journal route', () => {
  it('uses a B5 single run patch rather than whole-document conversion', () => {
    const el = document.createElement('div');
    el.innerHTML = '<p data-run-id="7">edited</p>';
    const htmlToMarkdown = vi.fn();
    const commitSourcePatch = vi.fn(() => ({ ok: true, markdown: 'edited\n' }));
    let source = 'original\n';
    const ctx = {
      editingInPreview: false, suppressEditorChange: false, showingConvertedHtml: false,
      preview: { el, setDoc: vi.fn(), commitSourcePatch },
      editor: { getDoc: () => source, setDoc: (value: string) => { source = value; } },
    } as any;
    const editing = initPreviewEditing(ctx, {
      htmlToMarkdown, t: () => '', tryMutateDocument: () => true,
      recordPreviewInput: () => true, onSuppressedEditorChange: () => {},
    });
    el.querySelector('p')!.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', bubbles: true }));
    el.querySelector('p')!.dispatchEvent(new Event('input', { bubbles: true }));
    expect(editing.flushPreviewToSource()).toBe(true);
    expect(commitSourcePatch).toHaveBeenCalledWith('original\n', [7]);
    expect(htmlToMarkdown).not.toHaveBeenCalled();
    expect(source).toBe('edited\n');
    expect(editing.getMetrics()).toEqual({ journalPatchCount: 1, fullSerializeCount: 0 });
  });
  it('counts converted HTML as the measured whole-document fallback path', () => {
    const el = document.createElement('div');
    el.innerHTML = '<p>converted</p>';
    const htmlToMarkdown = vi.fn(() => 'converted\n');
    const ctx = {
      editingInPreview: false, suppressEditorChange: false, showingConvertedHtml: true,
      preview: { el, setDoc: vi.fn() },
      editor: { getDoc: () => 'original\n', setDoc: vi.fn() },
    } as any;
    const editing = initPreviewEditing(ctx, {
      htmlToMarkdown, t: () => '', tryMutateDocument: () => true,
      recordPreviewInput: () => true, onSuppressedEditorChange: () => {},
    });
    el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    editing.flushPreviewToSource();
    expect(editing.getMetrics()).toEqual({ journalPatchCount: 0, fullSerializeCount: 1 });
    expect(htmlToMarkdown).toHaveBeenCalledOnce();
  });
  it('routes B1 structural edits through the journal commit with disposition data', () => {
    const el = document.createElement('div');
    el.innerHTML = '<p data-run-id="1">left</p>';
    const commitSourcePatch = vi.fn(() => ({ ok: true, markdown: 'left\n\nright\n' }));
    const ctx = {
      editingInPreview: false, suppressEditorChange: false, showingConvertedHtml: false,
      preview: { el, setDoc: vi.fn(), commitSourcePatch },
      editor: { getDoc: () => 'left\n', setDoc: vi.fn() },
    } as any;
    const editing = initPreviewEditing(ctx, {
      htmlToMarkdown: vi.fn(), t: () => '', tryMutateDocument: () => true,
      recordPreviewInput: () => true, onSuppressedEditorChange: () => {},
    });
    const text = el.firstChild!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 2);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    el.firstChild!.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertParagraph', bubbles: true }));
    el.insertAdjacentHTML('beforeend', '<p>right</p>');
    el.firstChild!.dispatchEvent(new Event('input', { bubbles: true }));
    editing.flushPreviewToSource();

    expect(commitSourcePatch).toHaveBeenCalledWith(
      'left\n',
      [1],
      expect.objectContaining({ disposition: { kind: 'split' } }),
    );
    expect(editing.getMetrics()).toEqual({ journalPatchCount: 1, fullSerializeCount: 0 });
  });
  it('falls back after a serializer failure so an all-space code edit reaches canonical source', () => {
    const el = document.createElement('div');
    el.innerHTML = '<p data-run-id="7"><code> </code></p>';
    const htmlToMarkdown = vi.fn(() => '` `\n');
    const commitSourcePatch = vi.fn(() => ({ ok: false, markdown: 'original\n', reason: 'unknown-inline-node' }));
    let source = 'original\n';
    const ctx = {
      editingInPreview: false, suppressEditorChange: false, showingConvertedHtml: false,
      preview: { el, setDoc: vi.fn(), commitSourcePatch },
      editor: { getDoc: () => source, setDoc: (value: string) => { source = value; } },
    } as any;
    const editing = initPreviewEditing(ctx, {
      htmlToMarkdown, t: () => '', tryMutateDocument: () => true,
      recordPreviewInput: () => true, onSuppressedEditorChange: () => {},
    });
    const code = el.querySelector('code')!;
    code.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', bubbles: true }));
    code.dispatchEvent(new Event('input', { bubbles: true }));
    expect(editing.flushPendingPreviewToSource()).toBe(true);

    expect(htmlToMarkdown).toHaveBeenCalledWith(el.innerHTML);
    expect(source).toBe('` `\n');
    expect(editing.getMetrics()).toEqual({ journalPatchCount: 0, fullSerializeCount: 1 });
  });
});
