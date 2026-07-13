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
import { applyStructuralEdit, assembleSource, structuralJournalSupport, type ClassifyResult, type NormalizedEdit, type RunTable } from './source-journal';
import { serializeChangedRun } from './fragment-serialize';

export const PREVIEW_JOURNAL_MAX_SOURCE_LENGTH = 24 * 1024;

type RenderSettled = { ok: boolean };
export type PreviewHandle = {
  el: HTMLDivElement;
  setDoc: (md: string) => void;
  /** Atomically serializes changed runs, reparses, retags and swaps the preview. */
  commitSourcePatch: (
    source: string,
    changedRunIds: readonly number[],
    structural?: { edit: NormalizedEdit; disposition: Exclude<ClassifyResult, { kind: 'single-block' | 'rerender' }> },
  ) => { ok: boolean; markdown: string; reason?: string };
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

export type PreviewBookmark = { runId: string | null; offset: number; path: number[] };

function nodePath(owner: Node, node: Node): number[] | null {
  const path: number[] = [];
  let current: Node | null = node;
  while (current && current !== owner) {
    const parent: Node | null = current.parentNode;
    if (!parent) return null;
    const index = Array.prototype.indexOf.call(parent.childNodes, current) as number;
    if (index < 0) return null;
    path.unshift(index);
    current = parent;
  }
  return current === owner ? path : null;
}

export function bookmark(root: HTMLElement): PreviewBookmark | null {
  const selection = window.getSelection();
  const anchor = selection?.rangeCount ? selection.anchorNode : null;
  if (!selection || !anchor || !root.contains(anchor)) return null;
  const owner = (anchor.nodeType === Node.ELEMENT_NODE ? anchor as Element : anchor.parentElement)?.closest('[data-run-id]');
  if (!owner) return null;
  const path = nodePath(owner, anchor);
  if (!path) return null;
  return { runId: owner.getAttribute('data-run-id'), offset: selection.anchorOffset, path };
}

function firstTextNode(node: Node): Text | null {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) return child as Text;
    const nested = firstTextNode(child);
    if (nested) return nested;
  }
  return null;
}

function nodeAtPath(owner: Node, path: readonly number[]): Node | null {
  let node: Node = owner;
  for (const index of path) {
    const child = node.childNodes[index];
    if (!child) return null;
    node = child;
  }
  return node;
}

export function restoreBookmark(root: HTMLElement, value: PreviewBookmark | null): void {
  if (!value?.runId) return;
  const owner = root.querySelector<HTMLElement>(`[data-run-id="${value.runId}"]`);
  if (!owner) return;
  const anchor = nodeAtPath(owner, value.path) ?? firstTextNode(owner) ?? owner;
  const range = document.createRange();
  const limit = anchor.nodeType === Node.TEXT_NODE
    ? (anchor as Text).data.length
    : anchor.childNodes.length;
  range.setStart(anchor, Math.min(value.offset, limit));
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
  function journalShapeMatches(
    markdown: string,
    structural?: { edit: NormalizedEdit; disposition: Exclude<ClassifyResult, { kind: 'single-block' | 'rerender' }> },
  ): boolean {
    if (!runTable) return false;
    const tokens = md.parse(markdown, {});
    const next = buildRunTable(tokens, markdown).runTable.runs;
    let expected = [...runTable.runs.map((run) => run.subtype)];
    if (structural) {
      const selected = structural.edit.affected.beforeIds
        .map((id) => runTable!.runs.findIndex((run) => run.runId === id))
        .filter((index) => index >= 0)
        .sort((a, b) => a - b);
      if (selected.length === 0) return false;
      const first = selected[0];
      if (structural.disposition.kind === 'split') expected.splice(first, 1, 'paragraph', 'paragraph');
      else if (structural.disposition.kind === 'multi-selection-replace') expected.splice(first, selected.length, 'paragraph');
      else expected.splice(first, selected.length);
    }
    return next.length === expected.length && next.every((run, index) => run.subtype === expected[index]);
  }
  function inlineSignature(node: Element): { text: string; tags: string[] } {
    const tags: string[] = [];
    const walk = (current: Node): void => {
      if (current.nodeType !== Node.ELEMENT_NODE) return;
      const element = current as Element;
      const tag = element.tagName.toLowerCase();
      tags.push(tag === 'a' ? `${tag}:${element.getAttribute('href') ?? ''}` : tag);
      element.childNodes.forEach(walk);
    };
    walk(node);
    return { text: node.textContent ?? '', tags };
  }

  function changedInlineMatches(markdown: string, changedIds: readonly number[]): boolean {
    if (!runTable) return false;
    const tokens = md.parse(markdown, {});
    const rebuilt = buildRunTable(tokens, markdown).runTable;
    injectRunIds(tokens, rebuilt);
    const detached = document.createElement('div');
    detached.innerHTML = md.renderer.render(tokens, md.options, {});
    for (const id of changedIds) {
      const original = runTable.runs.find((run) => run.runId === id);
      if (!original || original.subtype === 'fence-body') continue;
      const actual = el.querySelector<HTMLElement>(`[data-run-id="${id}"]`);
      const expected = detached.querySelector<HTMLElement>(`[data-run-id="${id}"]`);
      if (!actual || !expected) return false;
      const before = inlineSignature(actual);
      const after = inlineSignature(expected);
      if (before.text !== after.text || before.tags.join('|') !== after.tags.join('|')) return false;
    }
    return true;
  }
  function structuralInlineMatches(
    markdown: string,
    structural: { edit: NormalizedEdit; disposition: Exclude<ClassifyResult, { kind: 'single-block' | 'rerender' }> },
  ): boolean {
    // Deleted blocks have no surviving inline fragment to compare. Merge and
    // replacement owners are browser-dependent, so they intentionally take B6
    // until they have a stable owner mapping.
    if (structural.disposition.kind === 'whole-block-delete') return true;
    if (structural.disposition.kind !== 'split' || !runTable) return false;

    const originalId = structural.edit.affected.beforeIds[0];
    const actualLeft = el.querySelector<HTMLElement>(`[data-run-id="${originalId}"]`);
    const actualRight = actualLeft?.nextElementSibling as HTMLElement | null;
    if (!actualLeft || !actualRight || actualRight.hasAttribute('data-run-id')) return false;

    const tokens = md.parse(markdown, {});
    const rebuilt = buildRunTable(tokens, markdown).runTable;
    injectRunIds(tokens, rebuilt);
    const detached = document.createElement('div');
    detached.innerHTML = md.renderer.render(tokens, md.options, {});
    const expectedLeft = detached.querySelector<HTMLElement>(`[data-run-id="${originalId}"]`);
    const expectedRight = detached.querySelector<HTMLElement>(`[data-run-id="${originalId + 1}"]`);
    if (!expectedLeft || !expectedRight) return false;

    for (const [actual, expected] of [[actualLeft, expectedLeft], [actualRight, expectedRight]] as const) {
      const before = inlineSignature(actual);
      const after = inlineSignature(expected);
      if (before.text !== after.text || before.tags.join('|') !== after.tags.join('|')) return false;
    }
    return true;
  }

  function render(source: string): void {
    const rollback = beforeCallbacks.map((cb) => cb()).filter((release): release is () => void => typeof release === 'function');
    try {
      const env = {};
      const tokens = md.parse(source, env);
      // The source journal does several source-wide ownership scans. It is useful
      // for small interactive documents, but doing that work for a file open makes
      // large previews appear blank while the main thread is blocked. Large files
      // retain their complete rendered preview and source map; preview edits use
      // the established full-document serialization fallback instead.
      const built = source.length <= PREVIEW_JOURNAL_MAX_SOURCE_LENGTH
        ? buildRunTable(tokens, source)
        : null;
      if (built) injectRunIds(tokens, built.runTable);
      el.innerHTML = md.renderer.render(tokens, md.options, env);
      sourceMap = buildTokenLineRangesFromTokens(tokens);
      tagPreviewBlocks(el, sourceMap);
      tagNestedPreviewBlocksFromTokens(el, tokens);

      if (built) {
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
      } else {
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
    commitSourcePatch: (source, changedRunIds, structural) => {
      if (!runTable || runTable.source !== source) return { ok: false, markdown: source, reason: 'stale-source-journal' };
      const changed = [] as Array<{ runId: number; segments: readonly string[] }>;
      for (const id of changedRunIds) {
        const run = runTable.runs.find((entry) => entry.runId === id);
        const node = el.querySelector<HTMLElement>(`[data-run-id="${id}"]`);
        if (!run || !node) continue; // deleted B2/B3 owners are expected to be absent.
        const serialized = serializeChangedRun(run.subtype, node);
        if (serialized.kind === 'rerender') return { ok: false, markdown: source, reason: serialized.reason };
        changed.push({ runId: id, segments: serialized.kind === 'verbatim' ? [serialized.text] : serialized.segments });
      }
      if (!structural && changed.length !== changedRunIds.length) return { ok: false, markdown: source, reason: 'missing-run-owner' };

      let markdown: string;
      if (structural) {
        const support = structuralJournalSupport(runTable, structural.edit, structural.disposition);
        if (!support.ok) return { ok: false, markdown: source, reason: support.reason };
        const firstOwner = el.querySelector<HTMLElement>(`[data-run-id="${structural.edit.affected.beforeIds[0]}"]`);
        const nextUntyped = firstOwner?.nextElementSibling as HTMLElement | null;
        let replacement: string | undefined;
        if (structural.disposition.kind === 'split') {
          if (!firstOwner || !nextUntyped || nextUntyped.hasAttribute('data-run-id')) {
            return { ok: false, markdown: source, reason: 'structural-split-owner-missing' };
          }
          const firstRun = runTable.runs.find((run) => run.runId === structural.edit.affected.beforeIds[0]);
          if (!firstRun) return { ok: false, markdown: source, reason: 'structural-split-run-missing' };
          const left = serializeChangedRun(firstRun.subtype, firstOwner);
          const right = serializeChangedRun(firstRun.subtype, nextUntyped);
          if (left.kind === 'rerender' || right.kind === 'rerender' || left.kind === 'verbatim' || right.kind === 'verbatim') {
            return { ok: false, markdown: source, reason: 'structural-split-serialize-unsupported' };
          }
          const leftText = left.segments.join('\n');
          const rightText = right.segments.join('\n');
          replacement = `${leftText}\n\n${rightText}`;
        }
        markdown = applyStructuralEdit(runTable, structural.edit, structural.disposition, changed, replacement);
      } else {
        markdown = assembleSource(runTable, changed);
      }
      if (!journalShapeMatches(markdown, structural)) {
        return { ok: false, markdown: source, reason: 'journal-reparse-mismatch' };
      }
      if ((!structural && !changedInlineMatches(markdown, changedRunIds)) ||
        (structural && !structuralInlineMatches(markdown, structural))) {
        return { ok: false, markdown: source, reason: 'inline-shape-mismatch' };
      }
      const savedBookmark = bookmark(el);
      render(markdown);
      restoreBookmark(el, savedBookmark);
      return { ok: true, markdown };
    },
    onBeforeRender: (cb) => { beforeCallbacks.push(cb); },
    onAfterRender: (cb) => { afterCallbacks.push(cb); },
    onRenderSettled: (cb) => { settledCallbacks.push(cb); },
    setLineNumbers: (enabled) => { el.classList.toggle('preview-line-numbers', enabled); },
    getSourceMap: () => sourceMap,
    getRunTable: () => runTable,
  };
}
