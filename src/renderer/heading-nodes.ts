/**
 * heading-nodes.ts
 *
 * Utility for extracting heading nodes from a Markdown AST (mdast-compatible).
 * Used by the v1.1 Outline→Draft workflow to build the section list from
 * the current document's heading structure.
 *
 * ROLLBACK SAFETY: This module is purely functional with no side-effects.
 * It has zero coupling to the editor, AI surfaces, or any v1.1 feature toggle.
 * Removing its callers fully reverts all Outline→Draft heading-extraction
 * behaviour without data migration.
 *
 * Design decisions:
 * - Types are defined inline (no external `mdast` or `unified` dependency).
 *   They are intentionally minimal but structurally compatible with mdast so a
 *   remark-parsed AST can be passed directly if those deps are added later.
 * - Traversal is recursive — headings inside blockquotes are included. The
 *   caller (Outline→Draft) is responsible for filtering by depth if needed.
 * - No I/O, no imports — safe to call in both main and renderer processes.
 */

// ---------------------------------------------------------------------------
// Types — minimal mdast-compatible AST subset
// ---------------------------------------------------------------------------

/**
 * An arbitrary mdast-compatible AST node.
 *
 * The `type` field follows the mdast spec (e.g. 'heading', 'paragraph',
 * 'code', 'blockquote', 'text', …).  Additional fields (e.g. `value`,
 * `lang`, `url`, `depth`) are represented by the index signature.
 */
export interface MdastNode {
  type: string;
  children?: MdastNode[];
  [key: string]: unknown;
}

/**
 * A heading node — `type === 'heading'`.
 *
 * `depth` ranges 1–6 corresponding to ATX heading levels `#` through `######`.
 * `children` contains the inline content of the heading (usually one or more
 * `text` nodes, possibly with inline `emphasis`, `strong`, `inlineCode`, etc.)
 */
export interface HeadingNode extends MdastNode {
  type: 'heading';
  depth: 1 | 2 | 3 | 4 | 5 | 6;
  children: MdastNode[];
}

/**
 * The root node of a Markdown AST.
 *
 * `children` contains all top-level block nodes of the document.
 */
export interface MdastRoot {
  type: 'root';
  children: MdastNode[];
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

/**
 * Narrows an `MdastNode` to `HeadingNode`.
 *
 * A node is considered a heading when:
 *   - `type === 'heading'`
 *   - `depth` is an integer in the range [1, 6]
 */
export function isHeadingNode(node: MdastNode): node is HeadingNode {
  return (
    node.type === 'heading' &&
    typeof node.depth === 'number' &&
    Number.isInteger(node.depth) &&
    node.depth >= 1 &&
    node.depth <= 6
  );
}

// ---------------------------------------------------------------------------
// Core extractor
// ---------------------------------------------------------------------------

/**
 * Traverses a Markdown AST and returns all heading nodes (h1–h6) in
 * document order (depth-first, left-to-right).
 *
 * The traversal is recursive: headings nested inside container nodes
 * such as `blockquote`, `listItem`, or custom block types are included.
 *
 * @param ast - The root node of a Markdown AST (mdast-compatible).
 * @returns Ordered array of heading nodes. Empty array when no headings exist.
 *
 * @example
 * const ast: MdastRoot = {
 *   type: 'root',
 *   children: [
 *     { type: 'heading', depth: 1, children: [{ type: 'text', value: 'Title' }] },
 *     { type: 'paragraph', children: [{ type: 'text', value: 'Body text.' }] },
 *     { type: 'heading', depth: 2, children: [{ type: 'text', value: 'Section A' }] },
 *   ],
 * };
 * extractHeadingNodes(ast);
 * // => [
 * //   { type: 'heading', depth: 1, children: [{type:'text',value:'Title'}] },
 * //   { type: 'heading', depth: 2, children: [{type:'text',value:'Section A'}] },
 * // ]
 *
 * @example
 * // Empty document
 * extractHeadingNodes({ type: 'root', children: [] });
 * // => []
 *
 * @example
 * // No headings — only paragraphs and code blocks
 * extractHeadingNodes({
 *   type: 'root',
 *   children: [
 *     { type: 'paragraph', children: [{ type: 'text', value: 'Hello.' }] },
 *     { type: 'code', lang: 'ts', value: 'const x = 1;' },
 *   ],
 * });
 * // => []
 */
export function extractHeadingNodes(ast: MdastRoot): HeadingNode[] {
  const headings: HeadingNode[] = [];

  /**
   * Depth-first visitor over an arbitrary list of mdast nodes.
   * Accumulates heading nodes into the outer `headings` array.
   */
  function visit(nodes: MdastNode[]): void {
    for (const node of nodes) {
      if (isHeadingNode(node)) {
        headings.push(node);
      }
      // Recurse into container nodes that may themselves contain headings
      // (e.g. blockquote, listItem, footnoteDefinition).
      if (Array.isArray(node.children) && node.children.length > 0) {
        visit(node.children);
      }
    }
  }

  visit(ast.children);
  return headings;
}

// ---------------------------------------------------------------------------
// Convenience helpers
// ---------------------------------------------------------------------------

/**
 * Returns only the headings at a specific depth level.
 *
 * Useful when Outline→Draft needs to process a particular heading tier
 * (e.g. only h2 sections).
 *
 * @param headings - Result of `extractHeadingNodes`
 * @param depth    - Target depth level (1–6)
 */
export function filterHeadingsByDepth(
  headings: HeadingNode[],
  depth: 1 | 2 | 3 | 4 | 5 | 6,
): HeadingNode[] {
  return headings.filter((h) => h.depth === depth);
}

/**
 * Returns the minimum (shallowest) heading depth present in `headings`.
 * Returns `null` when the array is empty.
 *
 * Useful for determining the "root level" of an outline when the document
 * starts at h2 rather than h1.
 */
export function topHeadingDepth(
  headings: HeadingNode[],
): 1 | 2 | 3 | 4 | 5 | 6 | null {
  if (headings.length === 0) return null;
  return Math.min(...headings.map((h) => h.depth)) as 1 | 2 | 3 | 4 | 5 | 6;
}
