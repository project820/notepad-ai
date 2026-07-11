import { createSelectionSync, clearPreviewHighlight } from './selection-sync';
import { collectPreviewBlocks } from './source-preview-map';
import {
  setLineSpacers,
  clearLineSpacers,
  computeBidirectionalAlignment,
  MAX_SPACER_PX,
  type LineAlignmentBlock,
  type PreviewSpacer,
} from './cm-line-alignment';
import { interpolateScroll, normalizeAnchors, type ScrollAnchor } from './scroll-sync';
import type { AppContext } from './app-context';
import type { Prefs } from './prefs';
import type { createRafThrottle } from './raf-throttle';

const MAX_ALIGN_SPACERS = 400;
const MAX_MEASURE_BLOCKS = 3000;
const PREVIEW_SHIFT_ATTR = 'data-line-align-shift';

type PaneSyncDeps = {
  prefs: Prefs;
  editorHost: HTMLElement;
  createRafThrottle: typeof createRafThrottle;
};

export function initPaneSync(ctx: AppContext, deps: PaneSyncDeps) {
  const selectionSync = createSelectionSync({
    getPreviewRoot: () => ctx.preview.el,
    editor: {
      setHighlightedLines: (lines) => ctx.editor.setHighlightedLines(lines),
      clearHighlight: () => ctx.editor.clearHighlight(),
    },
    isActive: () => ctx.previewMode === 'split' && !ctx.showingConvertedHtml,
    getSelection: () => window.getSelection(),
  });

  const editorToPreviewSync = deps.createRafThrottle();
  ctx.editor.onSelectionChange((span) => editorToPreviewSync(() => selectionSync.syncEditorToPreview(span)));

  const previewToEditorSync = deps.createRafThrottle();
  document.addEventListener('selectionchange', () => previewToEditorSync(() => selectionSync.syncPreviewToEditor()));
  ctx.preview.onAfterRender(() => selectionSync.clearAll());
  deps.editorHost.addEventListener('focusout', () => {
    requestAnimationFrame(() => {
      if (!deps.editorHost.contains(document.activeElement)) clearPreviewHighlight(ctx.preview.el);
    });
  });

  function lineAlignActive(): boolean {
    return (
      (deps.prefs.rawLineAlign ?? false) &&
      ctx.previewMode === 'split' &&
      !ctx.showingConvertedHtml &&
      !ctx.editingInPreview
    );
  }

  function clearPreviewOffsets(root: HTMLElement): void {
    root.querySelectorAll<HTMLElement>(`[${PREVIEW_SHIFT_ATTR}]`).forEach((el) => {
      el.style.marginTop = '';
      el.removeAttribute(PREVIEW_SHIFT_ATTR);
    });
  }

  function setPreviewOffsets(root: HTMLElement, spacers: readonly PreviewSpacer[]): void {
    clearPreviewOffsets(root);
    if (spacers.length === 0) return;
    const elByMapId = new Map<number, HTMLElement>();
    for (const child of Array.from(root.children)) {
      const id = child.getAttribute('data-map-id');
      if (id != null) elByMapId.set(Number(id), child as HTMLElement);
    }
    for (const s of spacers) {
      let h = Number.isFinite(s.heightPx) ? s.heightPx : 0;
      if (h <= 0) continue;
      if (h > MAX_SPACER_PX) h = MAX_SPACER_PX;
      const block = elByMapId.get(s.mapId);
      if (!block) continue;
      const curMT = parseFloat(getComputedStyle(block).marginTop) || 0;
      const prev = block.previousElementSibling;
      const prevMB = prev ? parseFloat(getComputedStyle(prev).marginBottom) || 0 : 0;
      const naturalGap = Math.max(prevMB, curMT);
      block.style.marginTop = `${naturalGap + h}px`;
      block.setAttribute(PREVIEW_SHIFT_ATTR, '1');
    }
  }

  function measureLineAlignBlocks(): LineAlignmentBlock[] {
    if (ctx.preview.getSourceMap().length === 0) return [];
    const view = ctx.editor.view;
    const docLines = view.state.doc.lines;
    const cmTop = view.scrollDOM.getBoundingClientRect().top;
    const cmScrollTop = view.scrollDOM.scrollTop;
    const contentTop = view.contentDOM.getBoundingClientRect().top;
    const pRect = ctx.preview.el.getBoundingClientRect();
    const pScrollTop = ctx.preview.el.scrollTop;
    const out: LineAlignmentBlock[] = [];
    for (const block of collectPreviewBlocks(ctx.preview.el)) {
      if (block.startLine < 1 || block.startLine > docLines) continue;
      const pos = view.state.doc.line(block.startLine).from;
      const coords = view.coordsAtPos(pos);
      const lineViewportTop = coords ? coords.top : contentTop + view.lineBlockAt(pos).top;
      const editorTop = lineViewportTop - cmTop + cmScrollTop;
      const previewTop = (block.el as HTMLElement).getBoundingClientRect().top - pRect.top + pScrollTop;
      out.push({ line: block.startLine, mapId: block.mapId, previewTop, editorTop });
      if (out.length >= MAX_MEASURE_BLOCKS) break;
    }
    return out;
  }

  function applyLineAlign(): void {
    if (!lineAlignActive()) {
      clearLineSpacers(ctx.editor.view);
      clearPreviewOffsets(ctx.preview.el);
      return;
    }
    clearLineSpacers(ctx.editor.view);
    clearPreviewOffsets(ctx.preview.el);
    const blocks = measureLineAlignBlocks();
    if (blocks.length === 0) return;
    const { editorSpacers, previewSpacers } = computeBidirectionalAlignment(blocks, MAX_SPACER_PX);
    setLineSpacers(ctx.editor.view, editorSpacers.slice(0, MAX_ALIGN_SPACERS));
    setPreviewOffsets(ctx.preview.el, previewSpacers.slice(0, MAX_ALIGN_SPACERS));
  }

  const lineAlignThrottle = deps.createRafThrottle();
  function scheduleLineAlign(): void {
    lineAlignThrottle(applyLineAlign);
  }

  let scrollAnchors: ScrollAnchor[] = [];
  let anchorsDirty = true;
  let lastEdScrollH = -1;
  let lastPvScrollH = -1;
  function invalidateScrollAnchors(): void {
    anchorsDirty = true;
  }
  function rebuildScrollAnchors(): void {
    anchorsDirty = false;
    scrollAnchors =
      ctx.previewMode === 'split'
        ? normalizeAnchors(measureLineAlignBlocks().map((b) => ({ ed: b.editorTop, pv: b.previewTop })))
        : [];
  }

  let expectedEdTop = -1;
  let expectedPvTop = -1;
  function syncScroll(from: 'ed' | 'pv'): void {
    if (ctx.editingInPreview || ctx.previewMode !== 'split') return;
    const cm = ctx.editor.view.scrollDOM;
    const srcEl = from === 'ed' ? cm : ctx.preview.el;
    const expected = from === 'ed' ? expectedEdTop : expectedPvTop;
    if (expected >= 0 && Math.abs(srcEl.scrollTop - expected) <= 1) {
      if (from === 'ed') expectedEdTop = -1;
      else expectedPvTop = -1;
      return;
    }
    if (from === 'ed') expectedEdTop = -1;
    else expectedPvTop = -1;

    const edMax = cm.scrollHeight - cm.clientHeight;
    const pvMax = ctx.preview.el.scrollHeight - ctx.preview.el.clientHeight;
    if (cm.scrollHeight !== lastEdScrollH || ctx.preview.el.scrollHeight !== lastPvScrollH) anchorsDirty = true;
    if (anchorsDirty) {
      rebuildScrollAnchors();
      lastEdScrollH = cm.scrollHeight;
      lastPvScrollH = ctx.preview.el.scrollHeight;
    }
    const srcMax = from === 'ed' ? edMax : pvMax;
    const dstMax = from === 'ed' ? pvMax : edMax;
    const target = interpolateScroll(scrollAnchors, srcEl.scrollTop, from, srcMax, dstMax);
    const clamped = Math.max(0, Math.min(dstMax, target));
    if (from === 'ed') {
      expectedPvTop = clamped;
      ctx.preview.el.scrollTop = clamped;
    } else {
      expectedEdTop = clamped;
      cm.scrollTop = clamped;
    }
  }

  ctx.preview.onAfterRender(() => {
    invalidateScrollAnchors();
    scheduleLineAlign();
  });
  window.addEventListener('resize', () => {
    invalidateScrollAnchors();
    scheduleLineAlign();
  });
  ctx.editor.view.scrollDOM.addEventListener('scroll', () => syncScroll('ed'), { passive: true });
  ctx.preview.el.addEventListener('scroll', () => syncScroll('pv'), { passive: true });

  return { selectionSync, scheduleLineAlign };
}
