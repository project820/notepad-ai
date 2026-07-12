import { createMarkdownIt } from './markdown-it';
import {
  buildRunTable,
  buildTokenLineRangesFromTokens,
  injectRunIds,
  tagNestedPreviewBlocksFromTokens,
  tagPreviewBlocks,
  validateDom,
  type SourceLineRange,
} from './source-preview-map';
import { assembleSource, type RunTable } from './source-journal';
import { serializeChangedRun } from './fragment-serialize';

export type RenderSettled = { ok: boolean };
export type PreviewHandle = {
  el: HTMLDivElement;
  setDoc: (md: string) => void;
  /** Atomically serializes changed runs, reparses, retags and swaps the preview. */
  commitSourcePatch: (source: string, changedRunIds: readonly number[]) => { ok: boolean; markdown: string; reason?: string };
  onBeforeRender: (cb: () => (() => void) | void) => void;
  onAfterRender: (cb: () => void) => void;
  onRenderSettled: (cb: (result: RenderSettled) => void) => void;
  setLineNumbers: (enabled: boolean) => void;
  getSourceMap: () => readonly SourceLineRange[];
  getRunTable: () => RunTable | null;
};

function ownerSelector(subtype: RunTable['runs'][number]['subtype']): string {
  switch (subtype) {
    // ATX and setext headings both render to h1–h6.
    case 'heading': return 'h1,h2,h3,h4,h5,h6';
    // A list item's marker/prefix belongs to the journal, so its rendered li is
    // the run owner even when markdown-it emits a visible paragraph inside it.
    case 'list-item-content': return 'li';
    case 'quote-paragraph': return 'blockquote p';
    case 'table-cell': return 'th,td';
    // Fenced and indented code each render as pre > code. The pre owns the
    // run because it remains present for both render rules.
    case 'fence-body': return 'pre,pre > code';
    case 'deflist-item': return 'dd';
    case 'paragraph': return 'p';
  }
}

function bookmark(root: HTMLElement): { runId: string | null; offset: number } | null {
  const selection = window.getSelection();
  const anchor = selection?.rangeCount ? selection.anchorNode : null;
  if (!selection || !anchor || !root.contains(anchor)) return null;
  const owner = (anchor.nodeType === Node.ELEMENT_NODE ? anchor as Element : anchor.parentElement)?.closest('[data-run-id]');
  if (!owner) return null;
  return { runId: owner.getAttribute('data-run-id'), offset: selection.anchorOffset };
}

function restoreBookmark(root: HTMLElement, value: ReturnType<typeof bookmark>): void {
  if (!value?.runId) return;
  const owner = root.querySelector<HTMLElement>(`[data-run-id="${value.runId}"]`);
  if (!owner) return;
  const text = owner.firstChild;
  if (!text) return;
  const range = document.createRange();
  range.setStart(text, Math.min(value.offset, text.textContent?.length ?? 0));
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export function createPreview(parent: HTMLElement): PreviewHandle {
  const md = createMarkdownIt();
  const el = document.createElement('div');
  el.className = 'preview';
  parent.appendChild(el);
  el.setAttribute('contenteditable', 'true');
  el.setAttribute('spellcheck', 'false');

  const afterCallbacks: Array<() => void> = [];
  const beforeCallbacks: Array<() => (() => void) | void> = [];
  const settledCallbacks: Array<(result: RenderSettled) => void> = [];
  let sourceMap: SourceLineRange[] = [];
  let runTable: RunTable | null = null;

  function render(source: string): void {
    const rollback = beforeCallbacks.map((cb) => cb()).filter((release): release is () => void => typeof release === 'function');
    try {
      const env = {};
      const tokens = md.parse(source, env);
      const built = buildRunTable(tokens, source);
      injectRunIds(tokens, built.runTable);
      el.innerHTML = md.renderer.render(tokens, md.options, env);
      sourceMap = buildTokenLineRangesFromTokens(tokens);
      tagPreviewBlocks(el, sourceMap);
      tagNestedPreviewBlocksFromTokens(el, tokens);

      try {
        // Some markdown-it renderers (fence and hidden tight-list paragraphs)
        // do not propagate token attributes. Attach their owner id once, in
        // document order, using the subtype's actual rendered owner.
        for (const run of built.runTable.runs) {
          let owner = el.querySelector<HTMLElement>(`[data-run-id="${run.runId}"]`);
          if (!owner) {
            owner = Array.from(el.querySelectorAll<HTMLElement>(ownerSelector(run.subtype)))
              .find((node) => !node.hasAttribute('data-run-id')) ?? null;
          }
          if (!owner) throw new Error(`preview run ${run.runId} has no DOM owner`);
          owner.dataset.runId = String(run.runId);
          owner.dataset.sourceSliceCount = String(run.sourceSlices.length);
          if (run.syntheticIndentPrefixes) owner.dataset.syntheticIndentPrefixes = JSON.stringify(run.syntheticIndentPrefixes);
        }
        validateDom(el, built.runTable);
        runTable = built.runTable;
      } catch (error) {
        // Source journaling is an optional enhancement. A renderer/plugin shape
        // we cannot map must preserve the established preview and line-span
        // tagging behavior rather than making ordinary documents unrenderable.
        console.warn('preview source journal unavailable; using line-span map only:', error);
        el.querySelectorAll<HTMLElement>('[data-run-id]').forEach((owner) => {
          owner.removeAttribute('data-run-id');
          owner.removeAttribute('data-source-slice-count');
          owner.removeAttribute('data-synthetic-indent-prefixes');
        });
        runTable = null;
      }
      afterCallbacks.forEach((cb) => cb());
      settledCallbacks.forEach((cb) => cb({ ok: true }));
    } catch (error) {
      runTable = null;
      rollback.forEach((release) => release());
      settledCallbacks.forEach((cb) => cb({ ok: false }));
      console.warn('preview render failed:', error);
    }
  }

  return {
    el,
    setDoc: render,
    commitSourcePatch: (source, changedRunIds) => {
      if (!runTable || runTable.source !== source) return { ok: false, markdown: source, reason: 'stale-source-journal' };
      const changed = [] as Array<{ runId: number; segments: readonly string[] }>;
      for (const id of changedRunIds) {
        const run = runTable.runs.find((entry) => entry.runId === id);
        const node = el.querySelector<HTMLElement>(`[data-run-id="${id}"]`);
        if (!run || !node) return { ok: false, markdown: source, reason: 'missing-run-owner' };
        const serialized = serializeChangedRun(run.subtype, node);
        if (serialized.kind === 'rerender') return { ok: false, markdown: source, reason: serialized.reason };
        changed.push({ runId: id, segments: serialized.kind === 'verbatim' ? [serialized.text] : serialized.segments });
      }
      const markdown = assembleSource(runTable, changed);
      const savedBookmark = bookmark(el);
      try {
        render(markdown);
        restoreBookmark(el, savedBookmark);
        return { ok: true, markdown };
      } catch {
        // Controlled rerender always restores canonical source rather than
        // leaving a partially edited DOM visible.
        try { render(source); } catch { /* render() already notified the coordinator */ }
        return { ok: false, markdown: source, reason: 'controlled-rerender' };
      }
    },
    onBeforeRender: (cb) => { beforeCallbacks.push(cb); },
    onAfterRender: (cb) => { afterCallbacks.push(cb); },
    onRenderSettled: (cb) => { settledCallbacks.push(cb); },
    setLineNumbers: (enabled) => { el.classList.toggle('preview-line-numbers', enabled); },
    getSourceMap: () => sourceMap,
    getRunTable: () => runTable,
  };
}
