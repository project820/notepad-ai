// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { Locale } from './i18n';

const { applyToPreview, createToolbar, savePrefs } = vi.hoisted(() => ({
  applyToPreview: vi.fn(),
  createToolbar: vi.fn(),
  savePrefs: vi.fn(),
}));

vi.mock('./toolbar', () => ({ createToolbar }));
vi.mock('./formatting', () => ({ applyToEditor: vi.fn(), applyToPreview }));
vi.mock('./prefs', () => ({
  savePrefs,
  applyTheme: vi.fn(),
  applyFontSize: vi.fn(),
  resolvedDark: vi.fn(),
}));

import { createAppContext } from './app-context';
import { initToolbarWiring } from './toolbar-wiring';

describe('preview formatting close fence', () => {
  it('does not focus or mutate the preview after a consumed close lease, then resumes after rollback', () => {
    const ctx = createAppContext(document.createElement('div'));
    const preview = document.createElement('div');
    preview.textContent = 'unchanged';
    const focus = vi.spyOn(preview, 'focus');
    ctx.activeSurface = 'preview';
    ctx.setHandles({
      view: {} as never,
      getDoc: () => '',
      setDoc: () => {},
      setMutationFence: () => {},
      insertTable: () => {},
      focus: () => {},
      undo: () => {},
      redo: () => {},
      applyTheme: () => {},
      onSelectionChange: () => {},
      setHighlightedLines: () => {},
      clearHighlight: () => {},
    }, {
      el: preview,
      setDoc: () => {},
      setLineNumbers: () => {},
      getSourceMap: () => [],
      getRunTable: () => null,
      onAfterRender: () => {},
      onBeforeRender: () => {},
      onRenderSettled: () => {},
      commitSourcePatch: () => ({ ok: false, markdown: '', reason: 'stub' }),
    });

    let mayMutate = false;
    const syncPreviewToSource = vi.fn();
    const { dispatchFormat } = initToolbarWiring(ctx, {
      toolbarHost: document.createElement('div'),
      prefs: { theme: 'system', fontSize: 'md' },
      t: ((key: string) => key) as never,
      getLocale: (() => 'en') as never,
      loadModelsCached: async () => [],
      getAuth: () => ({ signedIn: false }),
      setAuth: () => {},
      paintAuthPill: () => {},
      requestLocaleRestart: async () => false,
      toggleUnifiedChat: () => {},
      toggleLeftPanel: () => {},
      openSettings: () => {},
      applyTypography: () => {},
      scheduleLineAlign: () => {},
      syncPreviewToSource,
      cyclePreviewMode: () => {},
      flushPreviewToSource: () => false,
      tryMutateDocument: () => mayMutate,
    });

    dispatchFormat('bold');

    expect(preview.textContent).toBe('unchanged');
    expect(focus).not.toHaveBeenCalled();
    expect(applyToPreview).not.toHaveBeenCalled();
    expect(syncPreviewToSource).not.toHaveBeenCalled();

    mayMutate = true;
    dispatchFormat('bold');

    expect(focus).toHaveBeenCalledOnce();
    expect(applyToPreview).toHaveBeenCalledWith('bold');
    expect(syncPreviewToSource).toHaveBeenCalledOnce();
    expect(ctx.editingInPreview).toBe(true);
  });
});
describe('locale restart persistence', () => {
  it('defers saving the selected locale until restart confirmation', () => {
    vi.clearAllMocks();
    const prefs = { theme: 'system' as const, fontSize: 'md' as const };
    const requestLocaleRestart = vi.fn(async (_locale: Locale, _persist: () => void) => false);

    initToolbarWiring(createAppContext(document.createElement('div')), {
      toolbarHost: document.createElement('div'),
      prefs,
      t: ((key: string) => key) as never,
      getLocale: (() => 'en') as never,
      loadModelsCached: async () => [],
      getAuth: () => ({ signedIn: false }),
      setAuth: () => {},
      paintAuthPill: () => {},
      requestLocaleRestart,
      toggleUnifiedChat: () => {},
      toggleLeftPanel: () => {},
      openSettings: () => {},
      applyTypography: () => {},
      scheduleLineAlign: () => {},
      syncPreviewToSource: () => {},
      cyclePreviewMode: () => {},
      flushPreviewToSource: () => false,
      tryMutateDocument: () => true,
    });

    const handlers = createToolbar.mock.calls[0][1] as { onLocaleChange: (locale: Locale) => void };
    handlers.onLocaleChange('ko');

    expect(requestLocaleRestart).toHaveBeenCalledWith('ko', expect.any(Function));
    expect(prefs).not.toHaveProperty('locale');
    expect(savePrefs).not.toHaveBeenCalled();

    const persist = requestLocaleRestart.mock.calls[0][1];
    persist();

    expect(prefs).toMatchObject({ locale: 'ko' });
    expect(savePrefs).toHaveBeenCalledWith(prefs);
  });
});
