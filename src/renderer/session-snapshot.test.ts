// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLocale, setLocale } from './i18n';
import { initSessionSnapshot } from './session-snapshot';
import type { AppContext } from './app-context';

function createSessionSnapshot() {
  const ctx = {
    currentPath: null,
    pendingTitle: null,
    previewMode: 'split',
    dirty: false,
    editor: { getDoc: () => 'draft' },
  } as AppContext;
  return initSessionSnapshot(ctx, {
    prefs: { theme: 'system', fontSize: 'md' },
    unifiedChat: { restore: () => {} } as never,
    getUnifiedChatHistory: () => [],
    setUnifiedChatHistory: () => {},
    setUnifiedChatOpen: () => {},
    applyPreviewMode: () => {},
    replaceDocument: () => {},
  });
}

afterEach(() => {
  setLocale('en');
  delete (window as any).confirm;
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.replaceChildren();
});
function createRestoreHarness(response: unknown) {
  const replaceDocument = vi.fn();
  const applyPreviewMode = vi.fn();
  const setUnifiedChatHistory = vi.fn();
  const unifiedRestore = vi.fn();
  const setStatus = vi.fn();
  const ctx = {
    currentPath: null,
    pendingTitle: null,
    previewMode: 'split',
    dirty: false,
    editor: { getDoc: () => 'draft' },
    setStatus,
  } as unknown as AppContext;
  (window as any).api = {
    sessionGet: vi.fn(async () => response),
    sessionWrite: vi.fn(async () => {}),
    sessionClear: vi.fn(async () => {}),
  };
  initSessionSnapshot(ctx, {
    prefs: { theme: 'system', fontSize: 'md' },
    unifiedChat: { restore: unifiedRestore } as never,
    getUnifiedChatHistory: () => [{ type: 'separator', label: 'restored' }],
    setUnifiedChatHistory,
    setUnifiedChatOpen: vi.fn(),
    applyPreviewMode,
    replaceDocument,
  });
  return { replaceDocument, applyPreviewMode, setUnifiedChatHistory, unifiedRestore, sessionClear: (window as any).api.sessionClear };
}

describe('session restore mode', () => {
  it('applies shutdown restores immediately without creating a banner', async () => {
    vi.useFakeTimers();
    const restore = createRestoreHarness({
      snapshot: {
        doc: 'shutdown draft',
        path: '/restored.md',
        title: 'Restored',
        dirty: true,
        view: 'preview-only',
        unifiedChatHistory: [{ type: 'separator', label: 'restored' }],
      },
      restoreReason: 'shutdown',
    });

    await Promise.resolve();

    expect(restore.replaceDocument).toHaveBeenCalledWith({
      doc: 'shutdown draft',
      currentPath: '/restored.md',
      pendingTitle: 'Restored',
      dirty: true,
    });
    expect(restore.applyPreviewMode).toHaveBeenCalledOnce();
    expect(restore.setUnifiedChatHistory).toHaveBeenCalledOnce();
    expect(restore.unifiedRestore).toHaveBeenCalledOnce();
    expect(document.querySelector('.restore-yes')).toBeNull();
  });

  it('keeps crash restores behind the banner and clears on No', async () => {
    vi.useFakeTimers();
    const restore = createRestoreHarness({ snapshot: { doc: 'crash draft' } });

    await Promise.resolve();
    expect(restore.replaceDocument).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);

    expect(document.querySelector('.restore-yes')).not.toBeNull();
    (document.querySelector('.restore-no') as HTMLButtonElement).click();
    expect(restore.sessionClear).toHaveBeenCalledOnce();
    expect(restore.replaceDocument).not.toHaveBeenCalled();
  });

  it('applies crash restores only after Yes, including after a consumed shutdown marker', async () => {
    vi.useFakeTimers();
    createRestoreHarness({
      snapshot: { doc: 'shutdown draft' },
      restoreReason: 'shutdown',
    });
    await Promise.resolve();
    document.body.replaceChildren();

    const restore = createRestoreHarness({ snapshot: { doc: 'next crash draft' } });
    await Promise.resolve();
    expect(restore.replaceDocument).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);

    (document.querySelector('.restore-yes') as HTMLButtonElement).click();
    expect(restore.replaceDocument).toHaveBeenCalledWith({
      doc: 'next crash draft',
      currentPath: null,
      pendingTitle: null,
      dirty: false,
    });
  });
  it('reopens path-only shutdown restores via openFileInCurrent', async () => {
    const openFileInCurrent = vi.fn(async () => ({ opened: true }));
    const replaceDocument = vi.fn();
    const ctx = {
      currentPath: null,
      pendingTitle: null,
      previewMode: 'split',
      dirty: false,
      editor: { getDoc: () => '' },
      setStatus: vi.fn(),
    } as unknown as AppContext;
    (window as any).api = {
      sessionGet: vi.fn(async () => ({
        snapshot: { path: '/tmp/opening.md', doc: '', title: null, dirty: false },
        restoreReason: 'shutdown',
      })),
      sessionWrite: vi.fn(async () => {}),
      sessionClear: vi.fn(async () => {}),
      openFileInCurrent,
    };
    initSessionSnapshot(ctx, {
      prefs: { theme: 'system', fontSize: 'md' },
      unifiedChat: { restore: vi.fn() } as never,
      getUnifiedChatHistory: () => [],
      setUnifiedChatHistory: vi.fn(),
      setUnifiedChatOpen: vi.fn(),
      applyPreviewMode: vi.fn(),
      replaceDocument,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(openFileInCurrent).toHaveBeenCalledWith('/tmp/opening.md');
    expect(replaceDocument).not.toHaveBeenCalled();
  });
});

describe('buildSessionSnapshot', () => {
  it('returns the same current payload used by scheduled writes', () => {
    (window as any).api = { sessionGet: vi.fn(async () => undefined) };

    const snapshot = createSessionSnapshot().buildSessionSnapshot();

    expect(snapshot).toMatchObject({
      path: null,
      title: null,
      doc: 'draft',
      view: 'split',
      unifiedChatHistory: [],
      dirty: false,
    });
    expect(snapshot.savedAt).toEqual(expect.any(Number));
  });
});
describe('requestLocaleRestart', () => {
  it('leaves locale and preferences untouched when restart is cancelled', async () => {
    const sessionWrite = vi.fn(async () => {});
    const relaunchApp = vi.fn(async () => {});
    (window as any).api = { sessionGet: vi.fn(async () => undefined), sessionWrite, relaunchApp };
    Object.defineProperty(window, 'confirm', { configurable: true, value: vi.fn(() => false) });
    const persist = vi.fn();

    const confirmed = await createSessionSnapshot().requestLocaleRestart('ko', persist);

    expect(confirmed).toBe(false);
    expect(getLocale()).toBe('en');
    expect(persist).not.toHaveBeenCalled();
    expect(sessionWrite).not.toHaveBeenCalled();
    expect(relaunchApp).not.toHaveBeenCalled();
  });

  it('applies, persists, flushes, and relaunches after confirmation', async () => {
    const calls: string[] = [];
    const sessionWrite = vi.fn(async () => { calls.push('flush'); });
    const relaunchApp = vi.fn(async () => { calls.push('relaunch'); });
    (window as any).api = { sessionGet: vi.fn(async () => undefined), sessionWrite, relaunchApp };
    Object.defineProperty(window, 'confirm', { configurable: true, value: vi.fn(() => true) });
    const persist = vi.fn(() => { calls.push('persist'); });

    const confirmed = await createSessionSnapshot().requestLocaleRestart('ko', persist);

    expect(confirmed).toBe(true);
    expect(getLocale()).toBe('ko');
    expect(persist).toHaveBeenCalledOnce();
    expect(calls).toEqual(['persist', 'flush', 'relaunch']);
  });
});
