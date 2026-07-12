import { describe, expect, it, vi } from 'vitest';
import { createAppContext } from './app-context';
import { initDocLifecycle } from './doc-lifecycle';

function setup() {
  (globalThis as { document?: unknown }).document = { activeElement: null };
  const ctx = createAppContext({ textContent: '' } as HTMLElement);
  let doc = 'draft';
  let mutationFenced = false;
  ctx.setHandles({
    view: {} as never,
    getDoc: () => doc,
    setDoc: (next) => { doc = next; },
    setMutationFence: (fenced) => { mutationFenced = fenced; },
    insertTable: () => {},
    focus: () => {},
    undo: () => {},
    redo: () => {},
    applyTheme: () => {},
    onSelectionChange: () => {},
    setHighlightedLines: () => {},
    clearHighlight: () => {},
  }, {
    el: {} as HTMLDivElement,
    setDoc: () => {},
    setLineNumbers: () => {},
    getSourceMap: () => [],
    onAfterRender: () => {},
  });
  const saveFile = vi.fn(async () => ({ saved: true, filePath: '/tmp/draft.md' }));
  const sendCloseLeaseInvalidated = vi.fn();
  const lifecycle = initDocLifecycle(ctx, {
    api: { saveFile, sendCloseLeaseInvalidated } as never,
    titleEl: { value: '', classList: { toggle: () => {} } } as never,
    dirtyEl: { classList: { toggle: () => {} } } as never,
    t: ((key: string) => key) as never,
    htmlToMarkdown: ((html: string) => html) as never,
    buildConvertedHtmlFrame: (() => document.createElement('iframe')) as never,
    updateWordCount: () => {},
    scheduleSessionSnapshot: () => {},
    syncWorkspaceRootToCurrent: () => {},
    updateHtmlViewToggle: () => {},
    createRafThrottle: (() => (callback: () => void) => callback()) as never,
  });
  return { ctx, lifecycle, saveFile, sendCloseLeaseInvalidated, getDoc: () => doc, mutationFenced: () => mutationFenced };
}

describe('document close lease and replacement lifecycle', () => {
  it('invalidates a close lease when the document changes', () => {
    const { ctx, lifecycle, sendCloseLeaseInvalidated } = setup();
    ctx.dirty = true;
    lifecycle.beginCloseLease('lease-1');

    lifecycle.onDocChange('edited');

    expect(ctx.docRevision).toBe(1);
    expect(sendCloseLeaseInvalidated).toHaveBeenCalledWith('lease-1', 1);
    expect(lifecycle.authorizeCloseLease('lease-1')).toBe(false);
  });

  it('cancels an armed autosave and fences future document saves on discard', async () => {
    vi.useFakeTimers();
    const { ctx, lifecycle, saveFile } = setup();
    ctx.currentPath = '/tmp/draft.md';
    ctx.dirty = true;
    lifecycle.onDocChange('edited');
    lifecycle.beginCloseLease('lease-1');

    await expect(lifecycle.fenceDiscard('lease-1')).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(lifecycle.save()).resolves.toBeNull();

    expect(saveFile).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
  it('re-arms autosave after discard rollback for a dirty named document', async () => {
    vi.useFakeTimers();
    const { ctx, lifecycle, saveFile } = setup();
    ctx.currentPath = '/tmp/draft.md';
    ctx.dirty = true;
    lifecycle.beginCloseLease('lease-1');

    await lifecycle.fenceDiscard('lease-1');
    lifecycle.rollbackDiscardFence();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(saveFile).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('consumes a valid lease, fences the editor, and rejects programmatic replacement before state changes', () => {
    const { ctx, lifecycle, getDoc, mutationFenced } = setup();
    ctx.dirty = true;
    ctx.currentPath = '/tmp/draft.md';
    lifecycle.beginCloseLease('lease-1');

    expect(lifecycle.consumeCloseLease('lease-1')).toBe(true);
    expect(mutationFenced()).toBe(true);
    expect(lifecycle.replaceDocument({ doc: 'edited', currentPath: '/tmp/other.md', pendingTitle: 'other.md', dirty: false })).toBe(false);
    lifecycle.onDocChange('edited');

    expect(getDoc()).toBe('draft');
    expect(ctx.currentPath).toBe('/tmp/draft.md');
    expect(ctx.docRevision).toBe(0);
    expect(ctx.dirty).toBe(true);
    lifecycle.rollbackDiscardFence();
    expect(mutationFenced()).toBe(false);
    expect(lifecycle.authorizeCloseLease('lease-1')).toBe(false);
  });

  it('routes programmatic replacement through one revision and dirty-state authority', () => {
    const { ctx, lifecycle, getDoc } = setup();
    lifecycle.beginCloseLease('lease-1');

    lifecycle.replaceDocument({ doc: 'restored', currentPath: '/tmp/restored.md', pendingTitle: null, dirty: true });

    expect(getDoc()).toBe('restored');
    expect(ctx.docRevision).toBe(1);
    expect(ctx.dirty).toBe(true);
    expect(lifecycle.authorizeCloseLease('lease-1')).toBe(false);
  });
});
