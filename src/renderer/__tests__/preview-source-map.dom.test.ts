// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { createPreview, PREVIEW_JOURNAL_MAX_SOURCE_LENGTH } from '../preview';
import { htmlToMarkdown } from '../html-to-md';
import { collectPreviewBlocks, previewElementToLineRange } from '../source-preview-map';

afterEach(() => {
  document.body.innerHTML = '';
});

function mount() {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  return createPreview(parent);
}

// 1:# Title  2:(blank)  3:para one  4:(blank)  5:- a  6:- b  7:(blank)  8:> quote
const DOC = ['# Title', '', 'para one', '', '- a', '- b', '', '> quote'].join('\n');

describe('preview source map — top-level blocks get data-src/map attributes', () => {
  it('tags each top-level block with its 1-based source span and sequential mapId', () => {
    const preview = mount();
    preview.setDoc(DOC);

    const kids = Array.from(preview.el.children) as HTMLElement[];
    expect(kids.map((k) => k.tagName.toLowerCase())).toEqual(['h1', 'p', 'ul', 'blockquote']);

    const attrs = (el: HTMLElement) => ({
      start: el.getAttribute('data-src-start'),
      end: el.getAttribute('data-src-end'),
      id: el.getAttribute('data-map-id'),
    });
    expect(attrs(kids[0])).toEqual({ start: '1', end: '1', id: '0' });
    expect(attrs(kids[1])).toEqual({ start: '3', end: '3', id: '1' });
    expect(attrs(kids[2])).toEqual({ start: '5', end: '7', id: '2' }); // list absorbs the trailing blank line
    expect(attrs(kids[3])).toEqual({ start: '8', end: '8', id: '3' });
  });

  it('exposes the same map through getSourceMap() and collectPreviewBlocks()', () => {
    const preview = mount();
    preview.setDoc(DOC);

    expect(preview.getSourceMap()).toEqual([
      { mapId: 0, startLine: 1, endLine: 1 },
      { mapId: 1, startLine: 3, endLine: 3 },
      { mapId: 2, startLine: 5, endLine: 7 },
      { mapId: 3, startLine: 8, endLine: 8 },
    ]);

    const blocks = collectPreviewBlocks(preview.el);
    expect(blocks.map((b) => ({ mapId: b.mapId, startLine: b.startLine, endLine: b.endLine }))).toEqual([
      ...preview.getSourceMap(),
    ]);
    // The collected elements are the real top-level children, readable back.
    expect(previewElementToLineRange(blocks[2].el)).toEqual({ startLine: 5, endLine: 7 });
  });

  it('rebuilds the map on each setDoc (stale attributes do not linger)', () => {
    const preview = mount();
    preview.setDoc(DOC);
    expect(preview.getSourceMap()).toHaveLength(4);

    preview.setDoc('only one paragraph');
    expect(preview.getSourceMap()).toEqual([{ mapId: 0, startLine: 1, endLine: 1 }]);
    expect(preview.el.children).toHaveLength(1);
    expect(preview.el.children[0].getAttribute('data-map-id')).toBe('0');
  });

  it('keeps html:false — raw HTML is escaped, not injected, even while tagging', () => {
    const preview = mount();
    preview.setDoc('text <b>bold</b> & <script>alert(1)</script>');
    // No raw elements made it into the DOM.
    expect(preview.el.querySelector('b')).toBeNull();
    expect(preview.el.querySelector('script')).toBeNull();
    // The markup survives as visible text.
    expect(preview.el.textContent).toContain('<b>bold</b>');
    expect(preview.el.textContent).toContain('alert(1)');
  });
});
function largeMarkdown(minLength: number): string {
  let markdown = '';
  let index = 0;
  while (markdown.length <= minLength) {
    markdown += `paragraph ${index++}: source mapping must remain available during a large document open.\n\n`;
  }
  return markdown;
}

describe('preview source map — large documents', () => {
  it('renders 29 KB and 69 KB documents without source-journal work blocking the preview', () => {
    const preview = mount();

    const medium = largeMarkdown(29 * 1024);
    preview.setDoc(medium);
    expect(preview.el.textContent).toContain('paragraph 0');
    expect(preview.getSourceMap()).not.toHaveLength(0);
    expect(preview.getRunTable()).toBeNull();

    const large = largeMarkdown(69 * 1024);
    preview.setDoc(large);
    expect(large.length).toBeGreaterThan(PREVIEW_JOURNAL_MAX_SOURCE_LENGTH);
    expect(preview.el.textContent).toContain('paragraph 0');
    expect(preview.getSourceMap()).not.toHaveLength(0);
    expect(preview.getRunTable()).toBeNull();
  });
});

describe('preview source map — nested sub-block tagging (li / tr / paragraphs)', () => {
  it('tags list items with their own source span but no map-id', () => {
    const preview = mount();
    preview.setDoc(DOC); // ul [5,7] holding li [5,5] and li [6,7]
    const lis = Array.from(preview.el.querySelectorAll('li'));
    expect(lis.map((li) => [li.getAttribute('data-src-start'), li.getAttribute('data-src-end')])).toEqual([
      ['5', '5'],
      ['6', '7'],
    ]);
    // map-id is a top-level identity only; nested elements carry source spans alone.
    expect(lis.every((li) => li.getAttribute('data-map-id') === null)).toBe(true);
    // The enclosing <ul> keeps its top-level span + id (collectPreviewBlocks unaffected).
    const ul = preview.el.querySelector('ul')!;
    expect([
      ul.getAttribute('data-src-start'),
      ul.getAttribute('data-src-end'),
      ul.getAttribute('data-map-id'),
    ]).toEqual(['5', '7', '2']);
    expect(collectPreviewBlocks(preview.el).map((b) => b.mapId)).toEqual([0, 1, 2, 3]);
  });

  it('leaves a single-paragraph block as one unit (no inner <p> tag)', () => {
    const preview = mount();
    preview.setDoc(DOC);
    const bqP = preview.el.querySelector('blockquote > p')!;
    expect(bqP.hasAttribute('data-src-start')).toBe(false);
  });

  it('tags table rows but never cells', () => {
    const preview = mount();
    // 1:header 2:separator 3:row a 4:row b
    preview.setDoc(['| H1 | H2 |', '| -- | -- |', '| a1 | a2 |', '| b1 | b2 |'].join('\n'));
    const rows = Array.from(preview.el.querySelectorAll('tr'));
    expect(rows.map((tr) => [tr.getAttribute('data-src-start'), tr.getAttribute('data-src-end')])).toEqual([
      ['1', '1'], // header row
      ['3', '3'],
      ['4', '4'],
    ]);
    expect(Array.from(preview.el.querySelectorAll('td, th')).every((c) => !c.hasAttribute('data-src-start'))).toBe(
      true,
    );
    // Structural wrappers are recursed through, not tagged as a selectable unit.
    expect(preview.el.querySelector('thead')!.hasAttribute('data-src-start')).toBe(false);
    expect(preview.el.querySelector('tbody')!.hasAttribute('data-src-start')).toBe(false);
  });

  it('splits a multi-paragraph block per paragraph', () => {
    const preview = mount();
    // 1:> p1  2:>  3:> p2  → blockquote [1,3] with p [1,1] and p [3,3]
    preview.setDoc(['> p1', '>', '> p2'].join('\n'));
    const ps = Array.from(preview.el.querySelectorAll('blockquote > p'));
    expect(ps.map((p) => [p.getAttribute('data-src-start'), p.getAttribute('data-src-end')])).toEqual([
      ['1', '1'],
      ['3', '3'],
    ]);
  });

  it('readable back through previewElementToLineRange', () => {
    const preview = mount();
    preview.setDoc(DOC);
    const firstLi = preview.el.querySelector('li')!;
    expect(previewElementToLineRange(firstLi)).toEqual({ startLine: 5, endLine: 5 });
  });

  it('does not leak nested data-src attributes into htmlToMarkdown output', () => {
    const preview = mount();
    preview.setDoc(['| H1 | H2 |', '| -- | -- |', '| a1 | a2 |', '', '- one', '- two'].join('\n'));
    const out = htmlToMarkdown(preview.el.innerHTML);
    expect(out).not.toMatch(/data-src/);
    expect(out).not.toMatch(/data-map/);
    // Content still round-trips.
    expect(out).toContain('| H1 | H2 |');
    expect(out).toMatch(/-\s+one/);
  });
});

describe('preview source map — coexistence and isolation guarantees', () => {
  it('coexists with the line-number gutter toggle without dropping attributes', () => {
    const preview = mount();
    preview.setDoc(DOC);

    preview.setLineNumbers(true);
    expect(preview.el.classList.contains('preview-line-numbers')).toBe(true);
    expect(preview.el.children[0].getAttribute('data-map-id')).toBe('0');

    preview.setLineNumbers(false);
    expect(preview.el.classList.contains('preview-line-numbers')).toBe(false);
    // Toggling the gutter must not disturb the source-map attributes.
    expect(preview.el.children[0].getAttribute('data-src-start')).toBe('1');
  });

  it('does not leak data-src/data-map attributes (or line numbers) into htmlToMarkdown output', () => {
    const preview = mount();
    preview.setDoc(DOC);
    preview.setLineNumbers(true); // gutter on — its numbers are CSS-only, never DOM text.

    const out = htmlToMarkdown(preview.el.innerHTML);

    expect(out).not.toMatch(/data-src-start/);
    expect(out).not.toMatch(/data-src-end/);
    expect(out).not.toMatch(/data-map-id/);
    expect(out).not.toMatch(/data-(src|map)/);
    // The actual content round-trips cleanly.
    expect(out).toContain('# Title');
    expect(out).toContain('para one');
    expect(out).toContain('> quote');
  });
});
