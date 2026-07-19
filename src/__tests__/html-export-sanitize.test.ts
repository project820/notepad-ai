import { type DefaultTreeAdapterTypes } from 'parse5';
import { describe, expect, it } from 'vitest';
import {
  CSS_MAX_KEYFRAMES,
  CSS_MAX_RULES,
  CSS_MAX_STYLESHEET_BYTES,
  cssRejectedCode,
} from '../main/html-export-css-sanitize';
import {
  HTML_SANITIZER_LIMITS,
  HTML_VIOLATION_CODES,
  sanitizeHtmlExport,
  type HtmlExportParse,
  type HtmlExportSanitizeOptions,
} from '../main/html-export-sanitize';

type Assert<T extends true> = T;
type RequiresAssetPredicate = Assert<
  HtmlExportSanitizeOptions extends { isAllowedAssetId: (src: string) => boolean } ? true : false
>;
function sanitize(html: string, opts: { requireStructuralDocument?: boolean } = {}) {
  return sanitizeHtmlExport({ html, isAllowedAssetId: () => true, ...opts });
}

function dispositionCode(html: string, opts: { requireStructuralDocument?: boolean } = {}): string {
  const result = sanitize(html, opts);
  return result.ok ? result.stripped[0] ?? '' : result.violations[0].code;
}
const failureCode = dispositionCode;
const failureCodeWithParse = dispositionCodeWithParse;

function injectedParse(document: unknown): HtmlExportParse {
  return (() => document as DefaultTreeAdapterTypes.Document) as HtmlExportParse;
}

function dispositionCodeWithParse(document: unknown): string {
  const result = sanitizeHtmlExport({ html: '', parse: injectedParse(document), isAllowedAssetId: () => false });
  return result.ok ? result.stripped[0] ?? '' : result.violations[0].code;
}

function documentWithTextNodes(count: number): DefaultTreeAdapterTypes.Document {
  return {
    nodeName: '#document',
    mode: 'no-quirks',
    childNodes: Array.from({ length: count }, () => ({ nodeName: '#text', value: 'x', parentNode: null })),
  } as DefaultTreeAdapterTypes.Document;
}

function documentWithDepth(depth: number): DefaultTreeAdapterTypes.Document {
  let node: Record<string, unknown> = { nodeName: '#text', value: 'leaf', parentNode: null };
  for (let index = 0; index < depth - 1; index++) {
    node = {
      nodeName: 'div', tagName: 'div', namespaceURI: 'http://www.w3.org/1999/xhtml', attrs: [],
      childNodes: [node], parentNode: null,
    };
  }
  return { nodeName: '#document', mode: 'no-quirks', childNodes: [node] } as DefaultTreeAdapterTypes.Document;
}

function elementWithAttributes(count: number): Record<string, unknown> {
  return {
    nodeName: 'p', tagName: 'p', namespaceURI: 'http://www.w3.org/1999/xhtml', parentNode: null,
    attrs: Array.from({ length: count }, () => ({ name: 'class', value: 'safe' })), childNodes: [],
  };
}

function documentWithElements(attributeCounts: number[]): DefaultTreeAdapterTypes.Document {
  return {
    nodeName: '#document', mode: 'no-quirks', childNodes: attributeCounts.map(elementWithAttributes),
  } as DefaultTreeAdapterTypes.Document;
}
function documentWithElement(tag: string, attrs: Array<{ name: string; value: string }> = []): DefaultTreeAdapterTypes.Document {
  return {
    nodeName: '#document',
    mode: 'no-quirks',
    childNodes: [{ nodeName: tag, tagName: tag, namespaceURI: 'http://www.w3.org/1999/xhtml', attrs, childNodes: [], parentNode: null }],
  } as DefaultTreeAdapterTypes.Document;
}


function cssComment(bytes: number): string {
  return `/*${'x'.repeat(bytes - 4)}*/`;
}

describe('sanitizeHtmlExport', () => {
  it('exports stable violation codes for downstream pipeline errors', () => {
    expect(HTML_VIOLATION_CODES.parse).toBe('html_parse');
    expect(cssRejectedCode('css_too_large')).toBe('css_rejected.css_too_large');
    expect(HTML_VIOLATION_CODES.internal).toBe('html_internal');
  });
  it('preserves the frozen inert content, table, code, and image tags', () => {
    const result = sanitize(
      '<article><h1>Report</h1><p><strong>Ready</strong><br><code>x</code></p>' +
      '<table><caption>Totals</caption><thead><tr><th scope="col">Name</th></tr></thead>' +
      '<tbody><tr><td colspan="2">One</td></tr></tbody></table>' +
      '<img src="asset:abcdefghijklmnop" alt="chart" width="240px"></article>',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bodyHtml).toContain('<article>');
    expect(result.bodyHtml).toContain('<table>');
    expect(result.bodyHtml).toContain('<code>x</code>');
    expect(result.bodyHtml).toContain('src="asset:abcdefghijklmnop"');
    expect(result.documentHtml).toContain('<!DOCTYPE html>');
  });

  it('unwraps unknown layout tags while preserving their inert children', () => {
    const result = sanitize('<layout-shell><p>Kept</p><fancy-label>Text</fancy-label></layout-shell>');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bodyHtml).toBe('<p>Kept</p>Text');
  });
  it('preserves interactive form containers', () => {
    const result = sanitize('<form><p>Kept</p></form>');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bodyHtml).toContain('<form><p>Kept</p></form>');
  });
  it('preserves safe input bounds and strips unsafe bound values', () => {
    const result = sanitize('<input type="range" min="1" max="5" step="0.5"><input min="javascript:1" max="&quot;5" step="Infinity">');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bodyHtml).toContain('<input type="range" min="1" max="5" step="0.5">');
    expect(result.bodyHtml).toContain('<input>');
    expect(result.bodyHtml).not.toContain('javascript:1');
    expect(result.bodyHtml).not.toContain('Infinity');
  });
  it('preserves inert boolean form attributes only when present without a value or with their own name', () => {
    const result = sanitize(
      '<input required checked="checked" disabled="disabled" readonly="readonly" multiple="multiple">' +
      '<textarea required readonly></textarea><select required disabled multiple></select>' +
      '<input required="false" checked="true">',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bodyHtml).toContain('<input required="" checked="" disabled="" readonly="" multiple="">');
    expect(result.bodyHtml).toContain('<textarea required="" readonly=""></textarea>');
    expect(result.bodyHtml).toContain('<select required="" disabled="" multiple=""></select>');
    expect(result.bodyHtml).not.toContain('required="false"');
    expect(result.bodyHtml).not.toContain('checked="true"');
  });
  it('preserves inert label and control metadata while stripping hostile values', () => {
    const result = sanitize(
      '<label for="city">City</label><textarea name="notes" placeholder="Add notes"></textarea><select name="city"></select>' +
      '<label for="javascript:city">Unsafe</label><textarea name="https://example.test" placeholder="javascript:alert(1)"></textarea><select name="javascript:city"></select>',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bodyHtml).toContain('<label for="city">City</label>');
    expect(result.bodyHtml).toContain('<textarea name="notes" placeholder="Add notes"></textarea>');
    expect(result.bodyHtml).toContain('<select name="city"></select>');
    expect(result.bodyHtml).not.toContain('javascript:');
    expect(result.bodyHtml).not.toContain('https://example.test');
  });
  it('preserves select options and removes unsupported option attributes', () => {
    const result = sanitize(
      '<select><optgroup label="Regions" disabled><option value="seoul" label="Seoul" selected>Seoul</option>' +
      '<option value="busan" disabled type="button" name="city">Busan</option></optgroup></select>',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bodyHtml).toContain('<select><optgroup label="Regions" disabled=""><option value="seoul" label="Seoul" selected="">Seoul</option><option value="busan" disabled="">Busan</option></optgroup></select>');
    expect(result.bodyHtml).not.toContain('type="button"');
    expect(result.bodyHtml).not.toContain('name="city"');
  });
  it('preserves case-insensitive arbitrary input steps but rejects hostile step values', () => {
    const result = sanitize('<input type="range" step="ANY"><input type="range" step="anywhere"><input type="range" step="Infinity">');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bodyHtml).toContain('<input type="range" step="ANY">');
    expect(result.bodyHtml).not.toContain('step="anywhere"');
    expect(result.bodyHtml).not.toContain('step="Infinity"');
  });
  it('unwraps template content stored outside its childNodes array', () => {
    const result = sanitize('<div><template><p>Template text</p></template></div>');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bodyHtml).toContain('<p>Template text</p>');
    expect(result.bodyHtml).not.toContain('<template');
    expect(result.stripped).toContain('html_active_tag');
  });

  it.each([
    'iframe', 'object', 'embed', 'base', 'frame', 'frameset', 'applet', 'link', 'template', 'slot',
  ])('rejects unsupported active tag <%s>', (tag) => {
    expect(dispositionCodeWithParse(documentWithElement(tag))).toBe('html_active_tag');
  });
  it.each(['script', 'form', 'input', 'button'])('preserves interactive tag <%s>', (tag) => {
    expect(dispositionCodeWithParse(documentWithElement(tag))).toBe('');
  });
  it('relocates inline head scripts before model body content in source order', () => {
    const result = sanitize(
      '<!doctype html><html><head>' +
      '<script>window.order = ["head-1"];</script>' +
      '<script>window.order.push("head-2");</script>' +
      '</head><body><div>body content</div><script>window.order.push("body");</script></body></html>',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bodyContent = result.bodyHtml.indexOf('<div>body content</div>');
    const bodyScript = result.bodyHtml.indexOf('window.order.push("body")');
    const firstHeadScript = result.bodyHtml.indexOf('window.order = ["head-1"]');
    const secondHeadScript = result.bodyHtml.indexOf('window.order.push("head-2")');
    expect(result.bodyHtml).toContain('<script>window.order = ["head-1"];</script>');
    expect(result.bodyHtml).toContain('<script>window.order.push("head-2");</script>');
    expect(firstHeadScript).toBe(8);
    expect(secondHeadScript).toBeGreaterThan(firstHeadScript);
    expect(bodyContent).toBeGreaterThan(secondHeadScript);
    expect(bodyScript).toBeGreaterThan(bodyContent);
  });
  it('relocates head definitions before body calls', () => {
    const result = sanitize(
      '<!doctype html><html><head><script>window.init = () => "ready";</script></head>' +
      '<body><script>init()</script></body></html>',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bodyHtml).toBe('<script>window.init = () => "ready";</script><script>init()</script>');
  });
  it('strips head scripts with src attributes', () => {
    const result = sanitize(
      '<!doctype html><html><head><script src="asset:abcdefghijklmnop">window.external = true;</script></head>' +
      '<body><p>Kept</p></body></html>',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bodyHtml).toContain('<p>Kept</p>');
    expect(result.bodyHtml).not.toContain('<script');
    expect(result.bodyHtml).not.toContain('window.external');
  });
  it('continues to extract head styles into authored CSS', () => {
    const result = sanitize('<!doctype html><html><head><style>p { color: red; }</style></head><body><p>Kept</p></body></html>');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bodyHtml).toBe('<p>Kept</p>');
    expect(result.contentCss).toContain('p{color:red}');
  });

  it('rejects meta http-equiv as an active redirect surface', () => {
    expect(dispositionCodeWithParse(documentWithElement('meta', [{ name: 'http-equiv', value: 'refresh' }]))).toBe('html_active_tag');
  });

  it.each([
    ['srcset', '<img srcset="asset:abcdefghijklmnop 1x">', 'html_url'],
    ['poster', '<p poster="https://example.test/x">x</p>', 'html_url'],
    ['formaction', '<p formaction="https://example.test/x">x</p>', 'html_url'],
    ['background', '<p background="https://example.test/x">x</p>', 'html_url'],
    ['ping', '<a href="#x" ping="https://example.test/x">x</a>', 'html_url'],
    ['action', '<p action="https://example.test/x">x</p>', 'html_url'],
    ['external href', '<a href="https://example.test">x</a>', 'html_url'],
    ['relative href', '<a href="details">x</a>', 'html_url'],
    ['xlink:href', '<svg><use xlink:href="#x"></use></svg>', 'html_reserved_namespace'],
    ['empty fragment href', '<a href="#">x</a>', 'html_url'],
  ])('rejects URL-bearing %s attribute', (_name, html, code) => {
    expect(dispositionCode(html)).toBe(code);
  });

  it('preserves event handlers while rejecting app shell/runtime namespace preseed', () => {
    expect(dispositionCode('<p onclick="x">x</p>')).toBe('');
    expect(dispositionCode('<p data-he-layout="slides">x</p>')).toBe('html_reserved_namespace');
    expect(dispositionCode('<p class="he-shell">x</p>')).toBe('html_reserved_namespace');
    expect(dispositionCode('<p id="runtime-root">x</p>')).toBe('html_reserved_namespace');
  });
  it('reserves the nai runtime namespace', () => {
    expect(dispositionCode('<p data-nai-state="x" class="nai-theme-toggle" id="nai-runtime">x</p>')).toBe(
      'html_reserved_namespace',
    );
  });
  it('keeps interactive event attributes while stripping reserved attributes', () => {
    const result = sanitize('<p onclick="x" data-he-layout="slides" class="he-shell">Kept</p>');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bodyHtml).toContain('onclick="x"');
    expect(result.bodyHtml).not.toContain('data-he-');
    expect(result.bodyHtml).not.toContain('he-shell');
  });

  it.each([
    ['minimum opaque ID', 'asset:abcdefghijklmnop', true],
    ['maximum opaque ID', `asset:${'a'.repeat(128)}`, true],
    ['one character below minimum', `asset:${'a'.repeat(15)}`, false],
    ['one character above maximum', `asset:${'a'.repeat(129)}`, false],
    ['slash', 'asset:abcdefghijklmnop/path', false],
    ['percent encoding', 'asset:abcdefghijklm%20', false],
    ['query', 'asset:abcdefghijklmnop?q=x', false],
    ['fragment', 'asset:abcdefghijklmnop#x', false],
    ['wrong prefix', 'assets:abcdefghijklmnop', false],
    ['uppercase prefix', 'ASSET:abcdefghijklmnop', false],
    ['dot in opaque ID', 'asset:abcdefghijklmno.', false],
  ])('strips invalid opaque asset IDs: %s', (_name, src, accepted) => {
    const result = sanitize(`<img src="${src}">`);
    expect(result.ok).toBe(true);
    if (!accepted && result.ok) {
      expect(result.stripped).toContain('html_asset_id');
      expect(result.bodyHtml).not.toContain(src);
    }
  });

  it('accepts fragment-only links and source asset IDs', () => {
    const result = sanitize('<a href="#details">Details</a><picture><source src="asset:abcdefghijklmnop"></picture>');
    expect(result.ok).toBe(true);
  });
  it('strips denied syntactically valid asset IDs', () => {
    const allowed = sanitizeHtmlExport({
      html: '<img src="asset:abcdefghijklmnop">',
      isAllowedAssetId: (src) => src === 'asset:abcdefghijklmnop',
    });
    const denied = sanitizeHtmlExport({
      html: '<img src="asset:abcdefghijklmnop">',
      isAllowedAssetId: () => false,
    });
    expect(allowed.ok).toBe(true);
    expect(denied.ok).toBe(true);
    if (denied.ok) expect(denied.stripped).toContain('html_asset_id');
  });

  it.each([
    'https://example.test/x',
    '//example.test/x',
    'images/x.png',
    'data:image/png;base64,AAAA',
    'asset:abcdefghijklmnop?q=x',
    'asset:abcdefghijklmnop#x',
    'asset:abcdefghijklm%20',
  ])('strips unsafe src even with a permissive asset validator: %s', (src) => {
    const result = sanitizeHtmlExport({ html: `<img src="${src}">`, isAllowedAssetId: () => true });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.stripped).toContain('html_asset_id');
    if (result.ok) expect(result.bodyHtml).not.toContain(src);
  });

  it('extracts stylesheet rules and non-empty inline styles with deterministic markers', () => {
    const result = sanitize(
      '<style>.note{color:red}</style><p style="font-weight:700">One</p>' +
      '<span style="color:blue">Two</span><i style="/**/">No marker</i>',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bodyHtml).not.toContain('<style');
    expect(result.bodyHtml).toContain('data-he-inline-style="0"');
    expect(result.bodyHtml).toContain('data-he-inline-style="1"');
    expect(result.bodyHtml).not.toContain('data-he-inline-style="2"');
    expect(result.contentCss).toContain('@layer he-authored{[data-he-content] .note{color:red}}');
    expect(result.contentCss).toContain('[data-he-content] [data-he-inline-style="0"]{font-weight:700}');
    expect(result.contentCss).toContain('[data-he-content] [data-he-inline-style="1"]{color:blue}');
  });
  it('strips style element attributes while preserving valid stylesheet rules', () => {
    const result = sanitize('<style type="text/css">.note{color:red}</style><p class="note">Kept</p>');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bodyHtml).toContain('Kept');
    expect(result.bodyHtml).not.toContain('<style');
    expect(result.contentCss).toContain('[data-he-content] .note{color:red}');
    expect(result.stripped).toContain('html_attribute');
  });
  it('preserves a safe sibling rule after an allowed screen media rule', () => {
    const result = sanitize('<style>@media screen {.screen-only{color:red}} .safe{color:blue}</style>');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contentCss).toContain('@media screen{[data-he-content] .screen-only{color:red}}');
    expect(result.contentCss).toContain('[data-he-content] .safe{color:blue}');
  });
  it('does not register keyframes from discarded template styles', () => {
    const result = sanitize(
      '<template><style>@keyframes k {from{opacity:0}}</style></template>' +
      '<div style="animation:k 100ms">x</div>',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contentCss).not.toContain('@keyframes he-k');
    expect(result.contentCss).not.toContain('animation:he-k');
    expect(result.stripped).toContain('css_rejected.css_unresolved_animation');
  });
  it.each([
    ['discarded object', '<object><style>@keyframes k {from{opacity:0}}</style></object>'],
    ['unsafe SVG', '<svg><style>@keyframes k {from{opacity:0}}</style></svg>'],
  ])('does not register keyframes from %s styles', (_name, discardedMarkup) => {
    const result = sanitize(`${discardedMarkup}<div style="animation:k 100ms">x</div>`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contentCss).not.toContain('@keyframes he-k');
    expect(result.contentCss).not.toContain('animation:he-k');
    expect(result.stripped).toContain('css_rejected.css_unresolved_animation');
  });

  it('pre-registers keyframes across style blocks before sanitizing forward animation references', () => {
    const result = sanitize(
      '<style>.animated{animation:spin 100ms}</style>' +
      '<style>@keyframes spin{from{opacity:0}to{opacity:1}}</style>' +
      '<p class="animated">x</p>',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contentCss).toContain('animation:he-k0 100ms');
    expect(result.contentCss).toContain('@keyframes he-k0{from{opacity:0}to{opacity:1}}');
  });

  it('strips CSS rejection subcodes without leaking violation details into codes', () => {
    const stylesheet = sanitize('<style>.x{background:url(https://example.test/x)}</style><p>safe</p>');
    expect(stylesheet).toMatchObject({ ok: true, stripped: ['css_rejected.css_network_function_not_allowed'] });

    const inline = sanitize('<p style="color:red!important">safe</p>');
    expect(inline).toMatchObject({ ok: true, stripped: [] });
    if (inline.ok) expect(inline.contentCss).toContain('color:red!important');
  });
  it('strips oversized malformed CSS before stylesheet registration can parse it', () => {
    const result = sanitize(`<style>${'@'.repeat(CSS_MAX_STYLESHEET_BYTES + 1)}</style>`);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.stripped).toContain('css_rejected.css_too_large');
  });
  it('keeps interactive sticky declarations', () => {
    const result = sanitize('<style>:is(.note){position:sticky;color:red}.plain{color:blue}</style><p class="note">Kept</p><p class="plain">Also kept</p>');
    expect(result).toMatchObject({ ok: true, stripped: [] });
    if (!result.ok) return;
    expect(result.bodyHtml).toContain('Kept');
    expect(result.contentCss).toContain(':is(.note){position:sticky;color:red}');
    expect(result.contentCss).toContain('.plain{color:blue}');
  });

  it('keeps reserved namespace checks ahead of malformed CSS', () => {
    for (const [html, code] of [
      ['<style data-he-injected="x">@</style>', 'html_reserved_namespace'],
    ]) {
      expect(failureCode(html)).toBe(code);
    }
  });
  it.each([
    ['active ancestor', '<form><svg><path d="M,0 0"/></svg></form>', 'html_svg_rejected'],
    ['event ancestor', '<div onclick="x"><svg><path d="M,0 0"/></svg></div>', 'html_svg_rejected'],
    ['reserved ancestor', '<div class="he-shell"><svg><path d="M,0 0"/></svg></div>', 'html_reserved_namespace'],
    ['structural ancestor', '<p contenteditable="true"><svg><path d="M,0 0"/></svg></p>', 'html_attribute'],
  ])('gives outer HTML boundaries precedence over malformed SVG: %s', (_name, html, code) => {
    expect(failureCode(html)).toBe(code);
  });
  it.each([
    ['style before reserved class', '<p style="@" class="he-shell">x</p>', 'html_reserved_namespace'],
    ['reserved class before style', '<p class="he-shell" style="@">x</p>', 'html_reserved_namespace'],
    ['style before reserved id', '<p style="@" id="runtime-root">x</p>', 'html_reserved_namespace'],
    ['reserved id before style', '<p id="runtime-root" style="@">x</p>', 'html_reserved_namespace'],
    ['style before disallowed attribute', '<p style="@" contenteditable="true">x</p>', 'html_attribute'],
    ['disallowed attribute before style', '<p contenteditable="true" style="@">x</p>', 'html_attribute'],
  ])('preflights structural attribute failure regardless of style order: %s', (_name, html, code) => {
    expect(failureCode(html)).toBe(code);
  });

  it('strips CSS that exceeds aggregate byte caps across surfaces', () => {
    const exact = sanitize(
      `<style>${cssComment(CSS_MAX_STYLESHEET_BYTES - 8)}</style><style>/**/</style><p style="/**/">x</p>`,
    );
    expect(exact.ok).toBe(true);
    if (exact.ok) expect(exact.bodyHtml).not.toContain('data-he-inline-style');

    const past = sanitize(
      `<style>${cssComment(CSS_MAX_STYLESHEET_BYTES - 8)}</style><style>/**/</style><p style="/*x*/">x</p>`,
    );
    expect(past).toMatchObject({ ok: true, stripped: ['css_rejected.css_too_large'] });
  });

  it('enforces CSS rule and keyframe caps across separate style blocks', () => {
    const withinRuleCap = Array.from({ length: CSS_MAX_RULES }, (_, index) => `<style>.r${index}{color:red}</style>`).join('') + '<p>x</p>';
    expect(sanitize(withinRuleCap).ok).toBe(true);
    const pastRuleCap = `${withinRuleCap}<style>.overflow{color:red}</style>`;
    expect(failureCode(pastRuleCap)).toBe('css_rejected.css_too_many_rules');

    const keyframe = (index: number) => `<style>@keyframes k${index}{from{opacity:0}to{opacity:1}}</style>`;
    expect(sanitize(Array.from({ length: CSS_MAX_KEYFRAMES }, (_, index) => keyframe(index)).join('') + '<p>x</p>').ok).toBe(true);
    expect(failureCode(Array.from({ length: CSS_MAX_KEYFRAMES + 1 }, (_, index) => keyframe(index)).join('') + '<p>x</p>')).toBe('css_rejected.css_too_many_keyframes');
  });

  it('is deterministic for malformed HTML', () => {
    const source = '<section><p>one<div>two</section><style>.x{color:red}';
    expect(sanitize(source)).toEqual(sanitize(source));
    expect(sanitize(source).ok).toBe(true);
  });

  it('accepts the exact node cap and rejects cap plus one', () => {
    // Pure text-node trees have zero body elements; the structural gate (#27)
    // would reject them first. Use one element + (maxNodes-2) text children so
    // countParsedTree hits the exact cap with a structural body.
    const exactCapDoc: DefaultTreeAdapterTypes.Document = {
      nodeName: '#document',
      mode: 'no-quirks',
      childNodes: [
        {
          nodeName: 'p',
          tagName: 'p',
          namespaceURI: 'http://www.w3.org/1999/xhtml',
          attrs: [],
          childNodes: Array.from({ length: HTML_SANITIZER_LIMITS.maxNodes - 2 }, () => ({
            nodeName: '#text',
            value: 'x',
            parentNode: null,
          })),
          parentNode: null,
        },
      ],
    } as DefaultTreeAdapterTypes.Document;
    expect(sanitizeHtmlExport({ html: '', parse: injectedParse(exactCapDoc), isAllowedAssetId: () => false }).ok).toBe(true);
    expect(failureCodeWithParse(documentWithTextNodes(HTML_SANITIZER_LIMITS.maxNodes))).toBe('html_cap');
  });

  it('accepts the exact depth cap and rejects cap plus one', () => {
    expect(sanitizeHtmlExport({ html: '', parse: injectedParse(documentWithDepth(HTML_SANITIZER_LIMITS.maxDepth)), isAllowedAssetId: () => false }).ok).toBe(true);
    expect(failureCodeWithParse(documentWithDepth(HTML_SANITIZER_LIMITS.maxDepth + 1))).toBe('html_cap');
  });

  it('accepts the exact per-element attribute cap and rejects cap plus one', () => {
    expect(sanitizeHtmlExport({
      html: '', parse: injectedParse(documentWithElements([HTML_SANITIZER_LIMITS.maxAttributesPerElement])),
      isAllowedAssetId: () => false,
    }).ok).toBe(true);
    expect(failureCodeWithParse(documentWithElements([HTML_SANITIZER_LIMITS.maxAttributesPerElement + 1]))).toBe('html_cap');
  });

  it('accepts the exact total attribute cap and rejects cap plus one', () => {
    const exact = Array.from({ length: HTML_SANITIZER_LIMITS.maxAttributes / HTML_SANITIZER_LIMITS.maxAttributesPerElement }, () => HTML_SANITIZER_LIMITS.maxAttributesPerElement);
    expect(sanitizeHtmlExport({ html: '', parse: injectedParse(documentWithElements(exact)), isAllowedAssetId: () => false }).ok).toBe(true);
    expect(failureCodeWithParse(documentWithElements([...exact, 1]))).toBe('html_cap');
  });
  it('reconstructs safe SVG primitives without SVG CSS markers and is idempotent', () => {
    const source = '<svg width="10" height="10" viewBox="0 0 10 10" role="img" aria-label="chart">' +
      '<!--comment--><title>Chart</title><desc>Static data</desc><defs><path id="p" d="M0 0L1 1"/></defs><g transform="translate(1 2)" fill="#AbC">' +
      '<path d="M0 0"/><rect x="0" y="0" width="1" height="1"/><circle cx="1" cy="1" r="1"/>' +
      '<ellipse cx="1" cy="1" rx="1" ry="1"/><line x1="0" y1="0" x2="1" y2="1"/>' +
      '<polyline points="0,0 1,1"/><polygon points="0,0 1,1"/><text id="label"> A<tspan> B</tspan></text>' +
      '<use href="#p"/><use href="#label"/></g></svg>';
    const first = sanitize(source);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.bodyHtml).toContain('<svg width="10" height="10" viewBox="0 0 10 10" role="img" aria-label="chart">');
    expect(first.bodyHtml).not.toContain('<!--');
    expect(first.bodyHtml).not.toContain('data-he-inline-style');
    expect(first.contentCss).toBe('@layer he-authored{}');
    expect(sanitize(source)).toEqual(first);
    const second = sanitize(first.bodyHtml);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.bodyHtml).toBe(first.bodyHtml);
  });
  it('accepts decorative SVG that only declares the default xmlns namespace', () => {
    // Models routinely emit xmlns="http://www.w3.org/2000/svg"; parse5 marks that
    // attribute as namespaced. Hard-failing it made every decorated export reject.
    const source =
      '<main><div aria-hidden="true"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M8 4h6l4 4v12a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" stroke="#6366f1" stroke-width="1.5"/>' +
      '</svg></div><h1>Title</h1></main>';
    const result = sanitize(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bodyHtml).toContain('<svg');
    expect(result.bodyHtml).toContain('<path');
    expect(result.bodyHtml).not.toContain('xmlns=');
  });
  it.each([
    ['mixed-case url function', 'UrL (https://e.test/x)', 'css_rejected.svg_attribute'],
    ['comment-obfuscated url function', 'u/**/r/**/l/**/(https://e.test/x)', 'css_rejected.svg_attribute'],
    ['escaped import at-keyword', '@\\69mport x', 'css_rejected.svg_attribute'],
    ['ordinary curl text', 'curl(', null],
    ['ordinary important text', '@important', null],
  ])('strips SVG CSS token surfaces while retaining the SVG: %s', (_name, label, code) => {
    const result = sanitize(`<svg aria-label="${label}"><path d="M0 0"/></svg>`);
    expect(result.ok).toBe(true);
    if (code !== null && result.ok) {
      expect(result.stripped).toContain(code);
      expect(result.bodyHtml).toContain('<svg');
      expect(result.bodyHtml).not.toContain(label);
    }
  });

  it('preserves SVG text while omitting formatting-only whitespace during document reconstruction', () => {
    const result = sanitize('<svg>\n  <text>&lt;&amp;<tspan> &gt; </tspan></text>\n</svg>');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bodyHtml).toBe('<svg><text>&lt;&amp;<tspan> &gt; </tspan></text></svg>');
  });
  it('does not preserve foreignObject text when an unsafe SVG is dropped wholesale', () => {
    const result = sanitize('<svg><foreignObject><text>Fallback label</text></foreignObject></svg>');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bodyHtml).not.toContain('Fallback label');
    expect(result.bodyHtml).not.toContain('<svg');
    expect(result.stripped).toContain('html_active_tag');
  });
  it('falls back to SVG text without leaking style or script source', () => {
    const styled = sanitize('<svg><style>path{fill:red}</style><text>Chart</text></svg>');
    expect(styled.ok).toBe(true);
    if (styled.ok) {
      expect(styled.bodyHtml).toContain('Chart');
      expect(styled.bodyHtml).not.toContain('path{fill:red}');
    }

    const scripted = sanitize('<svg><script>alert(1)</script></svg>');
    expect(scripted.ok).toBe(true);
    if (scripted.ok) expect(scripted.bodyHtml).not.toContain('alert(1)');
  });

  it.each([
    ['script', '<svg><script>alert(1)</script></svg>', 'html_active_tag'],
    ['foreignObject', '<svg><foreignObject><p>x</p></foreignObject></svg>', 'html_active_tag'],
    ['event handler', '<svg><path d="M0 0" onload="x"/></svg>', 'html_event_handler'],
    ['javascript href', '<svg><use href="javascript:alert(1)"/></svg>', 'html_url'],
    ['external href', '<svg><use href="https://e.test/x"/></svg>', 'html_url'],
    ['external xlink href', '<svg><use xlink:href="https://e.test/x"/></svg>', 'html_reserved_namespace'],
    ['fragment xlink href regression', '<svg><use xlink:href="#p"/></svg>', 'html_reserved_namespace'],
    ['network image', '<svg><image href="https://e.test/x"/></svg>', 'html_active_tag'],
    ['asset image', '<svg><image href="asset:abcdefghijklmnop"/></svg>', 'html_active_tag'],
    ['style element', '<svg><style>path{fill:red}</style></svg>', 'html_active_tag'],
    ['style attribute', '<svg><path d="M0 0" style="fill:red"/></svg>', 'css_rejected.svg_attribute'],
    ['animate', '<svg><animate attributeName="x" values="0;1"/></svg>', 'html_active_tag'],
    ['set', '<svg><set attributeName="fill" to="red"/></svg>', 'html_active_tag'],
    ['foreign namespace element', '<svg><math><mi>x</mi></math></svg>', 'html_reserved_namespace'],
    ['CSS url', '<svg><path d="M0 0" fill="url(https://e.test/x)"/></svg>', 'css_rejected.svg_attribute'],
    ['obfuscated CSS url', '<svg><path d="M0 0" fill="u/**/rl (https://e.test/x)"/></svg>', 'css_rejected.svg_attribute'],
    ['line-continuation CSS url', '<svg><path d="M0 0" fill="u\\\nrl(https://e.test/x)"/></svg>', 'css_rejected.svg_attribute'],
    ['CSS import', '<svg><path d="M0 0" style="@import url(https://e.test/x)"/></svg>', 'css_rejected.svg_attribute'],
    ['escaped CSS import', '<svg><path d="M0 0" style="@\\69mport url(https://e.test/x)"/></svg>', 'css_rejected.svg_attribute'],
  ])('rejects frozen SVG vector: %s', (_name, html, code) => {
    expect(failureCode(html)).toBe(code);
  });

  it.each([
    ['unknown filter', '<svg><filter><path d="M0 0"/></filter></svg>'],
    ['unknown link', '<svg><a><path d="M0 0"/></a></svg>'],
    ['nested svg', '<svg><svg><path d="M0 0"/></svg></svg>'],
    ['defs under group', '<svg><g><defs><path d="M0 0"/></defs></g></svg>'],
    ['geometry child', '<svg><path d="M0 0"><path d="M0 0"/></path></svg>'],
    ['stray container text', '<svg>text<path d="M0 0"/></svg>'],
    ['unknown attribute', '<svg><path d="M0 0" data-x="x"/></svg>'],
    ['class attribute', '<svg><path d="M0 0" class="x"/></svg>'],
    ['dangling use', '<svg><use href="#missing"/></svg>'],
    ['container use target', '<svg><g id="g"><path d="M0 0"/></g><use href="#g"/></svg>'],
    ['cross-root use target', '<svg><use href="#p"/></svg><svg><path id="p" d="M0 0"/></svg>'],
    ['duplicate document ID use target', '<p id="p">x</p><svg><path id="p" d="M0 0"/><use href="#p"/></svg>'],
  ])('rejects SVG structural failure: %s', (_name, html) => {
    expect(failureCode(html)).toBe('html_svg_rejected');
  });

  it('rejects forged SVG attribute namespaces before generic attribute handling', () => {
    const document = documentWithElement('svg') as unknown as {
      childNodes: Array<Record<string, unknown>>;
    };
    document.childNodes[0].namespaceURI = 'http://www.w3.org/2000/svg';
    document.childNodes[0].attrs = [{ name: 'href', value: '#p', prefix: 'xlink', namespace: 'http://www.w3.org/1999/xlink' }];
    expect(failureCodeWithParse(document)).toBe('html_reserved_namespace');
  });
});
describe('sanitizeHtmlExport — fail-closed structural gate (issue #27)', () => {
  const structural = { requireStructuralDocument: true } as const;

  it('rejects a model narration / prose response as non-structural (never finalizes)', () => {
    // The captured Grok failure: work commentary + a markdown-ish table + a temp path,
    // no HTML. parse5 wraps it as a body of text nodes with zero elements.
    const narration = [
      'Creating a landscape slide-deck for your document.',
      '',
      '| Section | Status |',
      '| --- | --- |',
      '| Intro | done |',
      '',
      'Saved the full 52KB document to the OS temp directory.',
    ].join('\n');
    const result = sanitize(narration, structural);
    expect(result.ok).toBe(false);
    expect(failureCode(narration, structural)).toBe(HTML_VIOLATION_CODES.noStructure);
    // Without the pipeline flag the sanitizer remains a pure filter.
    expect(sanitize(narration).ok).toBe(true);
  });

  it('rejects a document whose body falls below the element-node floor', () => {
    // Empty body / pure whitespace — zero elements after sanitize.
    expect(failureCode('<!doctype html><html><body>   \n  </body></html>', structural)).toBe(
      HTML_VIOLATION_CODES.noStructure,
    );
    // A single structural element is the floor and is accepted.
    expect(sanitize('<!doctype html><html><body><p>one block</p></body></html>', structural).ok).toBe(true);
  });

  it('accepts a structural HTML document at or above the element-node floor', () => {
    const doc = '<!doctype html><html><body><section><h1>Title</h1><p>Body copy.</p></section></body></html>';
    const result = sanitize(doc, structural);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bodyHtml).toContain('<h1>Title</h1>');
  });

  it('strips mixed narration from an otherwise-valid structural document', () => {
    const withPreamble =
      'Sure, here is the document:\n\n<section><h1>Title</h1><p>Body copy.</p></section>\nDone.';
    const result = sanitize(withPreamble, structural);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bodyHtml).not.toContain('Sure, here is the document');
    expect(result.bodyHtml).toContain('<h1>Title</h1>');
    expect(result.stripped.filter((code) => code === HTML_VIOLATION_CODES.topLevelNarration)).toHaveLength(1);
  });
  it.each([
    '<!doctype html><html>Intro <section><p>Body copy.</p></section></html>',
    '<html><body>Intro <section><p>Body copy.</p></section></body></html>',
  ])('preserves body text when the extractor sliced a complete document: %s', (document) => {
    const result = sanitize(document, { ...structural, extractedDocument: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bodyHtml).toContain('Intro <section>');
    expect(result.stripped).not.toContain(HTML_VIOLATION_CODES.topLevelNarration);
  });
  it('uses the extractor verdict instead of rescanning marker-like prose', () => {
    const result = sanitize('No full <html> needed: <section>x</section> Done', structural);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bodyHtml).toBe('<section>x</section>');
    expect(result.stripped).toContain(HTML_VIOLATION_CODES.topLevelNarration);
  });
  it('strips and records leading and trailing narration around fragment structural content', () => {
    const result = sanitize('Here is it: <section>x</section> Done.', structural);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bodyHtml).not.toContain('Here is it:');
    expect(result.bodyHtml).not.toContain('Done.');
    expect(result.bodyHtml).toContain('<section>x</section>');
    expect(result.stripped).toContain(HTML_VIOLATION_CODES.topLevelNarration);
  });
  it('strips narration around a fragment with a marker-like quoted attribute', () => {
    const result = sanitize('Here: <section title="<html>"><p>x</p></section> Done', structural);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bodyHtml).toContain('<section title="<html>"><p>x</p></section>');
    expect(result.bodyHtml).not.toContain('Here:');
    expect(result.bodyHtml).not.toContain('Done');
    expect(result.stripped).toContain(HTML_VIOLATION_CODES.topLevelNarration);
  });
  it('strips and records interior narration between fragment structural elements', () => {
    const result = sanitize('Intro <section>a</section> Here is the second: <section>b</section> Done', structural);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bodyHtml).toContain('<section>a</section>');
    expect(result.bodyHtml).toContain('<section>b</section>');
    expect(result.bodyHtml).not.toContain('Intro');
    expect(result.bodyHtml).not.toContain('Here is the second:');
    expect(result.bodyHtml).not.toContain('Done');
    expect(result.stripped.filter((code) => code === HTML_VIOLATION_CODES.topLevelNarration)).toHaveLength(1);
  });

  it('accepts whitespace-only text between top-level structural elements', () => {
    const doc =
      '<!doctype html><html><body>\n  <h1>Title</h1>\n  <p>Body copy.</p>\n</body></html>';
    const result = sanitize(doc, structural);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bodyHtml).toContain('<h1>Title</h1>');
      expect(result.bodyHtml).toContain('<p>Body copy.</p>');
    }
  });
  it('strips NBSP top-level narration when structural content remains', () => {
    const result = sanitize('\u00A0<section><p>x</p></section>', structural);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bodyHtml).not.toContain('\u00A0');
    expect(result.stripped).toContain(HTML_VIOLATION_CODES.topLevelNarration);
  });

  it('accepts normal spaces/newlines between top-level structural elements', () => {
    const doc = '<section><p>a</p></section>\n  <aside><p>b</p></aside>';
    const result = sanitize(doc, structural);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bodyHtml).toContain('<section>');
      expect(result.bodyHtml).toContain('<aside>');
    }
  });

  it('preserves main and aside semantic containers with class/id intact', () => {
    const result = sanitize(
      '<main class="container"><p>Primary</p></main><aside id="notes"><p>Side</p></aside>',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bodyHtml).toContain('<main class="container">');
    expect(result.bodyHtml).toContain('<aside id="notes">');
    expect(result.bodyHtml).toContain('<p>Primary</p>');
    expect(result.bodyHtml).toContain('<p>Side</p>');
  });
  it('surfaces safe body/html class and id on the content-root identity fields', () => {
    const result = sanitize(
      '<!doctype html><html class="theme"><body class="dark" id="app"><p class="card">x</p></body></html>',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Body children still unwrap; root attrs are not left on the body output.
    expect(result.bodyHtml).toBe('<p class="card">x</p>');
    // html+body classes merge; body id wins.
    expect(result.contentRootClass).toBe('theme dark');
    expect(result.contentRootId).toBe('app');
  });

  it('does not transfer a reserved body class onto contentRootClass', () => {
    // Shared class/id gate rejects reserved tokens fail-closed (same path as
    // sanitizeAttributes), so the document never succeeds with a reserved root class.
    expect(failureCode('<body class="he-shell"><p>x</p></body>')).toBe(
      HTML_VIOLATION_CODES.reservedNamespace,
    );
    // A safe body class alone still surfaces; reserved sibling tokens cannot slip through.
    const safe = sanitize('<body class="dark"><p>x</p></body>');
    expect(safe.ok).toBe(true);
    if (!safe.ok) return;
    expect(safe.contentRootClass).toBe('dark');
    expect(safe.contentRootId).toBeUndefined();
  });

  it('omits content-root identity fields when html/body carry no safe class or id', () => {
    const result = sanitize('<p>plain</p>');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contentRootClass).toBeUndefined();
    expect(result.contentRootId).toBeUndefined();
  });
  it('transfers safe body/html inline styles onto [data-he-content] rules in contentCss', () => {
    const result = sanitize(
      '<!doctype html><html style="font-size:16px"><body style="background:#111;color:#eee"><p>x</p></body></html>',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Wrapper itself stays free of a raw style="" attribute (shell adds only class/id).
    expect(result.bodyHtml).toBe('<p>x</p>');
    // html first, body second so body wins by cascade order.
    expect(result.contentCss).toContain('[data-he-content]{font-size:16px}');
    expect(result.contentCss).toContain('[data-he-content]{background:#111;color:#eee}');
    const htmlIdx = result.contentCss.indexOf('[data-he-content]{font-size:16px}');
    const bodyIdx = result.contentCss.indexOf('[data-he-content]{background:#111;color:#eee}');
    expect(htmlIdx).toBeGreaterThanOrEqual(0);
    expect(bodyIdx).toBeGreaterThan(htmlIdx);
  });

  it('strips unsafe root inline styles via the shared declaration sanitizer', () => {
    const network = sanitize('<body style="background:url(https://evil.test/x.png)"><p>x</p></body>');
    expect(network.ok).toBe(true);
    if (network.ok) {
      expect(network.stripped).toContain('css_rejected.css_network_function_not_allowed');
      expect(network.contentCss).not.toContain('evil.test');
    }
    const custom = sanitize('<html style="color:var(--accent)"><body><p>x</p></body></html>');
    expect(custom.ok).toBe(true);
  });

  it('emits no content-root style rule when html/body have no style attribute', () => {
    const result = sanitize('<body class="dark"><p>x</p></body>');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contentCss).not.toContain('[data-he-content]{');
    // Identity transfer still works; only style rules are absent.
    expect(result.contentRootClass).toBe('dark');
  });
  it('surfaces safe html/body lang/dir/title/role on contentRootAttrs', () => {
    const result = sanitize(
      '<!doctype html><html lang="ko"><body dir="rtl" role="main" title="Doc"><p>x</p></body></html>',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bodyHtml).toBe('<p>x</p>');
    expect(result.contentRootAttrs).toEqual({
      lang: 'ko',
      dir: 'rtl',
      title: 'Doc',
      role: 'main',
    });
  });

  it('does not transfer disallowed or non-inert root attributes onto contentRootAttrs', () => {
    // data-*/element-specific attrs are not in the inert root allowlist; body
    // still sanitizes (survives=false skips isAllowedAttribute for html/body).
    const result = sanitize(
      '<!doctype html><html lang="en" data-evil="x" colspan="2"><body dir="ltr" alt="n" width="1" data-section-id="s1"><p>x</p></body></html>',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contentRootAttrs).toEqual({ lang: 'en', dir: 'ltr' });
    expect(result.contentRootAttrs).not.toHaveProperty('data-evil');
    expect(result.contentRootAttrs).not.toHaveProperty('data-section-id');
    expect(result.contentRootAttrs).not.toHaveProperty('colspan');
    expect(result.contentRootAttrs).not.toHaveProperty('alt');
    expect(result.contentRootAttrs).not.toHaveProperty('width');
    expect(result.contentRootAttrs).not.toHaveProperty('style');
  });

  it('body inert root attrs win over html on conflict', () => {
    const result = sanitize(
      '<!doctype html><html lang="en" dir="ltr" title="Html" role="document"><body lang="ko" dir="rtl" title="Body" role="main"><p>x</p></body></html>',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contentRootAttrs).toEqual({
      lang: 'ko',
      dir: 'rtl',
      title: 'Body',
      role: 'main',
    });
  });

  it('omits contentRootAttrs when html/body carry no safe inert root attributes', () => {
    const result = sanitize('<p>plain</p>');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contentRootAttrs).toBeUndefined();
  });
});
