// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppContext } from './app-context';
import { initPreviewEditing } from './preview-editing';

function setupPreviewEditing(initialDoc = 'original') {
  const previewEl = document.createElement('div');
  document.body.appendChild(previewEl);

  let doc = initialDoc;
  const setDoc = vi.fn((next: string) => {
    doc = next;
  });
  const lifecycle = vi.fn((next: string) => {
    ctx.dirty = true;
    ctx.docRevision += 1;
  });
  const ctx = {
    dirty: false,
    docRevision: 0,
    editingInPreview: false,
    suppressEditorChange: false,
    preview: {
      el: previewEl,
      setDoc: vi.fn(),
    },
    editor: {
      getDoc: () => doc,
      setDoc,
    },
  } as AppContext;
  const htmlToMarkdown = vi.fn((html: string) => html.replace(/<[^>]+>/g, ''));
  const editing = initPreviewEditing(ctx, {
    htmlToMarkdown: htmlToMarkdown as never,
    t: vi.fn() as never,
    onSuppressedEditorChange: lifecycle,
    tryMutateDocument: () => true,
  });

  return { ctx, doc: () => doc, editing, htmlToMarkdown, lifecycle, previewEl, setDoc };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('initPreviewEditing close flush', () => {
  it('transfers a pending preview edit before close-state capture and records it through the lifecycle', () => {
    const { ctx, doc, editing, htmlToMarkdown, lifecycle, previewEl, setDoc } = setupPreviewEditing();
    previewEl.innerHTML = '<p>edited before close</p>';
    previewEl.dispatchEvent(new Event('input'));

    editing.flushPendingPreviewToSource();
    const closeState = { dirty: ctx.dirty, revision: ctx.docRevision, doc: doc() };

    expect(closeState).toEqual({ dirty: true, revision: 1, doc: 'edited before close' });
    expect(setDoc).toHaveBeenCalledWith('edited before close');
    expect(lifecycle).toHaveBeenCalledWith('edited before close');
    expect(editing.flushPendingPreviewToSource()).toBe(false);
    expect(htmlToMarkdown).toHaveBeenCalledTimes(1);
  });

  it('does not convert a rendered preview with no pending edit', () => {
    const { doc, editing, htmlToMarkdown, lifecycle, previewEl, setDoc } = setupPreviewEditing();
    previewEl.innerHTML = '<p>rendered preview</p>';

    expect(editing.flushPendingPreviewToSource()).toBe(false);
    expect(doc()).toBe('original');
    expect(htmlToMarkdown).not.toHaveBeenCalled();
    expect(setDoc).not.toHaveBeenCalled();
    expect(lifecycle).not.toHaveBeenCalled();
  });
});
