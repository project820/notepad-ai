import { describe, it, expect } from 'vitest';
import { createMarkdownIt } from '../markdown-it';
import {
  buildTokenLineRanges,
  lineToPreviewBlocks,
  previewElementToLineRange,
  rangeToLineSpan,
  type SourceLineRange,
} from '../source-preview-map';

const md = createMarkdownIt();
const ranges = (src: string): SourceLineRange[] => buildTokenLineRanges(md, src);
/** Compact [startLine, endLine] tuples for readable assertions. */
const spans = (rs: SourceLineRange[]): Array<[number, number]> => rs.map((r) => [r.startLine, r.endLine]);

describe('buildTokenLineRanges — top-level block line spans (1-based inclusive)', () => {
  it('maps headings, multi-line paragraphs and blank-line gaps', () => {
    // 1:# Heading  2:(blank)  3:Para one  4:wrapped  5:(blank)  6:## Sub
    const rs = ranges('# Heading\n\nPara one\nwrapped\n\n## Sub');
    expect(spans(rs)).toEqual([
      [1, 1], // # Heading
      [3, 4], // multi-line paragraph
      [6, 6], // ## Sub
    ]);
  });

  it('assigns sequential mapIds in document order', () => {
    const rs = ranges('a\n\nb\n\nc');
    expect(rs.map((r) => r.mapId)).toEqual([0, 1, 2]);
    expect(spans(rs)).toEqual([[1, 1], [3, 3], [5, 5]]);
  });

  it('collapses a nested + task list into a single enclosing block', () => {
    // 1:- a  2:- b  3:  - nested  4:- [ ] task  5:- [x] done
    const rs = ranges('- a\n- b\n  - nested\n- [ ] task\n- [x] done');
    expect(spans(rs)).toEqual([[1, 5]]);
    expect(rs[0].mapId).toBe(0);
  });

  it('treats ordered lists as one top-level block', () => {
    expect(spans(ranges('1. one\n2. two\n3. three'))).toEqual([[1, 3]]);
  });

  it('spans a multi-line blockquote', () => {
    expect(spans(ranges('> q1\n> q2'))).toEqual([[1, 2]]);
  });

  it('spans a fenced code block including its fences', () => {
    const rs = ranges(['```js', 'const x = 1;', '```'].join('\n'));
    expect(spans(rs)).toEqual([[1, 3]]);
  });

  it('spans an indented code block', () => {
    expect(spans(ranges('    line one\n    line two'))).toEqual([[1, 2]]);
  });

  it('spans a GFM table including header and separator rows', () => {
    const rs = ranges('| a | b |\n| - | - |\n| 1 | 2 |');
    expect(spans(rs)).toEqual([[1, 3]]);
  });

  it('maps an hr as a single line and keeps surrounding blocks separate', () => {
    // 1:before 2:(blank) 3:--- 4:(blank) 5:after
    expect(spans(ranges('before\n\n---\n\nafter'))).toEqual([[1, 1], [3, 3], [5, 5]]);
  });

  it('does not let footnote definitions corrupt or extend content ranges', () => {
    // 1:ref[^1]  2:(blank)  3:[^1]: body
    const rs = ranges('ref[^1]\n\n[^1]: body');
    // Only the referencing paragraph is mapped; the footnote section (appended
    // out of document order, no token map) is intentionally excluded.
    expect(spans(rs)).toEqual([[1, 1]]);
    // The footnote-definition source line (3) belongs to no preview block.
    expect(lineToPreviewBlocks(rs, 3)).toEqual([]);
  });

  it('returns an empty map for an empty document', () => {
    expect(ranges('')).toEqual([]);
  });

  it('escapes raw HTML into paragraphs (html:false) rather than emitting html blocks', () => {
    const src = '<div onclick="x">hi</div>\n\nnext';
    expect(spans(ranges(src))).toEqual([[1, 1], [3, 3]]);
    expect(md.render(src)).not.toContain('<div');
  });
});

describe('lineToPreviewBlocks — binary search by line', () => {
  // 1:before 2:(blank) 3:--- 4:(blank) 5:after
  const rs = ranges('before\n\n---\n\nafter');

  it('finds the block containing a line', () => {
    expect(lineToPreviewBlocks(rs, 1).map((r) => r.mapId)).toEqual([0]);
    expect(lineToPreviewBlocks(rs, 3).map((r) => r.mapId)).toEqual([1]);
    expect(lineToPreviewBlocks(rs, 5).map((r) => r.mapId)).toEqual([2]);
  });

  it('returns nothing for blank-line gaps between blocks', () => {
    expect(lineToPreviewBlocks(rs, 2)).toEqual([]);
    expect(lineToPreviewBlocks(rs, 4)).toEqual([]);
  });

  it('returns nothing for lines before the first or after the last block', () => {
    expect(lineToPreviewBlocks(rs, 0)).toEqual([]);
    expect(lineToPreviewBlocks(rs, 99)).toEqual([]);
    expect(lineToPreviewBlocks([], 1)).toEqual([]);
  });

  it('finds the right block in a many-block document', () => {
    const many = ranges('a\n\nb\n\nc\n\nd\n\ne');
    expect(spans(many)).toEqual([[1, 1], [3, 3], [5, 5], [7, 7], [9, 9]]);
    expect(lineToPreviewBlocks(many, 7).map((r) => r.mapId)).toEqual([3]);
    expect(lineToPreviewBlocks(many, 9).map((r) => r.mapId)).toEqual([4]);
    expect(lineToPreviewBlocks(many, 8)).toEqual([]);
  });
});

describe('rangeToLineSpan — blocks intersecting a source selection', () => {
  // 1:before 2:(blank) 3:--- 4:(blank) 5:after  ->  [1,1] [3,3] [5,5]
  const rs = ranges('before\n\n---\n\nafter');

  it('returns the single block for a span inside one block', () => {
    expect(rangeToLineSpan(rs, 1, 1).map((r) => r.mapId)).toEqual([0]);
  });

  it('returns every block the span crosses', () => {
    expect(rangeToLineSpan(rs, 1, 3).map((r) => r.mapId)).toEqual([0, 1]);
    expect(rangeToLineSpan(rs, 3, 5).map((r) => r.mapId)).toEqual([1, 2]);
  });

  it('normalizes a reversed span (to < from)', () => {
    expect(rangeToLineSpan(rs, 5, 1).map((r) => r.mapId)).toEqual([0, 1, 2]);
  });

  it('returns nothing for a span entirely in a gap', () => {
    expect(rangeToLineSpan(rs, 2, 2)).toEqual([]);
    expect(rangeToLineSpan([], 1, 9)).toEqual([]);
  });
});

describe('previewElementToLineRange — read a tagged element span', () => {
  const stub = (attrs: Record<string, string>) => ({
    getAttribute: (name: string): string | null => (name in attrs ? attrs[name] : null),
  });

  it('reads numeric data-src-start/end', () => {
    expect(previewElementToLineRange(stub({ 'data-src-start': '3', 'data-src-end': '5' }))).toEqual({
      startLine: 3,
      endLine: 5,
    });
  });

  it('returns null when the attributes are missing', () => {
    expect(previewElementToLineRange(stub({ 'data-src-start': '3' }))).toBeNull();
    expect(previewElementToLineRange(stub({}))).toBeNull();
  });

  it('returns null when the attributes are not numbers', () => {
    expect(previewElementToLineRange(stub({ 'data-src-start': 'x', 'data-src-end': '5' }))).toBeNull();
  });
});
