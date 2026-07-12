// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';

const { applyToPreview, createToolbar } = vi.hoisted(() => ({
  applyToPreview: vi.fn(),
  createToolbar: vi.fn(),
}));

vi.mock('./toolbar', () => ({ createToolbar }));
vi.mock('./formatting', () => ({ applyToEditor: vi.fn(), applyToPreview }));

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
      onAfterRender: () => {},
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
      requestLocaleRestart: async () => {},
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
