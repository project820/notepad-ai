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
  });
});
