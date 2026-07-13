// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppContext } from './app-context';
import { initDocLifecycle } from './doc-lifecycle';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('document open loading indicator', () => {
  it('shows a spinner for the frame before a large document render and removes it after render', () => {
    const host = document.createElement('div');
    const previewEl = document.createElement('div');
    host.appendChild(previewEl);
    document.body.appendChild(host);
    const ctx = createAppContext(document.createElement('div'));
    let doc = '';
    const setPreviewDoc = vi.fn();
    ctx.setHandles({
      view: {} as never,
      getDoc: () => doc,
      setDoc: (next) => { doc = next; },
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
      el: previewEl,
      setDoc: setPreviewDoc,
      setLineNumbers: () => {},
      getSourceMap: () => [],
      getRunTable: () => null,
      onAfterRender: () => {},
      onBeforeRender: () => {},
      onRenderSettled: () => {},
      commitSourcePatch: () => ({ ok: false, markdown: '', reason: 'stub' }),
    });
    let onFileOpened: ((payload: unknown) => void) | null = null;
    let renderFrame: FrameRequestCallback | null = null;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      renderFrame = callback;
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const lifecycle = initDocLifecycle(ctx, {
      api: {
        onFileOpened: (callback: (payload: unknown) => void) => { onFileOpened = callback; },
      } as never,
      titleEl: document.createElement('input'),
      dirtyEl: document.createElement('div'),
      t: ((key: string) => key) as never,
      htmlToMarkdown: ((html: string) => html) as never,
      buildConvertedHtmlFrame: (() => document.createElement('iframe')) as never,
      updateWordCount: () => {},
      scheduleSessionSnapshot: () => {},
      syncWorkspaceRootToCurrent: () => {},
      updateHtmlViewToggle: () => {},
      createRafThrottle: (() => ({ schedule: (callback: () => void) => callback(), cancel: () => {} })) as never,
    });

    lifecycle.wireFileOpened();
    onFileOpened!({ filePath: '/tmp/large.md', content: 'large document' });
    expect(host.querySelector('.preview-loading')).not.toBeNull();
    expect(previewEl.getAttribute('aria-busy')).toBe('true');

    renderFrame!(0);
    expect(host.querySelector('.preview-loading')).not.toBeNull();
    renderFrame!(16);
    expect(doc).toBe('large document');
    expect(setPreviewDoc).toHaveBeenCalledWith('large document');
    expect(host.querySelector('.preview-loading')).toBeNull();
    expect(previewEl.hasAttribute('aria-busy')).toBe(false);
  });
});
