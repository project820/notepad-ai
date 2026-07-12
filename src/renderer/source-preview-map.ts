import { buildRunTable, injectRunIds, type RunTable } from './source-journal';

import type MarkdownIt from 'markdown-it';

/**
 * Source ↔ preview mapping engine (G003).
 *
 * The engine links source-markdown line numbers to rendered preview blocks and
 * back. It is the shared foundation for selection synchronization (A) and line
 * alignment (B), which are wired up in later stories (G004/G005). This module
 * only builds and queries the map — it does not own any feature behavior.
 *
 * Conventions:
 *  - All public line numbers are **1-based inclusive** (`startLine..endLine`).
 *  - markdown-it `token.map` is 0-based half-open `[start, end)`; the conversion
 *    to public form is `startLine = start + 1`, `endLine = end`.
 *  - Block ranges are produced in document order, which for non-nested
 *    top-level blocks means sorted by `startLine` (and, since they never
 *    overlap, also by `endLine`). The query helpers rely on that ordering for
 *    binary search.
 *  - Pure: every function is deterministic in its inputs and has no side
 *    effects other than `tagPreviewBlocks`, which writes attributes onto the
 *    DOM nodes it is explicitly handed.
 */

/** A source ↔ preview block mapping. Line numbers are 1-based inclusive. */
export type SourceLineRange = {
  /**
   * Stable identity linking this range to a preview element's `data-map-id`.
   * Assigned sequentially in document order starting at 0.
   */
  mapId: number;
  /** First source line covered by this block (1-based, inclusive). */
  startLine: number;
  /** Last source line covered by this block (1-based, inclusive). */
  endLine: number;
};

/** DOM attribute names carrying the map. Shared by the writer and readers so
 *  tagging and collection can never disagree on the attribute spelling. */
export const SRC_START_ATTR = 'data-src-start';
const SRC_END_ATTR = 'data-src-end';
const MAP_ID_ATTR = 'data-map-id';
export { buildRunTable, injectRunIds };
export type { RunTable };

/** Validates the rendered run owners before the preview is exposed. */
export function validateDom(root: Element, runTable: RunTable): void {
  const owners = Array.from(root.querySelectorAll<HTMLElement>('[data-run-id]'));
  if (owners.length !== runTable.runs.length) {
    throw new Error(`preview run cardinality mismatch: expected ${runTable.runs.length}, got ${owners.length}`);
  }
  const seen = new Set<number>();
  for (const owner of owners) {
    const id = Number(owner.dataset.runId);
    if (!Number.isInteger(id) || seen.has(id) || !runTable.runs.some((run) => run.runId === id)) {
      throw new Error('preview run ownership mismatch');
    }
    seen.add(id);
  }
}

/** Minimal element shape the readers depend on — keeps the pure helpers
 *  testable without a DOM (a plain stub satisfies it). */
type AttrReader = { getAttribute(name: string): string | null };

/**
 * Parse `markdown` with `md` and collect the line span of every top-level block.
 *
 * Only level-0 block tokens that carry a source map are kept, so the ranges line
 * up 1:1 with the preview's top-level DOM children (markdown-it renders each
 * such block as exactly one top-level element, in document order). Inline tokens
 * and nested children (e.g. list items, paragraphs inside a quote) are skipped.
 * The footnote section is intentionally excluded: its top-level token has no map
 * and it renders out of document order (appended last), so mapping it would
 * break the positional 1:1 alignment relied on by {@link tagPreviewBlocks}.
 *
 * Pure: depends only on `md` + `markdown`, no DOM.
 */
export function buildTokenLineRanges(md: MarkdownIt, markdown: string): SourceLineRange[] {
  return buildTokenLineRangesFromTokens(md.parse(markdown, {}));
}

/** Token-array variant used by preview's single-pass render pipeline. */
export function buildTokenLineRangesFromTokens(tokens: ReturnType<MarkdownIt['parse']>): SourceLineRange[] {
  const ranges: SourceLineRange[] = [];
  let nextId = 0;
  for (const token of tokens) {
    // Top-level (level 0), opening or self-closing, with a source map.
    if (token.level !== 0) continue;
    if (token.nesting < 0) continue; // closing tags carry no map
    if (token.type === 'inline') continue;
    if (!token.map) continue;
    const [start, end] = token.map; // 0-based half-open [start, end)
    ranges.push({ mapId: nextId++, startLine: start + 1, endLine: end });
  }
  return ranges;
}

/**
 * Collect the top-level (direct child) preview elements that carry a map.
 *
 * Children without a valid `data-map-id` + `data-src-*` (e.g. the appended
 * footnote section) are skipped.
 */
export function collectPreviewBlocks(
  previewRoot: Element,
): Array<{ el: Element; mapId: number; startLine: number; endLine: number }> {
  const out: Array<{ el: Element; mapId: number; startLine: number; endLine: number }> = [];
  for (const child of Array.from(previewRoot.children)) {
    if (!child.hasAttribute(MAP_ID_ATTR)) continue;
    const range = previewElementToLineRange(child);
    const mapId = Number(child.getAttribute(MAP_ID_ATTR));
    if (range == null || !Number.isFinite(mapId)) continue;
    out.push({ el: child, mapId, startLine: range.startLine, endLine: range.endLine });
  }
  return out;
}

/**
 * Find the block(s) whose span contains the given 1-based `line`.
 *
 * Top-level ranges never overlap, so this returns at most one block; the array
 * return shape keeps the contract stable for callers and future granularity.
 * Uses binary search over the document-ordered ranges.
 */
export function lineToPreviewBlocks(ranges: readonly SourceLineRange[], line: number): SourceLineRange[] {
  // Last range whose startLine <= line.
  let lo = 0;
  let hi = ranges.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid].startLine <= line) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (idx >= 0 && ranges[idx].endLine >= line) return [ranges[idx]];
  return [];
}

/** Read a tagged preview element's source span, or null if it isn't tagged. */
export function previewElementToLineRange(el: AttrReader): { startLine: number; endLine: number } | null {
  const start = el.getAttribute(SRC_START_ATTR);
  const end = el.getAttribute(SRC_END_ATTR);
  if (start == null || end == null) return null;
  const startLine = Number(start);
  const endLine = Number(end);
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) return null;
  return { startLine, endLine };
}

/**
 * List every block that intersects the inclusive source span `[fromLine, toLine]`
 * (the arguments may be passed in either order).
 *
 * Binary-searches the first range that could intersect, then scans forward while
 * ranges still start within the span. Relies on ranges being non-overlapping and
 * document-ordered (so `endLine` is ascending).
 */
export function rangeToLineSpan(
  ranges: readonly SourceLineRange[],
  fromLine: number,
  toLine: number,
): SourceLineRange[] {
  const lo = Math.min(fromLine, toLine);
  const hi = Math.max(fromLine, toLine);
  // First range whose endLine >= lo (endLine is ascending for top-level ranges).
  let bLo = 0;
  let bHi = ranges.length - 1;
  let first = ranges.length;
  while (bLo <= bHi) {
    const mid = (bLo + bHi) >> 1;
    if (ranges[mid].endLine >= lo) {
      first = mid;
      bHi = mid - 1;
    } else {
      bLo = mid + 1;
    }
  }
  const hits: SourceLineRange[] = [];
  for (let i = first; i < ranges.length; i++) {
    if (ranges[i].startLine > hi) break;
    hits.push(ranges[i]);
  }
  return hits;
}

/**
 * Write `data-src-start` / `data-src-end` / `data-map-id` onto the preview's
 * top-level elements, zipping `ranges` with the leading top-level children.
 *
 * markdown-it renders each top-level block as exactly one top-level element in
 * document order, and the footnote section (when present) is appended last with
 * no range — so the leading `ranges.length` children are precisely the content
 * blocks, in order. The `min` guard keeps the loop in bounds defensively.
 *
 * These attributes are display-only metadata: Turndown / htmlToMarkdown ignore
 * `data-*`, so they never leak into the saved markdown (verified by tests).
 */
export function tagPreviewBlocks(root: Element, ranges: readonly SourceLineRange[]): void {
  const children = root.children;
  const n = Math.min(ranges.length, children.length);
  for (let i = 0; i < n; i++) {
    const r = ranges[i];
    const el = children[i];
    el.setAttribute(SRC_START_ATTR, String(r.startLine));
    el.setAttribute(SRC_END_ATTR, String(r.endLine));
    el.setAttribute(MAP_ID_ATTR, String(r.mapId));
  }
}

/** Block tags rendered as pure structural wrappers: they enclose the finer units
 *  that carry the real selectable granularity (list items, table rows), so the
 *  nested tagger recurses through them but never tags them as a unit. */
const STRUCTURAL_TAGS = new Set(['ul', 'ol', 'table', 'thead', 'tbody']);

/** A markdown-it token (derived from the parser's return type to avoid a deep
 *  import path). */
type MdToken = ReturnType<MarkdownIt['parse']>[number];

/** A block-level token kept for the DOM walk: its HTML `tag`, 1-based inclusive
 *  source span (when it carries a map) and block-level children. Inline tokens
 *  and tight-list (hidden) paragraphs are dropped — they produce no standalone
 *  element — so the tree mirrors the rendered block DOM. */
type BlockToken = {
  tag: string;
  startLine: number;
  endLine: number;
  hasMap: boolean;
  children: BlockToken[];
};

/**
 * Build the tree of block-level tokens. The top-level entries (with a map) are
 * exactly the set {@link buildTokenLineRanges} keeps, in the same document order,
 * so they line up 1:1 with the tagged top-level preview children.
 */
function buildBlockTokenTree(tokens: readonly MdToken[]): BlockToken[] {
  const root: BlockToken = { tag: '', startLine: 0, endLine: 0, hasMap: false, children: [] };
  const stack: BlockToken[] = [root];
  const make = (t: MdToken): BlockToken => ({
    tag: t.tag ?? '',
    startLine: t.map ? t.map[0] + 1 : 0,
    endLine: t.map ? t.map[1] : 0,
    hasMap: t.map != null,
    children: [],
  });
  for (const token of tokens) {
    if (token.type === 'inline') continue;
    if (token.hidden) continue; // tight-list paragraphs render no element
    if (token.nesting === 1) {
      const node = make(token);
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    } else if (token.nesting === -1) {
      if (stack.length > 1) stack.pop();
    } else {
      stack[stack.length - 1].children.push(make(token));
    }
  }
  return root.children;
}

/** Recursively tag the mapped block children of `domEl` (matched to `node`'s
 *  children by tag, in order). `ancestor` is the span of the nearest already-
 *  tagged element, used to skip redundant equal-span tags. */
function tagBlockChildren(domEl: Element, node: BlockToken, ancestor: { startLine: number; endLine: number }): void {
  if (node.children.length === 0) return;
  const domKids = Array.from(domEl.children);
  // Only split paragraphs when a container holds more than one: a lone <p> (a
  // single-paragraph blockquote / list item) stays one highlightable unit, while
  // a multi-paragraph block splits per paragraph.
  const paragraphCount = node.children.reduce((acc, c) => (c.tag === 'p' && c.hasMap ? acc + 1 : acc), 0);
  let di = 0;
  for (const child of node.children) {
    if (!child.tag) continue;
    let dom: Element | null = null;
    while (di < domKids.length) {
      const cand = domKids[di++];
      if (cand.tagName.toLowerCase() === child.tag) {
        dom = cand;
        break;
      }
    }
    if (!dom) continue;
    let next = ancestor;
    const structural = STRUCTURAL_TAGS.has(child.tag);
    const loneParagraph = child.tag === 'p' && paragraphCount < 2;
    const redundant = child.startLine === ancestor.startLine && child.endLine === ancestor.endLine;
    if (child.hasMap && !structural && !loneParagraph && !redundant) {
      dom.setAttribute(SRC_START_ATTR, String(child.startLine));
      dom.setAttribute(SRC_END_ATTR, String(child.endLine));
      next = { startLine: child.startLine, endLine: child.endLine };
    }
    tagBlockChildren(dom, child, next);
  }
}

/** Token-array variant used by preview's single-pass render pipeline. */
export function tagNestedPreviewBlocksFromTokens(root: Element, tokens: readonly MdToken[]): void {
  const top = buildBlockTokenTree(tokens).filter((n) => n.hasMap);
  const domKids = Array.from(root.children);
  for (let i = 0; i < top.length && i < domKids.length; i++) {
    const node = top[i];
    tagBlockChildren(domKids[i], node, { startLine: node.startLine, endLine: node.endLine });
  }
}
