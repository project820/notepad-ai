import { describe, it, expect } from 'vitest';
import { computeFootnoteInsert } from '../formatting';

describe('computeFootnoteInsert (#6 · AC7) — pure footnote math', () => {
  it('numbers the first footnote [^1] in an empty doc and appends a definition', () => {
    const r = computeFootnoteInsert('', 0, 0);
    expect(r.n).toBe(1);
    expect(r.ref).toBe('[^1]');
    expect(r.doc).toBe('[^1]\n\n[^1]: ');
    // cursor sits right after the appended "[^1]: " marker (note body position)
    expect(r.selection.head).toBe(r.doc.length);
    expect(r.selection.anchor).toBe(r.doc.length);
  });

  it('inserts the reference at the end of the selection (after the selected text)', () => {
    const r = computeFootnoteInsert('hello world', 0, 5); // select "hello"
    expect(r.doc.startsWith('hello[^1] world')).toBe(true);
    expect(r.doc).toBe('hello[^1] world\n\n[^1]: ');
    expect(r.n).toBe(1);
  });

  it('inserts at the cursor when the selection is collapsed', () => {
    const r = computeFootnoteInsert('ab', 1, 1);
    expect(r.doc).toBe('a[^1]b\n\n[^1]: ');
  });

  it('computes max+1 across BOTH references and definitions', () => {
    const doc = 'See this[^1] and that[^2].\n\n[^1]: one\n[^2]: two';
    const r = computeFootnoteInsert(doc, doc.length, doc.length);
    expect(r.n).toBe(3);
    expect(r.ref).toBe('[^3]');
    expect(r.doc.endsWith('[^3]\n\n[^3]: ')).toBe(true);
  });

  it('ignores non-numeric footnote markers like [^note]', () => {
    const r = computeFootnoteInsert('see [^note] here', 0, 0);
    expect(r.n).toBe(1);
  });

  it('collapses to a single blank line when the body already ends with one newline', () => {
    // ref inserted at start so the body keeps its single trailing newline
    const r = computeFootnoteInsert('abc\n', 0, 0);
    expect(r.doc).toBe('[^1]abc\n\n[^1]: ');
  });

  it('does not add extra blank lines when the body already ends with a blank line', () => {
    const r = computeFootnoteInsert('abc\n\n', 0, 0);
    expect(r.doc).toBe('[^1]abc\n\n[^1]: ');
  });

  it('skips numeric gaps correctly (uses the max, not the count)', () => {
    const doc = 'x[^5]y';
    const r = computeFootnoteInsert(doc, doc.length, doc.length);
    expect(r.n).toBe(6);
  });
});
