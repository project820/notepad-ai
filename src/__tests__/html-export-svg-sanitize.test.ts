import { parse, serializeOuter, type DefaultTreeAdapterTypes } from 'parse5';
import { describe, expect, it } from 'vitest';
import {
  SVG_ATTRIBUTE_MAX_BYTES,
  SVG_NAMESPACE,
  preflightSvgSubtrees,
  reconstructSvgRoot,
} from '../main/html-export-svg-sanitize';

function rootElement(document: DefaultTreeAdapterTypes.Document): DefaultTreeAdapterTypes.Element {
  const visit = (node: DefaultTreeAdapterTypes.Node): DefaultTreeAdapterTypes.Element | null => {
    const candidate = node as DefaultTreeAdapterTypes.Element;
    if (candidate.tagName === 'svg') return candidate;
    for (const child of (node as { childNodes?: DefaultTreeAdapterTypes.Node[] }).childNodes ?? []) {
      const found = visit(child);
      if (found) return found;
    }
    return null;
  };
  const root = visit(document);
  if (!root) throw new Error('test SVG root missing');
  return root;
}

function preflight(html: string) {
  const document = parse(html);
  return preflightSvgSubtrees(document, () => false);
}

describe('SVG preflight and reconstruction', () => {
  it('reconstructs constrained primitives, text, defs, and forward leaf use references', () => {
    const document = parse('<svg viewBox="0 0 10 10"><defs><path id="p" d="M0 0L1 1"/></defs><use href="#p"/><text id="label">A<tspan> B</tspan></text><use href="#label"/></svg>');
    const result = preflightSvgSubtrees(document, () => false);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const root = rootElement(document);
    const plan = result.plans.get(root);
    expect(plan).toBeDefined();
    expect(serializeOuter(reconstructSvgRoot(plan!, null))).toBe('<svg viewBox="0 0 10 10"><defs><path id="p" d="M0 0L1 1"></path></defs><use href="#p"></use><text id="label">A<tspan> B</tspan></text><use href="#label"></use></svg>');
  });

  it.each([
    ['minimal fragment', '<svg><path id="a" d="M0 0"/><use href="#a"/></svg>', true],
    ['64-character fragment', `<svg><path id="a${'b'.repeat(63)}" d="M0 0"/><use href="#a${'b'.repeat(63)}"/></svg>`, true],
    ['65-character fragment', `<svg><path id="a${'b'.repeat(64)}" d="M0 0"/><use href="#a${'b'.repeat(64)}"/></svg>`, false],
    ['encoded fragment', '<svg><path id="a" d="M0 0"/><use href="#a%20"/></svg>', false],
    ['slash fragment', '<svg><path id="a" d="M0 0"/><use href="#a/x"/></svg>', false],
    ['empty fragment', '<svg><use href="#"/></svg>', false],
    ['numeric boundary', '<svg width="1000000" height=".5" viewBox="0 0 1 1"><path d="M0 0"/></svg>', true],
    ['numeric overflow', '<svg width="1000001"><path d="M0 0"/></svg>', false],
    ['numeric exponent', '<svg width="1e2"><path d="M0 0"/></svg>', false],
    ['numeric unit', '<svg width="1px"><path d="M0 0"/></svg>', false],
    ['valid path arc', '<svg><path d="M0 0 A1 1 0 0 1 2 2"/></svg>', true],
    ['invalid path arc flag', '<svg><path d="M0 0 A1 1 0 2 1 2 2"/></svg>', false],
    ['invalid path initial command', '<svg><path d="L0 0"/></svg>', false],
    ['valid transform', '<svg><path d="M0 0" transform="translate(1,2) rotate(3 4 5)"/></svg>', true],
    ['invalid transform arity', '<svg><path d="M0 0" transform="matrix(1 2)"/></svg>', false],
  ])('enforces %s', (_name, html, accepted) => {
    expect(preflight(html).ok).toBe(accepted);
  });
  it('enforces SVG token limits while allowing the exact maximum', () => {
    const dasharray = Array.from({ length: 32 }, () => '0').join(' ');
    const points = Array.from({ length: 4096 }, () => '0').join(' ');
    const path = `M0 0${'Z'.repeat(4093)}`;
    const transform = Array.from({ length: 32 }, () => 'translate(1)').join(' ');

    expect(preflight(`<svg viewBox="0 0 1 1"><path d="M0 0" stroke-dasharray="${dasharray}"/><polygon points="${points}"/><path d="${path}" transform="${transform}"/></svg>`).ok).toBe(true);
    expect(preflight('<svg viewBox="0 0 1 1 2"><path d="M0 0"/></svg>').ok).toBe(false);
    expect(preflight(`<svg><path d="M0 0" stroke-dasharray="${dasharray} 0"/></svg>`).ok).toBe(false);
    expect(preflight(`<svg><polygon points="${points} 0"/></svg>`).ok).toBe(false);
    expect(preflight(`<svg><path d="${path}Z"/></svg>`).ok).toBe(false);
    expect(preflight(`<svg><path d="M0 0" transform="${transform} translate(1)"/></svg>`).ok).toBe(false);
  });

  it('rejects over-cap SVG attributes before token parsing while retaining CSS scans for every attribute', () => {
    const overCap = 'é'.repeat((SVG_ATTRIBUTE_MAX_BYTES / 2) + 1);
    const capped = preflight(`<svg><path d="M0 0" fill="${overCap}"/></svg>`);
    expect(capped).toMatchObject({
      ok: false,
      violation: { code: 'html_svg_rejected' },
    });
    if (!capped.ok) expect(capped.violation.detail).toContain(`exceeds ${SVG_ATTRIBUTE_MAX_BYTES} bytes`);
    expect(preflight('<svg><path d="M0 0" data-ignored="u/**/rl(https://e.test/x)"/></svg>')).toMatchObject({
      ok: false,
      violation: { code: 'css_rejected.svg_attribute' },
    });
  });
  it.each([
    ['normal url function', 'url(https://e.test/x)', true],
    ['mixed-case url function', 'UrL (https://e.test/x)', true],
    ['comment-obfuscated url function', 'u/**/r/**/l/**/ (https://e.test/x)', true],
    ['later url function after comment-collapsed identifier', 'x/**/url(https://e.test/x)', true],
    ['later url function after multiple comments', 'x/**//**/url(https://e.test/x)', true],
    ['escaped url function', '\\75\\72\\6c(https://e.test/x)', true],
    ['line-continuation url function', 'u\\\nrl(https://e.test/x)', true],
    ['mixed-case import at-keyword', '@ImPoRt x', true],
    ['comment-obfuscated import at-keyword', '@i/**/mport x', true],
    ['later url function after comment-collapsed import', '@import/**/url(https://e.test/x)', true],
    ['escaped import at-keyword', '@\\69mport x', true],
    ['line-continuation import at-keyword', '@i\\\nmport x', true],
    ['trailing escape', 'trailing\\', false],
    ['curl accessibility text', 'curl(', false],
    ['urlish accessibility text', 'urlish(', false],
    ['plain url accessibility text', 'url documentation', false],
    ['important accessibility text', '@important', false],
    ['quoted accessibility text', "'url('", false],
  ])('scans CSS tokens without rejecting ordinary accessibility text: %s', (_name, value, rejected) => {
    const result = preflight(`<svg aria-label="${value}"><path d="M0 0"/></svg>`);
    expect(result.ok).toBe(!rejected);
    if (rejected) expect(result).toMatchObject({ violation: { code: 'css_rejected.svg_attribute' } });
  });

  it.each([
    ['comma after command', '<svg><path d="M,0 0"/></svg>'],
    ['comma before command', '<svg><path d="M0 0,L1 1"/></svg>'],
    ['trailing transform comma', '<svg><path d="M0 0" transform="translate(1),"/></svg>'],
  ])('rejects malformed separator state: %s', (_name, html) => {
    expect(preflight(html)).toMatchObject({ ok: false, violation: { code: 'html_svg_rejected' } });
  });
  it.each([
    ['symbol', '<svg><symbol><path d="M0 0"/></symbol></svg>', false],
    ['marker', '<svg><marker><path d="M0 0"/></marker></svg>', false],
    ['pattern', '<svg><pattern><path d="M0 0"/></pattern></svg>', false],
    ['linearGradient', '<svg><linearGradient><stop/></linearGradient></svg>', false],
    ['radialGradient', '<svg><radialGradient><stop/></radialGradient></svg>', false],
    ['stop', '<svg><stop/></svg>', false],
    ['clipPath', '<svg><clipPath><path d="M0 0"/></clipPath></svg>', false],
    ['mask', '<svg><mask><path d="M0 0"/></mask></svg>', false],
    ['filter', '<svg><filter><path d="M0 0"/></filter></svg>', false],
    ['fe primitive', '<svg><feGaussianBlur/></svg>', false],
    ['tabindex', '<svg tabindex="0"><path d="M0 0"/></svg>', false],
    ['focusable', '<svg focusable="true"><path d="M0 0"/></svg>', false],
    ['xmlns', '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>', true],
    ['xml attribute', '<svg xml:lang="en"><path d="M0 0"/></svg>', false],
    ['missing use href', '<svg><use/></svg>', false],
    ['use as target', '<svg><path id="p" d="M0 0"/><use id="u" href="#p"/><use href="#u"/></svg>', false],
    ['same-root unique text use target', '<svg><text id="label">A<tspan> B</tspan></text><use href="#label"/></svg>', true],
    ['text tspan child', '<svg><text>A<tspan>B</tspan></text></svg>', true],
    ['tspan outside text', '<svg><tspan>A</tspan></svg>', false],
  ])('enforces frozen SVG structural rows: %s', (_name, html, accepted) => {
    expect(preflight(html).ok).toBe(accepted);
  });

  it('rejects injected mixed-case event attributes, malformed namespaces, and unexpected child node kinds', () => {
    const eventDocument = parse('<svg><path d="M0 0"/></svg>');
    const eventPath = rootElement(eventDocument).childNodes[0] as DefaultTreeAdapterTypes.Element;
    eventPath.attrs.push({ name: 'onBegin', value: 'x' });
    expect(preflightSvgSubtrees(eventDocument, () => false)).toMatchObject({
      ok: false,
      violation: { code: 'html_event_handler' },
    });

    for (const attribute of [
      { name: 'x', value: 'x', prefix: 'xml' },
      { name: 'x', value: 'x', namespace: 'urn:unexpected' },
    ]) {
      const document = parse('<svg><path d="M0 0"/></svg>');
      (rootElement(document).childNodes[0] as DefaultTreeAdapterTypes.Element).attrs.push(attribute);
      expect(preflightSvgSubtrees(document, () => false)).toMatchObject({
        ok: false,
        violation: { code: 'html_reserved_namespace' },
      });
    }

    const unexpectedNodeDocument = parse('<svg><path d="M0 0"/></svg>');
    rootElement(unexpectedNodeDocument).childNodes.push({ nodeName: '#document-fragment', childNodes: [] } as DefaultTreeAdapterTypes.ChildNode);
    expect(preflightSvgSubtrees(unexpectedNodeDocument, () => false)).toMatchObject({
      ok: false,
      violation: { code: 'html_svg_rejected' },
    });
  });

  it('drops formatting-only SVG whitespace while preserving and escaping text content', () => {
    const document = parse('<svg>\n  <text>&lt;&amp;<tspan> &gt; </tspan></text>\n</svg>');
    const result = preflightSvgSubtrees(document, () => false);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(serializeOuter(reconstructSvgRoot(result.plans.get(rootElement(document))!, null)))
      .toBe('<svg><text>&lt;&amp;<tspan> &gt; </tspan></text></svg>');
  });

  it('rejects duplicate document IDs, injected duplicate hrefs, and namespaced SVG attributes', () => {
    expect(preflight('<p id="p"></p><svg><path id="p" d="M0 0"/><use href="#p"/></svg>')).toMatchObject({
      ok: false,
      violation: { code: 'html_svg_rejected' },
    });

    const duplicateHref = parse('<svg><path id="p" d="M0 0"/><use href="#p"/></svg>');
    const duplicateUse = rootElement(duplicateHref).childNodes[1] as DefaultTreeAdapterTypes.Element;
    duplicateUse.attrs.push({ name: 'href', value: '#p' });
    expect(preflightSvgSubtrees(duplicateHref, () => false)).toMatchObject({
      ok: false,
      violation: { code: 'html_svg_rejected' },
    });

    const namespacedAttribute = parse('<svg><path d="M0 0"/></svg>');
    const namespacedPath = rootElement(namespacedAttribute).childNodes[0] as DefaultTreeAdapterTypes.Element;
    namespacedPath.attrs.push({
      name: 'href', value: '#p', prefix: 'xlink', namespace: 'http://www.w3.org/1999/xlink',
    });
    expect(preflightSvgSubtrees(namespacedAttribute, () => false)).toMatchObject({
      ok: false,
      violation: { code: 'html_reserved_namespace' },
    });
  });

  it('rejects wrong SVG root and child namespaces from injected parse trees', () => {
    const root = rootElement(parse('<svg><path d="M0 0"/></svg>'));
    root.namespaceURI = 'http://www.w3.org/1999/xhtml';
    expect(preflightSvgSubtrees({ nodeName: '#document', mode: 'no-quirks', childNodes: [root] } as DefaultTreeAdapterTypes.Document, () => false)).toMatchObject({
      ok: false,
      violation: { code: 'html_reserved_namespace' },
    });

    const foreignRoot = rootElement(parse('<svg><path d="M0 0"/></svg>'));
    foreignRoot.namespaceURI = SVG_NAMESPACE;
    (foreignRoot.childNodes[0] as DefaultTreeAdapterTypes.Element).namespaceURI = 'http://www.w3.org/1998/Math/MathML';
    expect(preflightSvgSubtrees({ nodeName: '#document', mode: 'no-quirks', childNodes: [foreignRoot] } as DefaultTreeAdapterTypes.Document, () => false)).toMatchObject({
      ok: false,
      violation: { code: 'html_reserved_namespace' },
    });
  });
  it('exports the exact SVG attribute byte cap', () => {
    expect(SVG_ATTRIBUTE_MAX_BYTES).toBe(128 * 1024);
  });
});
