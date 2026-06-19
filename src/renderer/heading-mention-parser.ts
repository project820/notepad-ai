/**
 * heading-mention-parser.ts
 *
 * Integration module for Sub-AC 5d-ii: `parseHeadingAtMentions`
 *
 * Pipes raw Markdown through a minimal line-based AST parser, extracts all
 * heading nodes (h1–h6), collects @mention tokens from each heading's plain
 * text, filters to .md-only references, and returns a deduplicated array in
 * first-seen insertion order.
 *
 * ROLLBACK SAFETY: This module is purely functional with no side-effects.
 * It imports only from sibling v1.1 modules (heading-nodes, mention-parser).
 * Removing this file — or disabling its callers via feature toggles — fully
 * reverts parseHeadingAtMentions behaviour without touching any other module
 * and without data migration.
 *
 * Design decisions:
 * - The Markdown→AST parser is intentionally minimal: it recognises ATX
 *   headings (`#` … `######`) and fenced code blocks (``` / ~~~) only.
 *   Setext headings underlined with `===` or `---` are treated as paragraphs.
 *   This is sufficient for the v1.1 Outline→Draft and context-injection
 *   workflows, which mandate ATX headings.
 * - @mentions appearing only in body content (paragraphs, lists, blockquotes,
 *   code blocks) are silently excluded — only heading-line mentions influence
 *   AI context injection.
 * - Deduplication is insertion-order-stable: the first occurrence of a token
 *   across all headings wins; later duplicates are dropped.
 * - No I/O, no Electron/DOM imports — safe to call in both the main and
 *   renderer processes.
 */

import {
  extractHeadingNodes,
  type MdastRoot,
  type MdastNode,
  type HeadingNode,
} from './heading-nodes';
import {
  extractAtMentionsFromText,
  filterMdFileReferences,
} from './mention-parser';

// ---------------------------------------------------------------------------
// Internal: minimal Markdown → MdastRoot parser
// ---------------------------------------------------------------------------

/**
 * ATX heading pattern (applied to a line after leading whitespace is stripped).
 *
 * A valid ATX heading line has:
 *   - 1–6 `#` characters at the start (`match[1]` → depth)
 *   - Followed by one or more spaces/tabs, then optional text (`match[2]`)
 *   - OR just the `#` sequence with nothing after it (empty heading)
 *
 * A line like `#nospace` (no space between `#` and text) is NOT a heading
 * per CommonMark — the regex correctly rejects it because `[ \t]+` is
 * required when text is present, and `(?:...)?` makes the entire text group
 * optional only for bare `##` (no trailing content at all).
 */
const ATX_HEADING_RE = /^(#{1,6})(?:[ \t]+(.*))?$/;

/**
 * Converts raw Markdown text to a minimal MdastRoot-compatible AST.
 *
 * The parser is line-based and ATX-only. It produces three node types:
 *   - `HeadingNode` — for lines matching the ATX heading pattern
 *   - `{ type: 'code', … }` — for lines inside fenced code blocks
 *   - `{ type: 'paragraph', … }` — for all other non-empty lines
 *
 * Empty / blank lines produce no AST node (they are structural separators).
 *
 * Fenced code-block tracking prevents `# headings inside code fences` from
 * being treated as real headings.
 *
 * @param markdown - Raw Markdown string
 * @returns MdastRoot whose children can be passed to `extractHeadingNodes`
 */
function markdownToMdast(markdown: string): MdastRoot {
  const lines = markdown.split('\n');
  const children: MdastNode[] = [];

  /**
   * When non-null, we are inside a fenced code block.
   * The value is the OPENING delimiter string (e.g. "```", "~~~~").
   * We use its length and first character to identify the matching close.
   */
  let fenceOpen: string | null = null;

  for (const rawLine of lines) {
    const trimmed = rawLine.trimStart();

    // ── Inside a fenced code block ──────────────────────────────────────────
    if (fenceOpen !== null) {
      // Closing fence: same character, at least as many chars, optional trailing
      // whitespace only — and nothing else on the line.
      const fenceCh = fenceOpen[0]; // '`' or '~'
      const fenceLen = fenceOpen.length;

      let closingCount = 0;
      for (let i = 0; i < trimmed.length; i++) {
        if (trimmed[i] === fenceCh) {
          closingCount++;
        } else {
          break;
        }
      }

      const afterFence = trimmed.slice(closingCount);
      const isClosingFence = closingCount >= fenceLen && afterFence.trim() === '';
      if (isClosingFence) {
        fenceOpen = null;
      }

      children.push({ type: 'code', value: rawLine });
      continue;
    }

    // ── Check for fence opening ─────────────────────────────────────────────
    // A fence opener is 3+ backticks or 3+ tildes at the start of the line.
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      fenceOpen = fenceMatch[1];
      children.push({ type: 'code', value: rawLine });
      continue;
    }

    // ── ATX heading ─────────────────────────────────────────────────────────
    const headingMatch = trimmed.match(ATX_HEADING_RE);
    if (headingMatch) {
      const depth = headingMatch[1].length as 1 | 2 | 3 | 4 | 5 | 6;
      // Raw heading text (may have trailing optional closing ATX markers)
      let headingText = (headingMatch[2] ?? '').trim();
      // Strip optional closing ATX sequence: `## Heading ##` → `Heading`
      headingText = headingText.replace(/\s+#+\s*$/, '').trim();
      children.push({
        type: 'heading',
        depth,
        children: [{ type: 'text', value: headingText }],
      });
    } else if (rawLine.trim().length > 0) {
      // Non-empty, non-heading, non-fence line → paragraph
      children.push({
        type: 'paragraph',
        children: [{ type: 'text', value: rawLine }],
      });
    }
    // Blank lines produce no node.
  }

  return { type: 'root', children };
}

// ---------------------------------------------------------------------------
// Internal: extract plain text from a HeadingNode's children
// ---------------------------------------------------------------------------

/**
 * Collects the plain text content of a HeadingNode by recursively
 * concatenating `value` fields from all descendant text-like nodes.
 *
 * This handles headings that contain inline formatting (bold, italic, code
 * spans, links) by recursing into their children and collecting leaf text.
 * For the minimal AST produced by `markdownToMdast`, the heading always has
 * a single text-node child, so the function degenerates to a simple lookup.
 * It remains generic so it works correctly if a full remark AST is passed.
 *
 * @param node - The HeadingNode to extract text from
 * @returns Concatenated plain text of the heading (no markdown syntax)
 */
function headingNodeToText(node: HeadingNode): string {
  function collectText(nodes: MdastNode[]): string {
    return nodes
      .map((n) => {
        if (typeof n.value === 'string') return n.value as string;
        if (Array.isArray(n.children) && n.children.length > 0) {
          return collectText(n.children as MdastNode[]);
        }
        return '';
      })
      .join('');
  }
  return collectText(node.children);
}

// ---------------------------------------------------------------------------
// Public API — Sub-AC 5d-ii
// ---------------------------------------------------------------------------

/**
 * Extracts deduplicated `.md`-only @mention file references from heading lines
 * in a raw Markdown document.
 *
 * Pipeline:
 * ```
 * raw markdown
 *   → markdownToMdast          (line-based ATX heading parser)
 *   → extractHeadingNodes      (depth-first heading traversal)
 *   → headingNodeToText        (per heading — collect plain text)
 *   → extractAtMentionsFromText (per heading — all @token candidates)
 *   → filterMdFileReferences   (per heading — keep .md only)
 *   → deduplicate              (insertion-order-stable Set)
 *   → string[]
 * ```
 *
 * Rules enforced by this function:
 * 1. Only heading-line mentions are considered (h1–h6 ATX headings).
 *    @mentions appearing in body paragraphs, list items, blockquotes,
 *    or inside fenced code blocks are silently excluded.
 * 2. Only `.md` file references are returned (case-insensitive suffix check).
 *    @mentions like `@diagram.png`, `@script.ts`, or bare `@username` are
 *    excluded.
 * 3. If the same `.md` token appears in multiple headings, it is returned
 *    only once.  The first heading that contains it wins (stable order).
 * 4. An empty document, or one containing no heading-level `.md` mentions,
 *    returns an empty array.
 *
 * @param markdown - Raw Markdown string (full document content).
 * @returns Ordered, deduplicated array of `@mention` tokens referencing `.md`
 *          files found exclusively in heading lines.  For example:
 *          `['@context.md', '@results.md']`.
 *
 * @example
 * parseHeadingAtMentions(`
 * # Intro
 * Body text with @notes.md — this is excluded (body paragraph).
 *
 * ## Background @context.md @diagram.png
 * Another paragraph @body-mention.md — excluded.
 *
 * ## Analysis @results.md @context.md
 * `);
 * // => ['@context.md', '@results.md']
 * //
 * // @notes.md  — excluded (body paragraph only)
 * // @diagram.png — excluded (not .md)
 * // @body-mention.md — excluded (body paragraph)
 * // @context.md — deduplicated (appears in two headings; first wins)
 */
export function parseHeadingAtMentions(markdown: string): string[] {
  // Step 1: convert raw markdown to a minimal AST
  const ast = markdownToMdast(markdown);

  // Step 2: extract all heading nodes (depth-first, document order)
  const headings = extractHeadingNodes(ast);

  // Step 3–5: collect, filter, deduplicate
  const seen = new Set<string>();
  const result: string[] = [];

  for (const h of headings) {
    // Step 3: get plain text of the heading line
    const text = headingNodeToText(h);

    // Step 4: extract all @mention tokens, then keep .md-only
    const mdMentions = filterMdFileReferences(extractAtMentionsFromText(text));

    // Step 5: deduplicate across all headings (first occurrence wins)
    for (const mention of mdMentions) {
      if (!seen.has(mention)) {
        seen.add(mention);
        result.push(mention);
      }
    }
  }

  return result;
}
