import { describe, expect, it, vi } from 'vitest';
import { createAppContext } from './app-context';
import { initDocLifecycle } from './doc-lifecycle';

function setup(saveFile = vi.fn(async () => ({ saved: true, filePath: '/tmp/draft.md' }))) {
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
    getRunTable: () => null,
    onAfterRender: () => {},
    onBeforeRender: () => {},
    onRenderSettled: () => {},
    commitSourcePatch: () => ({ ok: false, markdown: '', reason: 'stub' }),
  });
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
    createRafThrottle: (() => ({ schedule: (callback: () => void) => callback(), cancel: () => {} })) as never,
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
  it('accepts shutdown persistence only for the current unfailed close lease revision', () => {
    const { ctx, lifecycle } = setup();
    lifecycle.beginCloseLease('shutdown-lease');

    expect(lifecycle.canPersistShutdown('shutdown-lease', 0)).toBe(true);
    expect(lifecycle.canPersistShutdown('shutdown-lease', 1)).toBe(false);

    lifecycle.markPreviewSyncFailed();
    expect(lifecycle.canPersistShutdown('shutdown-lease', 0)).toBe(false);

    ctx.docRevision = 1;
    expect(lifecycle.canPersistShutdown('shutdown-lease', 1)).toBe(false);
  });

  it('records a preview input through the lifecycle and invalidates its close lease', () => {
    const { ctx, lifecycle, sendCloseLeaseInvalidated } = setup();
    ctx.dirty = false;
    lifecycle.beginCloseLease('lease-1');

    expect(lifecycle.recordPreviewInput()).toBe(true);

    expect(ctx.docRevision).toBe(1);
    expect(ctx.dirty).toBe(true);
    expect(sendCloseLeaseInvalidated).toHaveBeenCalledWith('lease-1', 1);
    expect(lifecycle.authorizeCloseLease('lease-1')).toBe(false);
  });
  it('flushes a pending preview edit before saving so the persisted source matches its recorded revision', async () => {
    const { ctx, lifecycle, saveFile, getDoc } = setup();
    ctx.currentPath = '/tmp/draft.md';
    ctx.dirty = true;
    ctx.docRevision = 1; // Preview input already recorded this revision before debounce.
    lifecycle.setPreviewFlushGate(() => {
      ctx.editor.setDoc('preview edit');
    });

    await expect(lifecycle.save()).resolves.toBe(1);

    expect(getDoc()).toBe('preview edit');
    expect(saveFile).toHaveBeenCalledWith('/tmp/draft.md', 'preview edit');
    expect(ctx.dirty).toBe(false);
  });
  it('retries a failed preview sync and saves the latest source instead of retaining a permanent fence', async () => {
    const { ctx, lifecycle, saveFile, getDoc } = setup();
    ctx.currentPath = '/tmp/draft.md';
    ctx.dirty = true;
    ctx.docRevision = 1;
    lifecycle.markPreviewSyncFailed();

    expect(lifecycle.retryPreviewSync(() => ctx.editor.setDoc('recovered preview edit'))).toBe(true);
    expect(lifecycle.isSaveFenced()).toBe(false);

    await expect(lifecycle.save()).resolves.toBe(1);
    expect(getDoc()).toBe('recovered preview edit');
    expect(saveFile).toHaveBeenCalledWith('/tmp/draft.md', 'recovered preview edit');
    expect(ctx.dirty).toBe(false);
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
  it('waits for an in-flight save beyond 400 ms before completing a discard fence', async () => {
    vi.useFakeTimers();
    let releaseSave: (() => void) | undefined;
    try {
      const saveFile = vi.fn(() => new Promise<{ saved: boolean; filePath: string }>((resolve) => {
        releaseSave = () => resolve({ saved: true, filePath: '/tmp/draft.md' });
      }));
      const { ctx, lifecycle } = setup(saveFile);
      ctx.currentPath = '/tmp/draft.md';
      ctx.dirty = true;
      lifecycle.beginCloseLease('lease-1');

      const saving = lifecycle.save();
      await vi.advanceTimersByTimeAsync(0);
      expect(saveFile).toHaveBeenCalledOnce();

      const fence = lifecycle.fenceDiscard('lease-1');
      let fenced = false;
      void fence.then(() => { fenced = true; });
      await vi.advanceTimersByTimeAsync(401);

      expect(fenced).toBe(false);

      releaseSave!();
      await expect(saving).resolves.toBe(0);
      await expect(fence).resolves.toBe(true);
    } finally {
      releaseSave?.();
      vi.useRealTimers();
    }
  });
  it('re-arms autosave after discard rollback for a dirty named document', async () => {
    vi.useFakeTimers();
    const { ctx, lifecycle, saveFile } = setup();
    ctx.currentPath = '/tmp/draft.md';
    ctx.dirty = true;
    lifecycle.beginCloseLease('lease-1');

    await lifecycle.fenceDiscard('lease-1');
    lifecycle.rollbackDiscardFence('lease-1');
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
    expect((ctx.preview.el as HTMLElement).contentEditable).toBe('false');
    expect(lifecycle.replaceDocument({ doc: 'edited', currentPath: '/tmp/other.md', pendingTitle: 'other.md', dirty: false })).toBe(false);
    lifecycle.onDocChange('edited');

    expect(getDoc()).toBe('draft');
    expect(ctx.currentPath).toBe('/tmp/draft.md');
    expect(ctx.docRevision).toBe(0);
    expect(ctx.dirty).toBe(true);
    lifecycle.rollbackDiscardFence('lease-1');
    expect(mutationFenced()).toBe(false);
    expect((ctx.preview.el as HTMLElement).contentEditable).toBe('true');
    expect(lifecycle.authorizeCloseLease('lease-1')).toBe(false);
  });
  it('ignores an old rollback after a new lease starts, then restores only the matching lease', async () => {
    const { ctx, lifecycle, mutationFenced } = setup();
    ctx.currentPath = '/tmp/draft.md';
    ctx.dirty = false;
    lifecycle.beginCloseLease('lease-1');
    await expect(lifecycle.fenceDiscard('lease-1')).resolves.toBe(true);
    expect(lifecycle.consumeCloseLease('lease-1')).toBe(true);

    lifecycle.beginCloseLease('lease-2');
    expect(mutationFenced()).toBe(false);
    expect((ctx.preview.el as HTMLElement).contentEditable).toBe('true');
    await expect(lifecycle.save()).resolves.toBe(0);

    await expect(lifecycle.fenceDiscard('lease-2')).resolves.toBe(true);
    expect(lifecycle.consumeCloseLease('lease-2')).toBe(true);
    expect(lifecycle.rollbackDiscardFence('lease-1')).toBe(false);
    expect(mutationFenced()).toBe(true);
    expect((ctx.preview.el as HTMLElement).contentEditable).toBe('false');

    expect(lifecycle.rollbackDiscardFence('lease-2')).toBe(true);
    expect(mutationFenced()).toBe(false);
    expect((ctx.preview.el as HTMLElement).contentEditable).toBe('true');
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
  it('keeps an active quiesce lease alive with heartbeats', async () => {
    vi.useFakeTimers();
    try {
      const { lifecycle, mutationFenced } = setup();
      const pause = vi.fn(() => true);
      const resume = vi.fn();
      lifecycle.setPreviewQuiesceHooks({ pause, resume });

      await expect(lifecycle.prepareCloseQuiesce('transaction', 100)).resolves.toBe(true);
      await vi.advanceTimersByTimeAsync(90);
      expect(lifecycle.heartbeatCloseQuiesce('transaction', 100)).toBe(true);
      await vi.advanceTimersByTimeAsync(90);

      expect(mutationFenced()).toBe(true);
      expect(resume).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(11);
      expect(mutationFenced()).toBe(false);
      expect(resume).toHaveBeenCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('autonomously rolls back an abandoned quiesce lease', async () => {
    vi.useFakeTimers();
    try {
      const { lifecycle, mutationFenced } = setup();
      await expect(lifecycle.prepareCloseQuiesce('lost-main', 20)).resolves.toBe(true);
      expect(lifecycle.tryMutateDocument()).toBe(false);

      await vi.advanceTimersByTimeAsync(20);

      expect(mutationFenced()).toBe(false);
      expect(lifecycle.tryMutateDocument()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it('keeps manual save fenced after a failed close preview sync', async () => {
    const { ctx, lifecycle, saveFile } = setup();
    ctx.currentPath = '/tmp/draft.md';
    ctx.dirty = true;
    lifecycle.markPreviewSyncFailed();

    await expect(lifecycle.save()).resolves.toBeNull();

    expect(saveFile).not.toHaveBeenCalled();
    expect(ctx.dirty).toBe(true);
  });

  it('flushes pending preview data through the internal compensation gate before reopening quiesce', async () => {
    const { ctx, lifecycle, getDoc } = setup();
    ctx.currentPath = '/tmp/draft.md';
    lifecycle.setPreviewFlushGate(() => {
      expect(lifecycle.tryMutateDocument()).toBe(true);
      ctx.editor.setDoc('preview edit');
    });

    await lifecycle.prepareCloseQuiesce('tx', 1_000);
    await expect(lifecycle.rollbackCloseQuiesce('tx')).resolves.toBe(true);

    expect(getDoc()).toBe('preview edit');
    expect(lifecycle.tryMutateDocument()).toBe(true);
  });

  it('keeps discard fencing active when quiesce TTL expires and invalidates the lease', async () => {
    vi.useFakeTimers();
    try {
      const { ctx, lifecycle, sendCloseLeaseInvalidated, mutationFenced } = setup();
      ctx.currentPath = '/tmp/draft.md';
      lifecycle.beginCloseLease('lease');
      await lifecycle.prepareCloseQuiesce('tx', 20);
      await lifecycle.fenceDiscard('lease');

      await vi.advanceTimersByTimeAsync(20);

      expect(lifecycle.isSaveFenced()).toBe(true);
      expect(mutationFenced()).toBe(true);
      expect(sendCloseLeaseInvalidated).not.toHaveBeenCalled();
      expect(lifecycle.authorizeCloseLease('lease')).toBe(true);
      expect(lifecycle.rollbackDiscardFence('lease')).toBe(true);
      expect(mutationFenced()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
