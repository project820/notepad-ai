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

  it('does NOT treat ~x~ as subscript — `~` is a range/approx char in Korean prose', () => {
    // Regression: `50~55%` must stay literal text, not render `50` as <sub>.
    const out = render('일본 50~55% 비율');
    expect(out).not.toContain('<sub>');
    expect(out).toContain('50~55%');
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

  it('<sup>x</sup> → ^x^', () => {
    expect(htmlToMarkdown('<sup>x</sup>').trim()).toBe('^x^');
  });

  it('<h2 id="foo">Bar</h2> → ## Bar {#foo}', () => {
    expect(htmlToMarkdown('<h2 id="foo">Bar</h2>').trim()).toBe('## Bar {#foo}');
  });

  it('heading without id stays a plain ATX heading', () => {
    expect(htmlToMarkdown('<h3>Plain</h3>').trim()).toBe('### Plain');
  });

  it('sanitizes a heading id that would corrupt the {#id} token', () => {
    // A space/brace-bearing id must not emit `{#my heading}` (unparseable) or
    // smuggle `onclick=…` into the attr token; it is reduced to a safe slug.
    expect(htmlToMarkdown('<h2 id="my heading">Bar</h2>').trim()).toBe('## Bar {#my-heading}');
    const out = htmlToMarkdown('<h2 id="id onclick=alert(1)">Bar</h2>').trim();
    expect(out).toBe('## Bar {#id-onclick-alert-1}');
    expect(out).not.toContain('onclick=alert');
    expect(out).not.toContain(' {#id ');
  });

  it('strips embed/media/form elements that have no markdown representation', () => {
    expect(htmlToMarkdown('<iframe src="data:text/html,x"></iframe>').trim()).toBe('');
    expect(htmlToMarkdown('<svg><path d="M0 0"/></svg>').trim()).toBe('');
    expect(htmlToMarkdown('<p>keep</p><form><button>x</button></form>').trim()).toBe('keep');
    // <img> is intentionally preserved (gfm emits markdown image syntax).
    expect(htmlToMarkdown('<img src="data:image/png;base64,AAAA" alt="a">').trim()).toContain('![a]');
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
