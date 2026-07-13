// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppContext } from './app-context';
import { initPreviewEditing } from './preview-editing';
import { createMarkdownIt } from './markdown-it';

function setupPreviewEditing(initialDoc = 'original') {
  const previewEl = document.createElement('div');
  document.body.appendChild(previewEl);

  let doc = initialDoc;
  let mayMutate = true;
  const setDoc = vi.fn((next: string) => {
    doc = next;
  });
  const setPreviewDoc = vi.fn((next: string) => {
    previewEl.textContent = next;
  });
  const lifecycle = vi.fn((_next: string, _syncPreview = false, mutationAlreadyRecorded = false) => {
    ctx.dirty = true;
    if (!mutationAlreadyRecorded) ctx.docRevision += 1;
  });
  const recordPreviewInput = vi.fn(() => {
    if (!mayMutate) return false;
    ctx.dirty = true;
    ctx.docRevision += 1;
    return true;
  });
  const ctx = {
    dirty: false,
    docRevision: 0,
    editingInPreview: false,
    suppressEditorChange: false,
    preview: {
      el: previewEl,
      setDoc: setPreviewDoc,
    },
    editor: {
      getDoc: () => doc,
      setDoc,
    },
  } as unknown as AppContext;
  const htmlToMarkdown = vi.fn((html: string) => html.replace(/<[^>]+>/g, ''));
  const editing = initPreviewEditing(ctx, {
    htmlToMarkdown: htmlToMarkdown as never,
    t: vi.fn() as never,
    onSuppressedEditorChange: lifecycle,
    tryMutateDocument: () => mayMutate,
    recordPreviewInput,
  });

  return {
    ctx,
    doc: () => doc,
    editing,
    htmlToMarkdown,
    lifecycle,
    previewEl,
    recordPreviewInput,
    setDoc,
    setMayMutate: (allowed: boolean) => { mayMutate = allowed; },
    setPreviewDoc,
  };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
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
    expect(lifecycle).toHaveBeenCalledWith('edited before close', false, true);
    expect(editing.flushPendingPreviewToSource()).toBe(false);
    expect(htmlToMarkdown).toHaveBeenCalledTimes(1);
  });
  it('transfers a whitespace-only pending preview edit before close-state capture', () => {
    const { ctx, doc, editing, lifecycle, previewEl, setDoc } = setupPreviewEditing();
    previewEl.innerHTML = '<p>original</p><p> </p>';
    previewEl.dispatchEvent(new Event('input'));

    editing.flushPendingPreviewToSource();
    const closeState = { dirty: ctx.dirty, revision: ctx.docRevision, doc: doc() };

    expect(closeState).toEqual({ dirty: true, revision: 1, doc: 'original ' });
    expect(setDoc).toHaveBeenCalledWith('original ');
    expect(lifecycle).toHaveBeenCalledWith('original ', false, true);
  });
  it('does not update the canonical document for an unchanged pending preview edit', () => {
    const { doc, editing, htmlToMarkdown, lifecycle, previewEl, setDoc } = setupPreviewEditing();
    previewEl.innerHTML = '<p>original</p>';
    previewEl.dispatchEvent(new Event('input'));

    expect(editing.flushPendingPreviewToSource()).toBe(false);

    expect(doc()).toBe('original');
    expect(htmlToMarkdown).toHaveBeenCalledTimes(1);
    expect(setDoc).not.toHaveBeenCalled();
    expect(lifecycle).not.toHaveBeenCalled();
  });
  it('invalidates the lifecycle immediately on preview input before debounced source synchronization', () => {
    vi.useFakeTimers();
    const { ctx, doc, lifecycle, previewEl, recordPreviewInput, setDoc } = setupPreviewEditing();
    previewEl.innerHTML = '<p>edited after close query</p>';

    previewEl.dispatchEvent(new Event('input'));

    expect(recordPreviewInput).toHaveBeenCalledOnce();
    expect(ctx.docRevision).toBe(1);
    expect(doc()).toBe('original');
    expect(setDoc).not.toHaveBeenCalled();

    vi.advanceTimersByTime(350);

    expect(doc()).toBe('edited after close query');
    expect(lifecycle).toHaveBeenCalledWith('edited after close query', false, true);
  });

  it('restores canonical preview content when a late input arrives after the close lease is consumed', () => {
    const { ctx, doc, previewEl, recordPreviewInput, setMayMutate, setPreviewDoc } = setupPreviewEditing();
    setMayMutate(false);
    previewEl.innerHTML = '<p>late native edit</p>';

    previewEl.dispatchEvent(new Event('input'));

    expect(recordPreviewInput).not.toHaveBeenCalled();
    expect(doc()).toBe('original');
    expect(previewEl.textContent).toBe('original');
    expect(setPreviewDoc).toHaveBeenCalledWith('original');
    expect(ctx.editingInPreview).toBe(false);
  });

  it('accepts preview input again after a close rollback restores mutation permission', () => {
    const { ctx, previewEl, recordPreviewInput, setMayMutate } = setupPreviewEditing();
    setMayMutate(false);
    previewEl.innerHTML = '<p>blocked edit</p>';
    previewEl.dispatchEvent(new Event('input'));

    setMayMutate(true);
    previewEl.innerHTML = '<p>editable again</p>';
    previewEl.dispatchEvent(new Event('input'));

    expect(recordPreviewInput).toHaveBeenCalledOnce();
    expect(ctx.editingInPreview).toBe(true);
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
describe('preview checkbox changes', () => {
  it('does not turn task text clicks into checkbox changes in markdown-it rendered preview DOM', () => {
    const { ctx, previewEl, recordPreviewInput } = setupPreviewEditing();
    previewEl.innerHTML = createMarkdownIt().render('- [ ] task punctuation.');

    const label = previewEl.querySelector('label')!;
    const checkbox = previewEl.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(label.contains(checkbox)).toBe(true);

    const textClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    label.dispatchEvent(textClick);
    expect(textClick.defaultPrevented).toBe(true);
    expect(checkbox.checked).toBe(false);
    expect(recordPreviewInput).not.toHaveBeenCalled();
    expect(ctx.editingInPreview).toBe(false);

    const inputClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    checkbox.dispatchEvent(inputClick);
    expect(inputClick.defaultPrevented).toBe(false);
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    expect(recordPreviewInput).toHaveBeenCalledOnce();
    expect(ctx.editingInPreview).toBe(true);
  });
});
