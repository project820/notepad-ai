// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPreview } from './preview';
import { initPaneSync } from './pane-sync';
import { createRafThrottle } from './raf-throttle';

type Frame = { id: number; cb: FrameRequestCallback };
function setup() {
  const frames: Frame[] = [];
  let next = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = ++next;
    frames.push({ id, cb });
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    const index = frames.findIndex((frame) => frame.id === id);
    if (index >= 0) frames.splice(index, 1);
  });
  const host = document.createElement('div');
  const editorHost = document.createElement('div');
  const scrollDOM = document.createElement('div');
  const contentDOM = document.createElement('div');
  document.body.append(host, editorHost, scrollDOM, contentDOM);
  const preview = createPreview(host);
  const view = {
    state: { doc: { lines: 1, line: () => ({ from: 0 }) }, field: () => null },
    scrollDOM,
    contentDOM,
    coordsAtPos: () => ({ top: 0 }),
    lineBlockAt: () => ({ top: 0 }),
    dispatch: vi.fn(),
  };
  const ctx = {
    preview,
    previewMode: 'split',
    showingConvertedHtml: false,
    editingInPreview: false,
    editor: {
      view,
      onSelectionChange: () => {},
      setHighlightedLines: () => {},
      clearHighlight: () => {},
    },
  } as any;
  initPaneSync(ctx, { prefs: { rawLineAlign: true } as never, editorHost, createRafThrottle });
  const flush = () => {
    while (frames.length) frames.shift()!.cb(0);
  };
  return { preview, frames, flush };
}
function watchVisibility(el: HTMLElement) {
  let writes = 0;
  const observer = new MutationObserver((records) => { writes += records.length; });
  observer.observe(el, { attributes: true, attributeFilter: ['style'] });
  return { get writes() { return writes; }, async settle() { await Promise.resolve(); observer.disconnect(); } };
}
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('R4 reveal lease', () => {
  it('measures only while hidden, then reveals exactly once with no post-reveal shift', async () => {
    const { preview, flush } = setup();
    const visibility = watchVisibility(preview.el);
    let visibleMeasures = 0;
    const rect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const previewNode = this.classList.contains('preview') ? this : this.closest<HTMLElement>('.preview');
      if (previewNode && previewNode.style.visibility !== 'hidden') visibleMeasures += 1;
      return rect.call(this);
    });
    preview.setDoc('one\n');
    expect(preview.el.style.visibility).toBe('hidden');
    flush();
    await visibility.settle();
    expect(visibility.writes).toBe(2); // hide + exactly one reveal lease settlement
    expect(preview.el.style.visibility).toBe('');
    expect(visibleMeasures).toBe(0); // postRevealLayoutShiftPx=0 / visibleReflowCount=1
  });

  it('rolls back and reveals exactly once when render settlement fails', async () => {
    const { preview } = setup();
    const visibility = watchVisibility(preview.el);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    preview.onAfterRender(() => { throw new Error('tag failure'); });
    preview.setDoc('one\n');
    await visibility.settle();
    expect(visibility.writes).toBe(2);
    expect(preview.el.style.visibility).toBe('');
    expect(preview.el.hasAttribute('data-preview-align-pending')).toBe(false);
    warning.mockRestore();
  });

  it('settles a cancelled generation exactly once and never executes stale rAF work', async () => {
    const { preview, frames, flush } = setup();
    const visibility = watchVisibility(preview.el);
    preview.setDoc('one\n');
    const first = frames.length;
    preview.setDoc('two\n');
    expect(frames.length).toBe(first); // first lease rAF was cancelled before a replacement was scheduled
    flush();
    await visibility.settle();
    expect(visibility.writes).toBe(4); // first hide/reveal, then second hide/reveal
    expect(preview.el.style.visibility).toBe('');
    expect(preview.el.hasAttribute('data-preview-align-pending')).toBe(false);
  });
});
