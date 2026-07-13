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
