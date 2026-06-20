// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { createMarkdownIt } from '../markdown-it';
import { htmlToMarkdown } from '../html-to-md';

const md = createMarkdownIt();
const render = (src: string) => md.render(src);

// 1. Rendering — every extended syntax produces the expected element.
describe('extended markdown — createMarkdownIt() rendering', () => {
  it('renders ==highlight== as <mark>', () => {
    expect(render('==hi==')).toContain('<mark>');
  });

  it('renders ~x~ as <sub>', () => {
    expect(render('H~2~O')).toContain('<sub>');
  });

  it('renders ^x^ as <sup>', () => {
    expect(render('x^2^')).toContain('<sup>');
  });

  it('substitutes :smile: emoji (no literal token left)', () => {
    const out = render(':smile:');
    expect(out).not.toContain(':smile:');
  });

  it('applies a header id via {#my-id}', () => {
    expect(render('# H {#hi}')).toContain('<h1 id="hi">');
  });

  it('renders a definition list (<dl>/<dt>/<dd>)', () => {
    const out = render('Term\n: Definition\n');
    expect(out).toContain('<dl>');
    expect(out).toContain('<dt>');
    expect(out).toContain('<dd>');
  });
});

// 2. Security — html:false is a hard boundary and attrs is locked to `id`.
describe('extended markdown — html:false security boundary', () => {
  it('escapes raw HTML instead of injecting it', () => {
    const out = render('<div>foo</div>');
    expect(out).not.toContain('<div>');
    expect(out).toContain('&lt;div&gt;');
  });

  it('attrs restricts to id — keeps id, drops onclick', () => {
    const out = render('# H {#id onclick=alert(1)}');
    expect(out).toContain('id="id"');
    expect(out).not.toContain('onclick');
  });
});

// 3. Round-trip — preview HTML serializes back to the same source markup.
describe('extended markdown — turndown round-trip (htmlToMarkdown)', () => {
  it('<mark>x</mark> → ==x==', () => {
    expect(htmlToMarkdown('<mark>x</mark>').trim()).toBe('==x==');
  });

  it('<sub>x</sub> → ~x~', () => {
    expect(htmlToMarkdown('<sub>x</sub>').trim()).toBe('~x~');
  });

  it('<sup>x</sup> → ^x^', () => {
    expect(htmlToMarkdown('<sup>x</sup>').trim()).toBe('^x^');
  });

  it('<h2 id="foo">Bar</h2> → ## Bar {#foo}', () => {
    expect(htmlToMarkdown('<h2 id="foo">Bar</h2>').trim()).toBe('## Bar {#foo}');
  });

  it('heading without id stays a plain ATX heading', () => {
    expect(htmlToMarkdown('<h3>Plain</h3>').trim()).toBe('### Plain');
  });

  it('<dl><dt>Term</dt><dd>Def</dd></dl> → term line + ": Def"', () => {
    const out = htmlToMarkdown('<dl><dt>Term</dt><dd>Def</dd></dl>');
    expect(out).toContain('Term');
    expect(out).toContain(': Def');
  });
});

// 4. No-leak — rendering through the shared instance never emits the source-map
//    bookkeeping attributes into the round-tripped markdown.
describe('extended markdown — no source-map leakage', () => {
  it('rendered + round-tripped doc carries no data-src/data-map attrs', () => {
    const div = document.createElement('div');
    div.innerHTML = render(
      ['==hi== H~2~O x^2^ :smile:', '', '# Head {#h}', '', 'Term', ': Def'].join('\n'),
    );
    const out = htmlToMarkdown(div.innerHTML);
    expect(out).not.toContain('data-src');
    expect(out).not.toContain('data-map');
  });
});
