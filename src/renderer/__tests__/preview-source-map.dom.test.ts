// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { createPreview } from '../preview';
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
