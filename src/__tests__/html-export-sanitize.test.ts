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

function sanitize(html: string) {
  return sanitizeHtmlExport({ html });
}

function failureCode(html: string): string {
  const result = sanitize(html);
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
      '<style>@keyframes spin{from{opacity:0}to{opacity:1}}</style>',
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
    const withinRuleCap = Array.from({ length: CSS_MAX_RULES }, (_, index) => `<style>.r${index}{color:red}</style>`).join('');
    expect(sanitize(withinRuleCap).ok).toBe(true);
    const pastRuleCap = `${withinRuleCap}<style>.overflow{color:red}</style>`;
    expect(failureCode(pastRuleCap)).toBe('css_rejected');

    const keyframe = (index: number) => `<style>@keyframes k${index}{from{opacity:0}to{opacity:1}}</style>`;
    expect(sanitize(Array.from({ length: CSS_MAX_KEYFRAMES }, (_, index) => keyframe(index)).join('')).ok).toBe(true);
    expect(failureCode(Array.from({ length: CSS_MAX_KEYFRAMES + 1 }, (_, index) => keyframe(index)).join(''))).toBe('css_rejected');
  });

  it('is deterministic for malformed HTML', () => {
    const source = '<section><p>one<div>two</section><style>.x{color:red}';
    expect(sanitize(source)).toEqual(sanitize(source));
    expect(sanitize(source).ok).toBe(true);
  });

  it('accepts the exact node cap and rejects cap plus one', () => {
    expect(sanitizeHtmlExport({ html: '', parse: injectedParse(documentWithTextNodes(HTML_SANITIZER_LIMITS.maxNodes - 1)) }).ok).toBe(true);
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
});
