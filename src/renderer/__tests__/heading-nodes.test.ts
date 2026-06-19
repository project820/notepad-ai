/**
 * heading-nodes.test.ts
 *
 * Unit tests for `extractHeadingNodes`, `isHeadingNode`, `filterHeadingsByDepth`,
 * and `topHeadingDepth` from heading-nodes.ts.
 *
 * All tests use hand-crafted fixture ASTs (no markdown parsing dependency).
 * Fixtures contain mixed node types — paragraphs, code blocks, blockquotes,
 * inline nodes — to confirm that only heading nodes are returned.
 *
 * Test matrix:
 *   1. Empty AST — returns []
 *   2. No headings (paragraphs + code blocks) — returns []
 *   3. Single heading at each depth (h1–h6)
 *   4. Multiple headings — order preservation
 *   5. Mixed nodes — headings interspersed with paragraphs and code blocks
 *   6. Recursive traversal — headings inside blockquotes
 *   7. Recursive traversal — headings inside nested blockquotes
 *   8. Recursive traversal — headings inside list items
 *   9. isHeadingNode — type guard correctness
 *  10. isHeadingNode — rejects invalid depth values
 *  11. filterHeadingsByDepth — depth filtering
 *  12. topHeadingDepth — shallowest depth detection
 *  13. HeadingNode children are preserved unchanged
 *  14. Non-heading nodes with children are NOT returned
 *  15. Large document fixture — correctness and order
 */

import { describe, it, expect } from 'vitest';
import {
  extractHeadingNodes,
  isHeadingNode,
  filterHeadingsByDepth,
  topHeadingDepth,
  type MdastNode,
  type MdastRoot,
  type HeadingNode,
} from '../heading-nodes';

// ============================================================================
// Fixture builders — small helpers to construct typed AST nodes
// ============================================================================

/** Create a text inline node */
const text = (value: string): MdastNode => ({ type: 'text', value });

/** Create a paragraph block node */
const paragraph = (...words: string[]): MdastNode => ({
  type: 'paragraph',
  children: words.map(text),
});

/** Create a code block node (leaf — no children in mdast) */
const codeBlock = (value: string, lang?: string): MdastNode => ({
  type: 'code',
  lang: lang ?? null,
  value,
});

/** Create a thematic break node (leaf — no children) */
const thematicBreak = (): MdastNode => ({ type: 'thematicBreak' });

/** Create a blockquote node containing the provided children */
const blockquote = (...children: MdastNode[]): MdastNode => ({
  type: 'blockquote',
  children,
});

/** Create a list node */
const list = (ordered: boolean, ...items: MdastNode[]): MdastNode => ({
  type: 'list',
  ordered,
  children: items,
});

/** Create a list item node */
const listItem = (...children: MdastNode[]): MdastNode => ({
  type: 'listItem',
  children,
});

/** Create a heading node */
const heading = (depth: 1 | 2 | 3 | 4 | 5 | 6, ...content: string[]): HeadingNode => ({
  type: 'heading',
  depth,
  children: content.map(text),
});

/** Create a root node */
const root = (...children: MdastNode[]): MdastRoot => ({
  type: 'root',
  children,
});

// ============================================================================
// 1. Empty AST
// ============================================================================

describe('extractHeadingNodes — empty AST', () => {
  it('returns [] for root with empty children array', () => {
    expect(extractHeadingNodes(root())).toEqual([]);
  });

  it('returns [] for root with explicit empty array', () => {
    const ast: MdastRoot = { type: 'root', children: [] };
    expect(extractHeadingNodes(ast)).toEqual([]);
  });
});

// ============================================================================
// 2. No headings — paragraphs and code blocks only
// ============================================================================

describe('extractHeadingNodes — no headings', () => {
  it('returns [] when document contains only a paragraph', () => {
    const ast = root(paragraph('Just a paragraph.'));
    expect(extractHeadingNodes(ast)).toEqual([]);
  });

  it('returns [] when document contains only a code block', () => {
    const ast = root(codeBlock('const x = 1;', 'typescript'));
    expect(extractHeadingNodes(ast)).toEqual([]);
  });

  it('returns [] when document contains only a thematic break', () => {
    const ast = root(thematicBreak());
    expect(extractHeadingNodes(ast)).toEqual([]);
  });

  it('returns [] for multiple paragraphs with no headings', () => {
    const ast = root(
      paragraph('Introduction paragraph.'),
      paragraph('Second paragraph with more text.'),
      paragraph('Concluding remarks.'),
    );
    expect(extractHeadingNodes(ast)).toEqual([]);
  });

  it('returns [] for mixed paragraph and code block with no headings', () => {
    const ast = root(
      paragraph('Explain the code below.'),
      codeBlock('function hello() { return "hi"; }', 'javascript'),
      paragraph('End of example.'),
    );
    expect(extractHeadingNodes(ast)).toEqual([]);
  });
});

// ============================================================================
// 3. Single heading at each depth level
// ============================================================================

describe('extractHeadingNodes — single heading at each depth', () => {
  it('returns [h1] for a document with only an h1 heading', () => {
    const h = heading(1, 'Document Title');
    const result = extractHeadingNodes(root(h));
    expect(result).toHaveLength(1);
    expect(result[0].depth).toBe(1);
    expect(result[0].type).toBe('heading');
  });

  it('returns [h2] for a document with only an h2 heading', () => {
    const h = heading(2, 'Section');
    const result = extractHeadingNodes(root(h));
    expect(result).toHaveLength(1);
    expect(result[0].depth).toBe(2);
  });

  it('returns [h3] for a document with only an h3 heading', () => {
    const h = heading(3, 'Subsection');
    const result = extractHeadingNodes(root(h));
    expect(result).toHaveLength(1);
    expect(result[0].depth).toBe(3);
  });

  it('returns [h4] for a document with only an h4 heading', () => {
    const h = heading(4, 'Sub-subsection');
    const result = extractHeadingNodes(root(h));
    expect(result).toHaveLength(1);
    expect(result[0].depth).toBe(4);
  });

  it('returns [h5] for a document with only an h5 heading', () => {
    const h = heading(5, 'Detail heading');
    const result = extractHeadingNodes(root(h));
    expect(result).toHaveLength(1);
    expect(result[0].depth).toBe(5);
  });

  it('returns [h6] for a document with only an h6 heading', () => {
    const h = heading(6, 'Deepest heading');
    const result = extractHeadingNodes(root(h));
    expect(result).toHaveLength(1);
    expect(result[0].depth).toBe(6);
  });
});

// ============================================================================
// 4. Multiple headings — order preservation
// ============================================================================

describe('extractHeadingNodes — multiple headings and order', () => {
  it('returns headings in document order (h1, h2, h3)', () => {
    const h1 = heading(1, 'Title');
    const h2 = heading(2, 'Section A');
    const h3 = heading(3, 'Sub-section A.1');
    const result = extractHeadingNodes(root(h1, h2, h3));
    expect(result).toHaveLength(3);
    expect(result[0].depth).toBe(1);
    expect(result[1].depth).toBe(2);
    expect(result[2].depth).toBe(3);
  });

  it('returns headings in document order when they appear in non-hierarchical order', () => {
    // h3 before h1 — unusual but valid; order must be preserved
    const h3 = heading(3, 'First in doc');
    const h1 = heading(1, 'Second in doc');
    const h2 = heading(2, 'Third in doc');
    const result = extractHeadingNodes(root(h3, h1, h2));
    expect(result[0].depth).toBe(3);
    expect(result[1].depth).toBe(1);
    expect(result[2].depth).toBe(2);
  });

  it('preserves all 6 heading depths when all are present', () => {
    const headings = [1, 2, 3, 4, 5, 6].map((d) =>
      heading(d as 1 | 2 | 3 | 4 | 5 | 6, `Heading ${d}`),
    );
    const result = extractHeadingNodes(root(...headings));
    expect(result).toHaveLength(6);
    for (let i = 0; i < 6; i++) {
      expect(result[i].depth).toBe(i + 1);
    }
  });

  it('handles repeated headings at the same depth', () => {
    const ast = root(
      heading(2, 'Section A'),
      heading(2, 'Section B'),
      heading(2, 'Section C'),
    );
    const result = extractHeadingNodes(ast);
    expect(result).toHaveLength(3);
    expect(result.every((h) => h.depth === 2)).toBe(true);
  });
});

// ============================================================================
// 5. Mixed nodes — headings interspersed with paragraphs and code blocks
// ============================================================================

describe('extractHeadingNodes — mixed node types', () => {
  it('extracts only headings when interspersed with paragraphs', () => {
    const ast = root(
      heading(1, 'Title'),
      paragraph('Opening paragraph.'),
      heading(2, 'Background'),
      paragraph('Background context.'),
      paragraph('More context.'),
      heading(2, 'Methods'),
      paragraph('Methodology paragraph.'),
    );
    const result = extractHeadingNodes(ast);
    expect(result).toHaveLength(3);
    expect(result[0].depth).toBe(1);
    expect(result[1].depth).toBe(2);
    expect(result[2].depth).toBe(2);
  });

  it('excludes code blocks from results', () => {
    const ast = root(
      heading(1, 'Example'),
      codeBlock('console.log("hello")', 'javascript'),
      paragraph('Explanation.'),
      heading(2, 'More Details'),
      codeBlock('const y = 2;', 'typescript'),
    );
    const result = extractHeadingNodes(ast);
    expect(result).toHaveLength(2);
    expect(result.every((n) => n.type === 'heading')).toBe(true);
  });

  it('excludes thematic breaks from results', () => {
    const ast = root(
      heading(1, 'Part One'),
      paragraph('Content.'),
      thematicBreak(),
      heading(1, 'Part Two'),
    );
    const result = extractHeadingNodes(ast);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('heading');
    expect(result[1].type).toBe('heading');
  });

  it('handles heading at start, paragraph in middle, heading at end', () => {
    const ast = root(
      heading(2, 'First'),
      paragraph('Middle paragraph.'),
      heading(2, 'Last'),
    );
    const result = extractHeadingNodes(ast);
    expect(result).toHaveLength(2);
  });

  it('handles all paragraphs surrounding a single heading', () => {
    const ast = root(
      paragraph('Before.'),
      paragraph('Still before.'),
      heading(3, 'The Only Heading'),
      paragraph('After.'),
      paragraph('Still after.'),
    );
    const result = extractHeadingNodes(ast);
    expect(result).toHaveLength(1);
    expect(result[0].depth).toBe(3);
  });
});

// ============================================================================
// 6. Recursive traversal — headings inside blockquotes
// ============================================================================

describe('extractHeadingNodes — recursive traversal (blockquote)', () => {
  it('includes headings nested directly inside a blockquote', () => {
    const ast = root(
      blockquote(
        heading(2, 'Quoted Heading'),
        paragraph('Quoted body.'),
      ),
    );
    const result = extractHeadingNodes(ast);
    expect(result).toHaveLength(1);
    expect(result[0].depth).toBe(2);
  });

  it('returns headings from both root and blockquote levels', () => {
    const ast = root(
      heading(1, 'Root Heading'),
      blockquote(
        heading(2, 'Blockquote Heading'),
      ),
      heading(1, 'Another Root Heading'),
    );
    const result = extractHeadingNodes(ast);
    expect(result).toHaveLength(3);
    expect(result[0].depth).toBe(1);
    expect(result[1].depth).toBe(2);
    expect(result[2].depth).toBe(1);
  });

  it('returns empty array when blockquote contains only paragraphs', () => {
    const ast = root(
      blockquote(
        paragraph('Quoted text.'),
        paragraph('More quoted text.'),
      ),
    );
    expect(extractHeadingNodes(ast)).toEqual([]);
  });
});

// ============================================================================
// 7. Recursive traversal — headings inside nested blockquotes
// ============================================================================

describe('extractHeadingNodes — deeply nested blockquotes', () => {
  it('finds heading inside a doubly-nested blockquote', () => {
    const ast = root(
      blockquote(
        blockquote(
          heading(3, 'Deep Heading'),
        ),
      ),
    );
    const result = extractHeadingNodes(ast);
    expect(result).toHaveLength(1);
    expect(result[0].depth).toBe(3);
  });

  it('handles triple nesting without error', () => {
    const ast = root(
      blockquote(
        paragraph('Level 1.'),
        blockquote(
          paragraph('Level 2.'),
          blockquote(
            heading(4, 'Level 3 Heading'),
          ),
        ),
      ),
    );
    const result = extractHeadingNodes(ast);
    expect(result).toHaveLength(1);
    expect(result[0].depth).toBe(4);
  });
});

// ============================================================================
// 8. Recursive traversal — headings inside list items
// ============================================================================

describe('extractHeadingNodes — headings inside list items', () => {
  it('finds heading nested inside an unordered list item', () => {
    const ast = root(
      list(false,
        listItem(heading(3, 'Item Heading'), paragraph('Item body.')),
      ),
    );
    const result = extractHeadingNodes(ast);
    expect(result).toHaveLength(1);
    expect(result[0].depth).toBe(3);
  });

  it('finds headings in multiple list items', () => {
    const ast = root(
      list(true,
        listItem(heading(3, 'First Item Heading')),
        listItem(paragraph('No heading here.')),
        listItem(heading(3, 'Third Item Heading')),
      ),
    );
    const result = extractHeadingNodes(ast);
    expect(result).toHaveLength(2);
  });
});

// ============================================================================
// 9. isHeadingNode — type guard correctness
// ============================================================================

describe('isHeadingNode', () => {
  it('returns true for a valid h1 heading node', () => {
    expect(isHeadingNode(heading(1, 'Title'))).toBe(true);
  });

  it('returns true for a valid h6 heading node', () => {
    expect(isHeadingNode(heading(6, 'Deep'))).toBe(true);
  });

  it('returns false for a paragraph node', () => {
    expect(isHeadingNode(paragraph('text'))).toBe(false);
  });

  it('returns false for a code block node', () => {
    expect(isHeadingNode(codeBlock('const x = 1;'))).toBe(false);
  });

  it('returns false for a text inline node', () => {
    expect(isHeadingNode(text('hello'))).toBe(false);
  });

  it('returns false for a blockquote node', () => {
    expect(isHeadingNode(blockquote(paragraph('quoted')))).toBe(false);
  });

  it('returns false for a thematic break node', () => {
    expect(isHeadingNode(thematicBreak())).toBe(false);
  });

  it('returns false for a root node', () => {
    const r: MdastNode = { type: 'root', children: [] };
    expect(isHeadingNode(r)).toBe(false);
  });
});

// ============================================================================
// 10. isHeadingNode — rejects invalid depth values
// ============================================================================

describe('isHeadingNode — invalid depth values', () => {
  it('returns false when type is "heading" but depth is 0', () => {
    const node: MdastNode = { type: 'heading', depth: 0, children: [] };
    expect(isHeadingNode(node)).toBe(false);
  });

  it('returns false when type is "heading" but depth is 7', () => {
    const node: MdastNode = { type: 'heading', depth: 7, children: [] };
    expect(isHeadingNode(node)).toBe(false);
  });

  it('returns false when type is "heading" but depth is negative', () => {
    const node: MdastNode = { type: 'heading', depth: -1, children: [] };
    expect(isHeadingNode(node)).toBe(false);
  });

  it('returns false when type is "heading" but depth is a float', () => {
    const node: MdastNode = { type: 'heading', depth: 2.5, children: [] };
    expect(isHeadingNode(node)).toBe(false);
  });

  it('returns false when type is "heading" but depth is a string', () => {
    const node: MdastNode = { type: 'heading', depth: '2' as unknown as number, children: [] };
    expect(isHeadingNode(node)).toBe(false);
  });

  it('returns false when type is "heading" but depth is missing', () => {
    const node: MdastNode = { type: 'heading', children: [] };
    expect(isHeadingNode(node)).toBe(false);
  });
});

// ============================================================================
// 11. filterHeadingsByDepth
// ============================================================================

describe('filterHeadingsByDepth', () => {
  const mixedHeadings: HeadingNode[] = [
    heading(1, 'H1 title'),
    heading(2, 'H2 section A'),
    heading(3, 'H3 sub A.1'),
    heading(2, 'H2 section B'),
    heading(3, 'H3 sub B.1'),
    heading(4, 'H4 deep'),
  ];

  it('returns only h2 nodes when filtering by depth 2', () => {
    const result = filterHeadingsByDepth(mixedHeadings, 2);
    expect(result).toHaveLength(2);
    expect(result.every((h) => h.depth === 2)).toBe(true);
  });

  it('returns only h1 nodes when filtering by depth 1', () => {
    const result = filterHeadingsByDepth(mixedHeadings, 1);
    expect(result).toHaveLength(1);
    expect(result[0].depth).toBe(1);
  });

  it('returns empty array when no headings match the depth', () => {
    const result = filterHeadingsByDepth(mixedHeadings, 6);
    expect(result).toHaveLength(0);
  });

  it('returns all headings when all share the same depth', () => {
    const all3 = [heading(3, 'A'), heading(3, 'B'), heading(3, 'C')];
    expect(filterHeadingsByDepth(all3, 3)).toHaveLength(3);
  });

  it('returns empty array for empty input', () => {
    expect(filterHeadingsByDepth([], 1)).toEqual([]);
  });
});

// ============================================================================
// 12. topHeadingDepth
// ============================================================================

describe('topHeadingDepth', () => {
  it('returns null for empty array', () => {
    expect(topHeadingDepth([])).toBeNull();
  });

  it('returns 1 when the shallowest heading is h1', () => {
    const headings = [heading(1, 'Title'), heading(2, 'Section'), heading(3, 'Sub')];
    expect(topHeadingDepth(headings)).toBe(1);
  });

  it('returns 2 when the document starts at h2 (no h1)', () => {
    const headings = [heading(2, 'First'), heading(3, 'Second'), heading(2, 'Third')];
    expect(topHeadingDepth(headings)).toBe(2);
  });

  it('returns 6 when all headings are h6', () => {
    const headings = [heading(6, 'A'), heading(6, 'B')];
    expect(topHeadingDepth(headings)).toBe(6);
  });

  it('returns 3 when the minimum depth is 3', () => {
    const headings = [heading(3, 'Deep'), heading(4, 'Deeper'), heading(5, 'Deepest')];
    expect(topHeadingDepth(headings)).toBe(3);
  });

  it('returns the correct depth for a single heading', () => {
    expect(topHeadingDepth([heading(4, 'Only')])).toBe(4);
  });
});

// ============================================================================
// 13. HeadingNode children are preserved unchanged
// ============================================================================

describe('extractHeadingNodes — children preservation', () => {
  it('preserves the children array of a heading node by reference', () => {
    const children: MdastNode[] = [text('My Heading'), { type: 'emphasis', children: [text('italic')] }];
    const h: HeadingNode = { type: 'heading', depth: 2, children };
    const result = extractHeadingNodes(root(h));
    expect(result[0].children).toBe(children); // reference equality — no cloning
  });

  it('preserves all inline child node types inside a heading', () => {
    const h: HeadingNode = {
      type: 'heading',
      depth: 1,
      children: [
        { type: 'text', value: 'Hello ' },
        { type: 'strong', children: [{ type: 'text', value: 'World' }] },
        { type: 'text', value: '!' },
      ],
    };
    const result = extractHeadingNodes(root(h));
    expect(result[0].children).toHaveLength(3);
    expect(result[0].children[1].type).toBe('strong');
  });

  it('preserves additional custom properties on a heading node', () => {
    const h: MdastNode = {
      type: 'heading',
      depth: 2,
      children: [text('Title')],
      position: { start: { line: 1, column: 1 }, end: { line: 1, column: 10 } },
      data: { id: 'section-title' },
    };
    const result = extractHeadingNodes(root(h));
    expect(result[0]).toBe(h); // same object reference — no cloning
  });
});

// ============================================================================
// 14. Non-heading nodes with children are NOT returned
// ============================================================================

describe('extractHeadingNodes — non-heading nodes with children not returned', () => {
  it('does not return blockquote nodes even though they have children', () => {
    const ast = root(
      blockquote(paragraph('Inside blockquote.')),
    );
    const result = extractHeadingNodes(ast);
    expect(result).toEqual([]);
    expect(result.every((n) => n.type === 'heading')).toBe(true);
  });

  it('does not return list nodes even though they have children', () => {
    const ast = root(
      list(false, listItem(paragraph('Item 1.')), listItem(paragraph('Item 2.'))),
    );
    expect(extractHeadingNodes(ast)).toEqual([]);
  });

  it('does not return paragraph nodes (they may have inline children)', () => {
    const ast = root(
      paragraph('Text with ', 'multiple', ' children.'),
    );
    expect(extractHeadingNodes(ast)).toEqual([]);
  });

  it('does not return emphasis nodes inside paragraph children', () => {
    const para: MdastNode = {
      type: 'paragraph',
      children: [
        { type: 'emphasis', children: [text('emphasized')] },
      ],
    };
    expect(extractHeadingNodes(root(para))).toEqual([]);
  });
});

// ============================================================================
// 15. Large document fixture — correctness and order
// ============================================================================

describe('extractHeadingNodes — large document fixture', () => {
  /**
   * Simulate a realistic document structure:
   * # Report Title
   * [paragraph]
   * ## Executive Summary
   * [paragraph, paragraph]
   * ## Background @context.md
   * ### Problem Statement
   * [paragraph, code block]
   * ### Prior Work @reference.md
   * [paragraph]
   * ## Methodology
   * ### Data Collection
   * [paragraph, code block]
   * ### Analysis
   * #### Statistical Methods
   * [paragraph]
   * ## Results
   * [paragraph]
   * ## Conclusion
   * [paragraph]
   * ---
   * ## References
   */
  const largeDoc = root(
    heading(1, 'Report Title'),
    paragraph('Executive overview paragraph.'),
    heading(2, 'Executive Summary'),
    paragraph('Summary content.'),
    paragraph('Additional summary.'),
    heading(2, 'Background @context.md'),
    heading(3, 'Problem Statement'),
    paragraph('Problem description.'),
    codeBlock('SELECT * FROM problems;', 'sql'),
    heading(3, 'Prior Work @reference.md'),
    paragraph('Prior work content.'),
    heading(2, 'Methodology'),
    heading(3, 'Data Collection'),
    paragraph('Data collection details.'),
    codeBlock('import pandas as pd', 'python'),
    heading(3, 'Analysis'),
    heading(4, 'Statistical Methods'),
    paragraph('Stats description.'),
    heading(2, 'Results'),
    paragraph('Results paragraph.'),
    heading(2, 'Conclusion'),
    paragraph('Concluding remarks.'),
    thematicBreak(),
    heading(2, 'References'),
  );

  it('finds the correct total number of headings in the large document', () => {
    const result = extractHeadingNodes(largeDoc);
    // h1:1, h2:6, h3:4, h4:1 = 12 total
    expect(result).toHaveLength(12);
  });

  it('all returned nodes have type === "heading"', () => {
    const result = extractHeadingNodes(largeDoc);
    expect(result.every((n) => n.type === 'heading')).toBe(true);
  });

  it('first heading is h1 (document title)', () => {
    const result = extractHeadingNodes(largeDoc);
    expect(result[0].depth).toBe(1);
  });

  it('last heading is h2 (References)', () => {
    const result = extractHeadingNodes(largeDoc);
    const last = result[result.length - 1];
    expect(last.depth).toBe(2);
    expect(last.children[0]).toMatchObject({ value: 'References' });
  });

  it('h2 headings are at indices 1, 2, 5, 9, 10, 11 (0-based)', () => {
    // Heading result array indices (0-based):
    //  0: h1 — Report Title
    //  1: h2 — Executive Summary
    //  2: h2 — Background
    //  3: h3 — Problem Statement
    //  4: h3 — Prior Work
    //  5: h2 — Methodology
    //  6: h3 — Data Collection
    //  7: h3 — Analysis
    //  8: h4 — Statistical Methods
    //  9: h2 — Results
    // 10: h2 — Conclusion
    // 11: h2 — References
    const result = extractHeadingNodes(largeDoc);
    const h2Indices = result.reduce<number[]>((acc, h, i) => {
      if (h.depth === 2) acc.push(i);
      return acc;
    }, []);
    expect(h2Indices).toEqual([1, 2, 5, 9, 10, 11]);
  });

  it('h3 headings are at indices 3, 5, 8, 9 — wait, re-check', () => {
    // Let's count manually to verify order:
    // 0: h1 — Report Title
    // 1: h2 — Executive Summary
    // 2: h2 — Background
    // 3: h3 — Problem Statement
    // 4: h3 — Prior Work
    // 5: h2 — Methodology
    // 6: h3 — Data Collection
    // 7: h3 — Analysis
    // 8: h4 — Statistical Methods
    // 9: h2 — Results
    // 10: h2 — Conclusion
    // 11: h2 — References
    const result = extractHeadingNodes(largeDoc);
    expect(result[3].depth).toBe(3);
    expect(result[4].depth).toBe(3);
    expect(result[6].depth).toBe(3);
    expect(result[7].depth).toBe(3);
  });

  it('returns the correct number of h2 headings', () => {
    const result = extractHeadingNodes(largeDoc);
    expect(filterHeadingsByDepth(result, 2)).toHaveLength(6);
  });

  it('returns the correct number of h3 headings', () => {
    const result = extractHeadingNodes(largeDoc);
    expect(filterHeadingsByDepth(result, 3)).toHaveLength(4);
  });

  it('returns the correct number of h4 headings', () => {
    const result = extractHeadingNodes(largeDoc);
    expect(filterHeadingsByDepth(result, 4)).toHaveLength(1);
  });

  it('topHeadingDepth returns 1 for the large document', () => {
    const result = extractHeadingNodes(largeDoc);
    expect(topHeadingDepth(result)).toBe(1);
  });
});

// ============================================================================
// 16. Return value is always an array (never null/undefined)
// ============================================================================

describe('extractHeadingNodes — return type guarantees', () => {
  it('always returns an array (never null)', () => {
    const result = extractHeadingNodes(root());
    expect(Array.isArray(result)).toBe(true);
  });

  it('returns an array even for a document with a single non-heading node', () => {
    const result = extractHeadingNodes(root(paragraph('Just text.')));
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });
});
