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
export const SRC_END_ATTR = 'data-src-end';
export const MAP_ID_ATTR = 'data-map-id';

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
  const tokens = md.parse(markdown, {});
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
