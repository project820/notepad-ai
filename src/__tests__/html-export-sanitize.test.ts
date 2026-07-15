import { type DefaultTreeAdapterTypes } from 'parse5';
import { describe, expect, it } from 'vitest';
import {
  CSS_MAX_KEYFRAMES,
  CSS_MAX_RULES,
  CSS_MAX_STYLESHEET_BYTES,
} from '../main/html-export-css-sanitize';
import {
  HTML_SANITIZER_LIMITS,
  HTML_VIOLATION_CODES,
  sanitizeHtmlExport,
  type HtmlExportParse,
} from '../main/html-export-sanitize';

function sanitize(html: string, opts: { requireStructuralDocument?: boolean } = {}) {
  return sanitizeHtmlExport({ html, ...opts });
}

function failureCode(html: string, opts: { requireStructuralDocument?: boolean } = {}): string {
  const result = sanitize(html, opts);
  expect(result.ok).toBe(false);
  return result.ok ? '' : result.violations[0].code;
}

function injectedParse(document: unknown): HtmlExportParse {
  return (() => document as DefaultTreeAdapterTypes.Document) as HtmlExportParse;
}

function failureCodeWithParse(document: unknown): string {
  const result = sanitizeHtmlExport({ html: '', parse: injectedParse(document) });
  expect(result.ok).toBe(false);
  return result.ok ? '' : result.violations[0].code;
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
    expect(HTML_VIOLATION_CODES.cssRejected).toBe('css_rejected');
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

  it.each([
    'iframe', 'object', 'embed', 'base', 'frame', 'frameset', 'applet', 'script', 'link', 'template',
    'slot', 'form', 'input', 'button',
  ])('rejects active tag <%s>', (tag) => {
    expect(failureCodeWithParse(documentWithElement(tag))).toBe('html_active_tag');
  });

  it('rejects meta http-equiv as an active redirect surface', () => {
    expect(failureCodeWithParse(documentWithElement('meta', [{ name: 'http-equiv', value: 'refresh' }]))).toBe('html_active_tag');
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
    expect(failureCode(html)).toBe(code);
  });

  it('rejects event handlers and app shell/runtime namespace preseed', () => {
    expect(failureCode('<p onclick="x">x</p>')).toBe('html_event_handler');
    expect(failureCode('<p data-he-layout="slides">x</p>')).toBe('html_reserved_namespace');
    expect(failureCode('<p class="he-shell">x</p>')).toBe('html_reserved_namespace');
    expect(failureCode('<p id="runtime-root">x</p>')).toBe('html_reserved_namespace');
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
  ])('enforces opaque asset grammar: %s', (_name, src, accepted) => {
    const result = sanitize(`<img src="${src}">`);
    expect(result.ok).toBe(accepted);
    if (!accepted && !result.ok) expect(result.violations[0].code).toBe('html_asset_id');
  });

  it('accepts fragment-only links and source asset IDs', () => {
    const result = sanitize('<a href="#details">Details</a><picture><source src="asset:abcdefghijklmnop"></picture>');
    expect(result.ok).toBe(true);
  });
  it('uses the injected validator only for opaque asset membership', () => {
    const allowed = sanitizeHtmlExport({
      html: '<img src="asset:abcdefghijklmnop">',
      isAllowedAssetId: (src) => src === 'asset:abcdefghijklmnop',
    });
    const denied = sanitizeHtmlExport({
      html: '<img src="asset:abcdefghijklmnop">',
      isAllowedAssetId: () => false,
    });
    expect(allowed.ok).toBe(true);
    expect(denied.ok).toBe(false);
  });

  it.each([
    'https://example.test/x',
    '//example.test/x',
    'images/x.png',
    'data:image/png;base64,AAAA',
    'asset:abcdefghijklmnop?q=x',
    'asset:abcdefghijklmnop#x',
    'asset:abcdefghijklm%20',
  ])('does not let a permissive asset validator authorize unsafe src %s', (src) => {
    const result = sanitizeHtmlExport({ html: `<img src="${src}">`, isAllowedAssetId: () => true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations[0].code).toBe('html_asset_id');
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

  it('propagates CSS sanitizer failures without serializing source style surfaces', () => {
    const stylesheet = sanitize('<style>.x{background:url(https://example.test/x)}</style><p>safe</p>');
    expect(stylesheet.ok).toBe(false);
    if (!stylesheet.ok) expect(stylesheet.violations[0].code).toBe('css_rejected');

    const inline = sanitize('<p style="color:var(--unsafe)">safe</p>');
    expect(inline.ok).toBe(false);
    if (!inline.ok) expect(inline.violations[0].code).toBe('css_rejected');
  });
  it('preflights oversized malformed CSS before stylesheet registration can parse it', () => {
    const result = sanitize(`<style>${'@'.repeat(CSS_MAX_STYLESHEET_BYTES + 1)}</style>`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0].code).toBe('css_rejected');
      expect(result.violations[0].detail).toContain('css_too_large');
    }
  });

  it('gives active and style-node attribute failures precedence over malformed nested CSS', () => {
    for (const [html, code] of [
      ['<template><style>@</style></template>', 'html_active_tag'],
      ['<script><style>@</style></script>', 'html_active_tag'],
      ['<style onclick="x">@</style>', 'html_event_handler'],
      ['<p onclick="x" style="@">x</p>', 'html_event_handler'],
      ['<style data-he-injected="x">@</style>', 'html_reserved_namespace'],
    ]) {
      expect(failureCode(html)).toBe(code);
    }
  });
  it.each([
    ['active ancestor', '<form><svg><path d="M,0 0"/></svg></form>', 'html_active_tag'],
    ['event ancestor', '<div onclick="x"><svg><path d="M,0 0"/></svg></div>', 'html_event_handler'],
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

  it('enforces CSS byte caps across multiple stylesheet and inline surfaces', () => {
    const exact = sanitize(
      `<style>${cssComment(CSS_MAX_STYLESHEET_BYTES - 8)}</style><style>/**/</style><p style="/**/">x</p>`,
    );
    expect(exact.ok).toBe(true);
    if (exact.ok) expect(exact.bodyHtml).not.toContain('data-he-inline-style');

    const past = sanitize(
      `<style>${cssComment(CSS_MAX_STYLESHEET_BYTES - 8)}</style><style>/**/</style><p style="/*x*/">x</p>`,
    );
    expect(past.ok).toBe(false);
    if (!past.ok) {
      expect(past.violations[0].code).toBe('css_rejected');
      expect(past.violations[0].detail).toContain('css_too_large');
    }
  });

  it('enforces CSS rule and keyframe caps across separate style blocks', () => {
    const withinRuleCap = Array.from({ length: CSS_MAX_RULES }, (_, index) => `<style>.r${index}{color:red}</style>`).join('') + '<p>x</p>';
    expect(sanitize(withinRuleCap).ok).toBe(true);
    const pastRuleCap = `${withinRuleCap}<style>.overflow{color:red}</style>`;
    expect(failureCode(pastRuleCap)).toBe('css_rejected');

    const keyframe = (index: number) => `<style>@keyframes k${index}{from{opacity:0}to{opacity:1}}</style>`;
    expect(sanitize(Array.from({ length: CSS_MAX_KEYFRAMES }, (_, index) => keyframe(index)).join('') + '<p>x</p>').ok).toBe(true);
    expect(failureCode(Array.from({ length: CSS_MAX_KEYFRAMES + 1 }, (_, index) => keyframe(index)).join('') + '<p>x</p>')).toBe('css_rejected');
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
    expect(sanitizeHtmlExport({ html: '', parse: injectedParse(exactCapDoc) }).ok).toBe(true);
    expect(failureCodeWithParse(documentWithTextNodes(HTML_SANITIZER_LIMITS.maxNodes))).toBe('html_cap');
  });

  it('accepts the exact depth cap and rejects cap plus one', () => {
    expect(sanitizeHtmlExport({ html: '', parse: injectedParse(documentWithDepth(HTML_SANITIZER_LIMITS.maxDepth)) }).ok).toBe(true);
    expect(failureCodeWithParse(documentWithDepth(HTML_SANITIZER_LIMITS.maxDepth + 1))).toBe('html_cap');
  });

  it('accepts the exact per-element attribute cap and rejects cap plus one', () => {
    expect(sanitizeHtmlExport({
      html: '', parse: injectedParse(documentWithElements([HTML_SANITIZER_LIMITS.maxAttributesPerElement])),
    }).ok).toBe(true);
    expect(failureCodeWithParse(documentWithElements([HTML_SANITIZER_LIMITS.maxAttributesPerElement + 1]))).toBe('html_cap');
  });

  it('accepts the exact total attribute cap and rejects cap plus one', () => {
    const exact = Array.from({ length: HTML_SANITIZER_LIMITS.maxAttributes / HTML_SANITIZER_LIMITS.maxAttributesPerElement }, () => HTML_SANITIZER_LIMITS.maxAttributesPerElement);
    expect(sanitizeHtmlExport({ html: '', parse: injectedParse(documentWithElements(exact)) }).ok).toBe(true);
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
  it.each([
    ['mixed-case url function', 'UrL (https://e.test/x)', 'css_rejected'],
    ['comment-obfuscated url function', 'u/**/r/**/l/**/(https://e.test/x)', 'css_rejected'],
    ['escaped import at-keyword', '@\\69mport x', 'css_rejected'],
    ['ordinary curl text', 'curl(', null],
    ['ordinary important text', '@important', null],
  ])('applies SVG CSS token boundaries through the HTML sanitizer: %s', (_name, label, code) => {
    const result = sanitize(`<svg aria-label="${label}"><path d="M0 0"/></svg>`);
    expect(result.ok).toBe(code === null);
    if (code !== null && !result.ok) expect(result.violations[0].code).toBe(code);
  });

  it('preserves SVG text while omitting formatting-only whitespace during document reconstruction', () => {
    const result = sanitize('<svg>\n  <text>&lt;&amp;<tspan> &gt; </tspan></text>\n</svg>');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bodyHtml).toBe('<svg><text>&lt;&amp;<tspan> &gt; </tspan></text></svg>');
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
    ['style attribute', '<svg><path d="M0 0" style="fill:red"/></svg>', 'css_rejected'],
    ['animate', '<svg><animate attributeName="x" values="0;1"/></svg>', 'html_active_tag'],
    ['set', '<svg><set attributeName="fill" to="red"/></svg>', 'html_active_tag'],
    ['foreign namespace element', '<svg><math><mi>x</mi></math></svg>', 'html_reserved_namespace'],
    ['CSS url', '<svg><path d="M0 0" fill="url(https://e.test/x)"/></svg>', 'css_rejected'],
    ['obfuscated CSS url', '<svg><path d="M0 0" fill="u/**/rl (https://e.test/x)"/></svg>', 'css_rejected'],
    ['line-continuation CSS url', '<svg><path d="M0 0" fill="u\\\nrl(https://e.test/x)"/></svg>', 'css_rejected'],
    ['CSS import', '<svg><path d="M0 0" style="@import url(https://e.test/x)"/></svg>', 'css_rejected'],
    ['escaped CSS import', '<svg><path d="M0 0" style="@\\69mport url(https://e.test/x)"/></svg>', 'css_rejected'],
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

  it('rejects mixed narration / code-fence siblings of otherwise-valid HTML', () => {
    // Provider responses that wrap valid HTML in a fence or chat preamble still
    // have bodyElementCount >= 1; top-level non-whitespace text must still fail closed.
    const fenced = ['```html', '<h1>Title</h1>', '<p>Body copy.</p>', '```'].join('\n');
    const withPreamble =
      'Sure, here is the document:\n\n<section><h1>Title</h1><p>Body copy.</p></section>';
    expect(failureCode(fenced, structural)).toBe(HTML_VIOLATION_CODES.noStructure);
    expect(failureCode(withPreamble, structural)).toBe(HTML_VIOLATION_CODES.noStructure);
    // Without the pipeline flag the sanitizer remains a pure filter.
    expect(sanitize(withPreamble).ok).toBe(true);
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
  it('rejects NBSP-only top-level text under HTML-ASCII whitespace rules', () => {
    // String.trim() strips U+00A0, so the old gate treated NBSP as whitespace.
    // HTML-ASCII whitespace is only U+0009/0A/0C/0D/20 — NBSP must fail closed.
    expect(failureCode('\u00A0<section><p>x</p></section>', structural)).toBe(
      HTML_VIOLATION_CODES.noStructure,
    );
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

  it('rejects unsafe root inline styles via the shared declaration sanitizer', () => {
    // Network function in a body style is hard-failed by sanitizeDeclarationList.
    expect(failureCode('<body style="background:url(https://evil.test/x.png)"><p>x</p></body>')).toBe(
      HTML_VIOLATION_CODES.cssRejected,
    );
    // Custom properties are also rejected on root styles (same path as element styles).
    expect(failureCode('<html style="color:var(--accent)"><body><p>x</p></body></html>')).toBe(
      HTML_VIOLATION_CODES.cssRejected,
    );
  });

  it('emits no content-root style rule when html/body have no style attribute', () => {
    const result = sanitize('<body class="dark"><p>x</p></body>');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contentCss).not.toContain('[data-he-content]{');
    // Identity transfer still works; only style rules are absent.
    expect(result.contentRootClass).toBe('dark');
  });
});
