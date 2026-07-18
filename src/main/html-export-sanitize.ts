import { parse, serialize, type DefaultTreeAdapterTypes } from 'parse5';
import {
  createCssSanitizeContext,
  registerCssKeyframes,
  sanitizeDeclarationList,
  sanitizeStylesheet,
  type CssSanitizeContext,
  type CssViolation,
  cssRejectedCode,
} from './html-export-css-sanitize';
import {
  preflightSvgSubtrees,
  reconstructSvgRoot,
  type SvgRootPlan,
  type SvgViolationCode,
} from './html-export-svg-sanitize';

/** Resource limits applied to the parsed, model-authored tree. */
export const HTML_SANITIZER_LIMITS = {
  maxNodes: 20_000,
  maxDepth: 64,
  maxAttributesPerElement: 256,
  maxAttributes: 8_192,
} as const;

/**
 * Minimum element-node count the sanitized body must contain to be accepted as a
 * structural HTML document. A prose/narration response (e.g. a model that answers
 * with work commentary instead of authoring HTML) parses to a body of text nodes
 * with zero elements; without this floor it would sanitize, finalize, and save as
 * a "successful" export (fail-open). Floor is 1 so a single intentional block
 * element is still accepted; pure text/narration (0 elements) is rejected.
 * Fail-closed: below the floor maps to a retryable pipeline-reject. See issue #27.
 */
const HTML_MIN_BODY_ELEMENT_NODES = 1;

export const HTML_VIOLATION_CODES = {
  parse: 'html_parse',
  activeTag: 'html_active_tag',
  reservedNamespace: 'html_reserved_namespace',
  eventHandler: 'html_event_handler',
  url: 'html_url',
  assetId: 'html_asset_id',
  attribute: 'html_attribute',
  svgRejected: 'html_svg_rejected',
  cap: 'html_cap',
  internal: 'html_internal',
  noStructure: 'html_no_structure',
  topLevelNarration: 'html_top_level_narration',
} as const;

type HtmlSanitizerViolationCode =
  | (typeof HTML_VIOLATION_CODES)[keyof typeof HTML_VIOLATION_CODES]
  | SvgViolationCode
  | ReturnType<typeof cssRejectedCode>;
type HtmlSanitizerViolation = { code: HtmlSanitizerViolationCode; detail: string };
type HtmlSanitizerCounts = { nodeCount: number; maxDepth: number; attributeCount: number };
export type HtmlExportParse = (html: string) => DefaultTreeAdapterTypes.Document;

type HtmlExportSanitizeSuccess = {
  ok: true;
  bodyHtml: string;
  documentHtml: string;
  contentCss: string;
  counts: HtmlSanitizerCounts;
  /** Safe class tokens from source <html>/<body>, for the shell content-root wrapper. */
  contentRootClass?: string;
  /** Safe id from source <body> (else <html>), for the shell content-root wrapper. */
  contentRootId?: string;
  /**
   * Safe inert root attributes (lang/dir/title/role) from source <html>/<body>
   * for the shell content-root wrapper. Body wins over html on conflict.
   */
  contentRootAttrs?: Record<string, string>;
  stripped: HtmlSanitizerViolationCode[];
};

type HtmlExportSanitizeFailure = {
  ok: false;
  violations: HtmlSanitizerViolation[];
};

export type HtmlExportSanitizeResult = HtmlExportSanitizeSuccess | HtmlExportSanitizeFailure;
export type HtmlExportSanitizeOptions = {
  html: string;
  parse?: HtmlExportParse;
  isAllowedAssetId: (src: string) => boolean;
  /**
   * True when the extractor found and sliced a balanced HTML document.
   * Marker-free fragments strip top-level narration.
   */
  extractedDocument?: boolean;
  /** Require the sanitized body to contain at least `HTML_MIN_BODY_ELEMENT_NODES` element nodes. */
  requireStructuralDocument?: boolean;
};

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;
type Attribute = Element['attrs'][number];
type SanitizedNode = Node;
type SanitizedAttributes = { attrs: Attribute[]; inlineCss: string | null };
type Context = {
  isAllowedAssetId: (src: string) => boolean;
  stylesheetRules: string[];
  inlineRules: string[];
  relocatedHeadScripts: SanitizedNode[];
  nextInlineStyle: number;
  cssContext: CssSanitizeContext;
  svgPlans: Map<Node, SvgRootPlan>;
  stripped: HtmlSanitizerViolation[];
};
type Failure = { violation: HtmlSanitizerViolation };

const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const ALLOWED_TAGS = new Set([
  'section', 'div', 'article', 'main', 'aside', 'header', 'footer', 'nav', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p',
  'span', 'strong', 'em', 'b', 'i', 'u', 's', 'small', 'mark', 'sub', 'sup', 'br', 'hr', 'ul', 'ol',
  'li', 'dl', 'dt', 'dd', 'blockquote', 'figure', 'figcaption', 'img', 'picture', 'source', 'svg',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'code', 'pre', 'kbd', 'samp',
  'abbr', 'time', 'a', 'script', 'form', 'input', 'button',
]);
const ACTIVE_TAGS = new Set([
  'iframe', 'object', 'embed', 'base', 'frame', 'frameset', 'applet', 'link', 'template', 'slot',
]);
const SVG_FALLBACK_TEXT_TAGS = new Set(['text', 'tspan', 'title', 'desc']);
const SVG_FALLBACK_SKIPPED_TAGS = new Set(['style', 'script', 'foreignobject']);
const ACTIVE_CONTENT_CONTAINERS = new Set(['button', 'form', 'slot', 'template']);
const GLOBAL_ATTRIBUTES = new Set(['class', 'id', 'title', 'lang', 'dir', 'role']);
/** Inert global attrs transferable onto the content-root (class/id handled separately). */
const SAFE_ROOT_ATTRIBUTE_NAMES = ['lang', 'dir', 'title', 'role'] as const;
const SAFE_ROOT_ATTRIBUTE_NAME_SET = new Set<string>(SAFE_ROOT_ATTRIBUTE_NAMES);
const TABLE_ATTRIBUTES = new Set(['colspan', 'rowspan', 'scope']);
const IMAGE_ATTRIBUTES = new Set(['alt', 'width', 'height']);
const RESERVED_CLASS_OR_ID = /^(?:nai-|he-s|he-(?:doc|slide|scaler|runtime|manifest|shell|csp)|(?:shell|runtime|manifest|csp))/i;
const ASSET_ID = /^asset:[A-Za-z0-9_-]{16,128}$/;
const DIMENSION = /^(?:0|[1-9][0-9]*)(?:px)?$/;

function fail(code: HtmlSanitizerViolationCode, detail: string): Failure {
  return { violation: { code, detail } };
}

function isFailure(value: unknown): value is Failure {
  return typeof value === 'object' && value !== null && 'violation' in value;
}

function childNodes(node: Node): Node[] {
  return Array.isArray((node as { childNodes?: Node[] }).childNodes)
    ? (node as { childNodes: Node[] }).childNodes
    : [];
}

function attrs(node: Node): Attribute[] {
  return Array.isArray((node as { attrs?: Attribute[] }).attrs)
    ? (node as { attrs: Attribute[] }).attrs
    : [];
}

function tagName(node: Node): string | null {
  const candidate = (node as { tagName?: unknown }).tagName;
  return typeof candidate === 'string' ? candidate.toLowerCase() : null;
}

function findElement(root: Node, name: string): Element | null {
  const visit = (node: Node): Element | null => {
    if (tagName(node) === name) return node as Element;
    for (const child of childNodes(node)) {
      const match = visit(child);
      if (match) return match;
    }
    return null;
  };
  return visit(root);
}

/**
 * Class/id gate shared with sanitizeAttributes: reserved tokens fail closed.
 * Returns null when the value is safe to keep.
 */
function rejectReservedClassOrId(name: 'class' | 'id', value: string): Failure | null {
  if (isReservedValue(value)) {
    return fail(HTML_VIOLATION_CODES.reservedNamespace, `reserved ${name} value`);
  }
  return null;
}

/**
 * Read class/id from a source element through the same reserved-name gate that
 * sanitizeAttributes applies to model elements. Reserved values are dropped
 * (not transferred onto the content root); other attributes are ignored.
 */
function readSafeClassAndId(node: Element | null): { className?: string; id?: string } {
  if (!node) return {};
  let className: string | undefined;
  let id: string | undefined;
  for (const attribute of attrs(node)) {
    const name = attribute.name.toLowerCase();
    if (name !== 'class' && name !== 'id') continue;
    if (rejectReservedClassOrId(name, attribute.value)) continue;
    if (!attribute.value) continue;
    if (name === 'class') className = attribute.value;
    else id = attribute.value;
  }
  return { className, id };
}

/**
 * Read inert global attrs (lang/dir/title/role) from a source element through the
 * same rejectDangerousAttribute + isAllowedAttribute path sanitizeAttributes uses.
 * Non-allowlisted / dangerous / empty values are dropped (not transferred).
 */
function readSafeRootAttrs(node: Element | null, isAllowedAssetId: (src: string) => boolean): Record<string, string> {
  if (!node) return {};
  const out: Record<string, string> = {};
  for (const attribute of attrs(node)) {
    const name = attribute.name.toLowerCase();
    if (!SAFE_ROOT_ATTRIBUTE_NAME_SET.has(name)) continue;
    // Same gates as sanitizeAttributes for a surviving global-attr element.
    if (rejectDangerousAttribute(attribute, isAllowedAssetId)) continue;
    if (!isAllowedAttribute('div', name)) continue;
    if (!attribute.value) continue;
    out[name] = attribute.value;
  }
  return out;
}

/** Merge html+body class tokens (order-preserving, de-duped). Body id wins over html id. */
function contentRootIdentity(
  document: DefaultTreeAdapterTypes.Document,
  isAllowedAssetId: (src: string) => boolean,
): {
  contentRootClass?: string;
  contentRootId?: string;
  contentRootAttrs?: Record<string, string>;
} {
  const html = readSafeClassAndId(findElement(document, 'html'));
  const body = readSafeClassAndId(findElement(document, 'body'));
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const value of [html.className, body.className]) {
    if (!value) continue;
    for (const part of value.split(/\s+/)) {
      if (!part || seen.has(part)) continue;
      // Per-token reserved gate (same isReservedValue path as element class attrs).
      if (rejectReservedClassOrId('class', part)) continue;
      seen.add(part);
      tokens.push(part);
    }
  }
  const contentRootClass = tokens.length > 0 ? tokens.join(' ') : undefined;
  const contentRootId = body.id ?? html.id;

  // Body attrs override html attrs (mirrors body-id-wins). Deterministic key order.
  const mergedAttrs: Record<string, string> = {
    ...readSafeRootAttrs(findElement(document, 'html'), isAllowedAssetId),
    ...readSafeRootAttrs(findElement(document, 'body'), isAllowedAssetId),
  };
  const contentRootAttrs: Record<string, string> = {};
  for (const name of SAFE_ROOT_ATTRIBUTE_NAMES) {
    if (mergedAttrs[name]) contentRootAttrs[name] = mergedAttrs[name];
  }

  return {
    ...(contentRootClass ? { contentRootClass } : {}),
    ...(contentRootId ? { contentRootId } : {}),
    ...(Object.keys(contentRootAttrs).length > 0 ? { contentRootAttrs } : {}),
  };
}
/**
 * Transfer safe html/body inline styles onto the content-root wrapper as scoped
 * stylesheet rules (html first, body second so body wins by source order).
 * Reuses sanitizeDeclarationList — the same path sanitizeAttributes uses for
 * element style attributes. Absent/empty styles emit nothing.
 */
function transferRootInlineStyles(
  document: DefaultTreeAdapterTypes.Document,
  context: Context,
): void {
  for (const node of [findElement(document, 'html'), findElement(document, 'body')]) {
    if (!node) continue;
    for (const attribute of attrs(node)) {
      if (attribute.name.toLowerCase() !== 'style') continue;
      const result = sanitizeDeclarationList(attribute.value, context.cssContext);
      if (!result.ok) {
        context.stripped.push(...result.violations.map((violation) => ({
          code: cssRejectedCode(violation.code),
          detail: violation.detail,
        })));
        continue;
      }
      context.stripped.push(...result.stripped.map((violation) => ({
        code: cssRejectedCode(violation.code),
        detail: violation.detail,
      })));
      if (result.css) context.inlineRules.push(`[data-he-content]{${result.css}}`);
    }
  }
}

/** Count element nodes strictly within `root`'s subtree (excludes `root` itself). */
function countElementDescendants(root: Node): number {
  let count = 0;
  for (const child of childNodes(root)) {
    if (tagName(child) !== null) count++;
    count += countElementDescendants(child);
  }
  return count;
}

function textValue(node: Node): string {
  return typeof (node as { value?: unknown }).value === 'string'
    ? (node as { value: string }).value
    : '';
}

/** True when `s` contains only HTML ASCII whitespace (U+0009/0A/0C/0D/20). */
function isHtmlAsciiWhitespaceOnly(s: string): boolean {
  return /^[\t\n\f\r ]*$/.test(s);
}

function countParsedTree(root: Node): HtmlSanitizerCounts | Failure {
  let nodeCount = 0;
  let attributeCount = 0;
  let maxDepth = 0;
  const visit = (node: Node, depth: number): Failure | null => {
    nodeCount++;
    maxDepth = Math.max(maxDepth, depth);
    if (nodeCount > HTML_SANITIZER_LIMITS.maxNodes) {
      return fail(HTML_VIOLATION_CODES.cap, `node count exceeds ${HTML_SANITIZER_LIMITS.maxNodes}`);
    }
    if (depth > HTML_SANITIZER_LIMITS.maxDepth) {
      return fail(HTML_VIOLATION_CODES.cap, `tree depth exceeds ${HTML_SANITIZER_LIMITS.maxDepth}`);
    }
    const nodeAttributes = attrs(node);
    if (nodeAttributes.length > HTML_SANITIZER_LIMITS.maxAttributesPerElement) {
      return fail(HTML_VIOLATION_CODES.cap, `element attribute count exceeds ${HTML_SANITIZER_LIMITS.maxAttributesPerElement}`);
    }
    attributeCount += nodeAttributes.length;
    if (attributeCount > HTML_SANITIZER_LIMITS.maxAttributes) {
      return fail(HTML_VIOLATION_CODES.cap, `attribute count exceeds ${HTML_SANITIZER_LIMITS.maxAttributes}`);
    }
    for (const child of childNodes(node)) {
      const childFailure = visit(child, depth + 1);
      if (childFailure) return childFailure;
    }
    const templateContent = (node as { content?: Node }).content;
    if (templateContent) {
      const contentFailure = visit(templateContent, depth + 1);
      if (contentFailure) return contentFailure;
    }
    return null;
  };
  return visit(root, 0) ?? { nodeCount, maxDepth, attributeCount };
}

function isReservedValue(value: string): boolean {
  return value.split(/\s+/).some((part) => RESERVED_CLASS_OR_ID.test(part));
}

function isAriaAttribute(name: string): boolean {
  return /^aria-[a-z][a-z0-9-]*$/.test(name);
}
const SAFE_INPUT_BOUND = /^(?:[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|\d{4}(?:-\d{2}(?:-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?)?)?|\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/i;

function isSafeInputBound(value: string): boolean {
  return SAFE_INPUT_BOUND.test(value) && (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) || Number.isFinite(Number(value)));
}

function isAllowedAttribute(tag: string, name: string): boolean {
  if (GLOBAL_ATTRIBUTES.has(name) || isAriaAttribute(name) || name === 'data-section-id' || name.startsWith('data-')) return true;
  if (name.startsWith('on')) return true;
  if (TABLE_ATTRIBUTES.has(name)) return ['th', 'td'].includes(tag);
  if (name === 'datetime') return tag === 'time';
  if (IMAGE_ATTRIBUTES.has(name)) return ['img', 'source'].includes(tag);
  if (name === 'href') return tag === 'a';
  if (name === 'src') return ['img', 'source'].includes(tag);
  if (name === 'type') return ['input', 'button', 'script'].includes(tag);
  if (name === 'value' || name === 'name' || name === 'placeholder' || name === 'checked' || name === 'disabled') return ['input', 'button'].includes(tag);
  if (['min', 'max', 'step'].includes(name)) return tag === 'input';
  return false;
}

function hasReservedNamespace(attribute: Attribute): boolean {
  const name = attribute.name.toLowerCase();
  return name.startsWith('data-he-')
    || name.startsWith('data-nai-')
    || attribute.prefix?.toLowerCase() === 'xlink'
    || attribute.namespace?.toLowerCase().includes('xlink') === true;
}
function isInternalFragment(value: string): boolean {
  return value.length > 1 && value.startsWith('#') && !/[\u0000-\u0020]/.test(value);
}

function rejectDangerousAttribute(
  attribute: Attribute,
  isAllowedAssetId: (src: string) => boolean,
): Failure | null {
  const name = attribute.name.toLowerCase();
  if (hasReservedNamespace(attribute)) return fail(HTML_VIOLATION_CODES.reservedNamespace, `reserved attribute ${attribute.name}`);
  if (['srcset', 'poster', 'formaction', 'background', 'ping', 'action'].includes(name)) {
    return fail(HTML_VIOLATION_CODES.url, `URL attribute ${name}`);
  }
  if (name === 'href' && attribute.value !== undefined && !isInternalFragment(attribute.value)) {
    return fail(HTML_VIOLATION_CODES.url, 'only non-empty fragment href values are allowed');
  }
  if (
    name === 'src'
    && attribute.value !== undefined
    && (!ASSET_ID.test(attribute.value) || !isAllowedAssetId(attribute.value))
  ) {
    return fail(HTML_VIOLATION_CODES.assetId, 'src must be an allowed opaque asset ID');
  }
  return null;
}

function cssFailure(violation: CssViolation): Failure {
  return fail(cssRejectedCode(violation.code), violation.detail);
}

function sanitizeAttributes(node: Node, tag: string, context: Context, survives: boolean): SanitizedAttributes {
  const output: Attribute[] = [];
  let inlineCss: string | null = null;
  for (const attribute of [
    ...attrs(node).filter((attribute) => attribute.name.toLowerCase() !== 'style'),
    ...attrs(node).filter((attribute) => attribute.name.toLowerCase() === 'style'),
  ]) {
    const name = attribute.name.toLowerCase();
    const dangerous = rejectDangerousAttribute(attribute, context.isAllowedAssetId);
    if (dangerous) { context.stripped.push(dangerous.violation); continue; }
    if (name === 'class') {
      const kept = attribute.value.split(/\s+/).filter((token) => token && !RESERVED_CLASS_OR_ID.test(token));
      if (kept.length !== attribute.value.split(/\s+/).filter(Boolean).length) context.stripped.push({ code: HTML_VIOLATION_CODES.reservedNamespace, detail: 'reserved class token' });
      if (kept.length) output.push({ name, value: kept.join(' ') });
      continue;
    }
    if (name === 'id' && isReservedValue(attribute.value)) { context.stripped.push({ code: HTML_VIOLATION_CODES.reservedNamespace, detail: 'reserved id' }); continue; }
    if (name === 'style') {
      const result = sanitizeDeclarationList(attribute.value, context.cssContext);
      if (!result.ok) context.stripped.push(...result.violations.map((v) => ({ code: cssRejectedCode(v.code), detail: v.detail })));
      else { context.stripped.push(...result.stripped.map((v) => ({ code: cssRejectedCode(v.code), detail: v.detail }))); inlineCss = result.css; }
      continue;
    }
    if (!survives) continue;
    if (
      !isAllowedAttribute(tag, name)
      || ((name === 'width' || name === 'height') && !DIMENSION.test(attribute.value))
      || (['min', 'max', 'step'].includes(name) && !isSafeInputBound(attribute.value))
    ) {
      context.stripped.push({ code: HTML_VIOLATION_CODES.attribute, detail: `attribute ${name} is not allowed on ${tag}` });
      continue;
    }
    output.push({ name, value: attribute.value });
  }
  return { attrs: output, inlineCss };
}

function makeText(value: string, parentNode: DefaultTreeAdapterTypes.ParentNode | null): DefaultTreeAdapterTypes.TextNode {
  return { nodeName: '#text', value, parentNode };
}

function makeElement(
  source: Element,
  attributes: Attribute[],
  children: SanitizedNode[],
  parentNode: DefaultTreeAdapterTypes.ParentNode | null,
): Element {
  const output: Element = {
    nodeName: source.nodeName,
    tagName: source.tagName,
    attrs: attributes,
    namespaceURI: source.namespaceURI || HTML_NAMESPACE,
    parentNode,
    childNodes: children as DefaultTreeAdapterTypes.ChildNode[],
  };
  for (const child of output.childNodes) child.parentNode = output;
  return output;
}

function styleText(node: Node): string {
  return childNodes(node).map((child) => textValue(child)).join('');
}
function stripStyleAttributes(node: Node, context: Context): void {
  for (const attribute of attrs(node)) {
    const dangerous = rejectDangerousAttribute(attribute, context.isAllowedAssetId);
    context.stripped.push(dangerous?.violation ?? {
      code: HTML_VIOLATION_CODES.attribute,
      detail: `attribute ${attribute.name} is not allowed on style`,
    });
  }
}

function scanDiscardedNode(node: Node, context: Context): Failure | null {
  if (context.svgPlans.has(node)) return null;
  const name = tagName(node);
  if (!name) return null;
  if (ACTIVE_TAGS.has(name) || (name === 'meta' && attrs(node).some((attribute) => attribute.name.toLowerCase() === 'http-equiv'))) {
    context.stripped.push({ code: HTML_VIOLATION_CODES.activeTag, detail: `active tag ${name}` });
    return null;
  }
  if (name === 'style') {
    stripStyleAttributes(node, context);
    const result = sanitizeStylesheet(styleText(node), context.cssContext);
    if (!result.ok) context.stripped.push(...result.violations.map((v) => ({ code: cssRejectedCode(v.code), detail: v.detail })));
    else { context.stripped.push(...result.stripped.map((v) => ({ code: cssRejectedCode(v.code), detail: v.detail }))); context.stylesheetRules.push(result.css); }
    return null;
  }
  if (name === 'script' && !attrs(node).some((attribute) => attribute.name.toLowerCase() === 'src')) {
    const sanitized = sanitizeNode(node, context, null);
    if (isFailure(sanitized)) return sanitized;
    context.relocatedHeadScripts.push(...sanitized);
    return null;
  }
  const attributes = sanitizeAttributes(node, name, context, false);
  if (isFailure(attributes)) return attributes;
  for (const child of childNodes(node)) {
    const childFailure = scanDiscardedNode(child, context);
    if (childFailure) return childFailure;
  }
  return null;
}

function registerDocumentKeyframes(
  node: Node,
  context: CssSanitizeContext,
  svgPlans: Map<Node, SvgRootPlan>,
): Failure | null {
  const name = tagName(node);
  if (
    svgPlans.has(node) ||
    name === 'template' ||
    (name !== null && ACTIVE_TAGS.has(name) && !ACTIVE_CONTENT_CONTAINERS.has(name)) ||
    name === 'svg'
  ) return null;
  if (tagName(node) === 'style') {
    const registration = registerCssKeyframes(styleText(node), context);
    if (!registration.ok) return cssFailure(registration.violations[0]);
  }
  for (const child of childNodes(node)) {
    const childFailure = registerDocumentKeyframes(child, context, svgPlans);
    if (childFailure) return childFailure;
  }
  return null;
}

function sanitizeNode(
  node: Node,
  context: Context,
  parentNode: DefaultTreeAdapterTypes.ParentNode | null,
  discardStyles = false,
): SanitizedNode[] | Failure {
  const svgPlan = context.svgPlans.get(node);
  if (svgPlan) return [reconstructSvgRoot(svgPlan, parentNode)];
  const name = tagName(node);
  if (discardStyles && name === 'style') {
    stripStyleAttributes(node, context);
    return [];
  }
  if (name === 'svg') {
    const text = collectDescendantText(node);
    return text ? [makeText(text, parentNode)] : [];
  }
  if (!name) {
    if ((node as { nodeName?: string }).nodeName === '#text') return [makeText(textValue(node), parentNode)];
    return [];
  }
  if (ACTIVE_TAGS.has(name) || (name === 'meta' && attrs(node).some((attribute) => attribute.name.toLowerCase() === 'http-equiv'))) {
    context.stripped.push({ code: HTML_VIOLATION_CODES.activeTag, detail: `active tag ${name}` });
    if (!ACTIVE_CONTENT_CONTAINERS.has(name)) return [];
    const unwrapped: SanitizedNode[] = [];
    for (const child of authoredChildren(node)) {
      const sanitized = sanitizeNode(child, context, parentNode, discardStyles || name === 'template');
      if (isFailure(sanitized)) return sanitized;
      unwrapped.push(...sanitized);
    }
    return unwrapped;
  }
  if (name === 'style') {
    stripStyleAttributes(node, context);
    const sourceCss = styleText(node);
    const result = sanitizeStylesheet(sourceCss, context.cssContext);
    if (!result.ok) context.stripped.push(...result.violations.map((v) => ({ code: cssRejectedCode(v.code), detail: v.detail })));
    else { context.stripped.push(...result.stripped.map((v) => ({ code: cssRejectedCode(v.code), detail: v.detail }))); context.stylesheetRules.push(result.css); }
    return [];
  }
  if (name === 'head') {
    const scan = scanDiscardedNode(node, context);
    return scan ?? [];
  }

  const survives = ALLOWED_TAGS.has(name);
  if ((name === 'img' || name === 'source') && attrs(node).some((attribute) => attribute.name.toLowerCase() === 'src' && (!ASSET_ID.test(attribute.value) || !context.isAllowedAssetId(attribute.value)))) {
    context.stripped.push({ code: HTML_VIOLATION_CODES.assetId, detail: 'src must be an allowed opaque asset ID' });
    const alt = attrs(node).find((attribute) => attribute.name.toLowerCase() === 'alt')?.value;
    return alt ? [makeText(alt, parentNode)] : [];
  }
  const attributes = sanitizeAttributes(node, name, context, survives);
  if (!survives) {
    const unwrapped: SanitizedNode[] = [];
    for (const child of childNodes(node)) {
      const sanitized = sanitizeNode(child, context, parentNode, discardStyles);
      if (isFailure(sanitized)) return sanitized;
      unwrapped.push(...sanitized);
    }
    return unwrapped;
  }

  const placeholder = makeElement(node as Element, attributes.attrs, [], parentNode);
  const children: SanitizedNode[] = [];
  for (const child of childNodes(node)) {
    const sanitized = sanitizeNode(child, context, placeholder, discardStyles);
    if (isFailure(sanitized)) return sanitized;
    children.push(...sanitized);
  }
  placeholder.childNodes = children as DefaultTreeAdapterTypes.ChildNode[];
  for (const child of placeholder.childNodes) child.parentNode = placeholder;
  if (attributes.inlineCss) {
    const marker = String(context.nextInlineStyle++);
    placeholder.attrs.push({ name: 'data-he-inline-style', value: marker });
    context.inlineRules.push(`[data-he-content] [data-he-inline-style="${marker}"]{${attributes.inlineCss}}`);
  }
  return [placeholder];
}

function authoredChildren(node: Node): Node[] {
  const templateContent = (node as { content?: Node }).content;
  return templateContent ? childNodes(templateContent) : childNodes(node);
}
function collectDescendantText(node: Node, includeText = false): string {
  if ((node as { nodeName?: string }).nodeName === '#text') return includeText ? textValue(node) : '';
  const name = tagName(node);
  if (name !== null && SVG_FALLBACK_SKIPPED_TAGS.has(name)) return '';
  const collectChildText = name !== null && SVG_FALLBACK_TEXT_TAGS.has(name);
  return childNodes(node).map((child) => collectDescendantText(child, collectChildText)).join('');
}

function findBody(document: DefaultTreeAdapterTypes.Document): Element | null {
  return findElement(document, 'body');
}

/**
 * Reconstructs model-authored HTML into an inert, deterministic parse5 document.
 * The injected parser exists solely for deterministic tests and must return a parse5-compatible tree.
 */
export function sanitizeHtmlExport(options: HtmlExportSanitizeOptions): HtmlExportSanitizeResult {
  try {
    if (!options || typeof options.html !== 'string') {
      return { ok: false, violations: [{ code: HTML_VIOLATION_CODES.parse, detail: 'HTML must be a string' }] };
    }
    let document: DefaultTreeAdapterTypes.Document;
    try {
      document = (options.parse ?? parse)(options.html);
    } catch {
      return { ok: false, violations: [{ code: HTML_VIOLATION_CODES.parse, detail: 'HTML parse failed' }] };
    }
    if (!document || typeof document !== 'object') {
      return { ok: false, violations: [{ code: HTML_VIOLATION_CODES.parse, detail: 'parser returned no document' }] };
    }
    const counts = countParsedTree(document);
    if (isFailure(counts)) return { ok: false, violations: [counts.violation] };
    const isAllowedAssetId = options.isAllowedAssetId;
    const svgPreflight = preflightSvgSubtrees(document, isReservedValue);
    const svgPlans = svgPreflight.plans;
    const svgStripped = svgPreflight.stripped.map((code) => ({
      code,
      detail: 'stripped SVG surface',
    }));
    const sourceNodes = childNodes(document);
    const cssContext = createCssSanitizeContext();
    const registrationFailure = registerDocumentKeyframes(document, cssContext, svgPlans);
    const registrationStripped: HtmlSanitizerViolation[] = registrationFailure ? [registrationFailure.violation] : [];
    const context: Context = {
      isAllowedAssetId,
      stylesheetRules: [],
      inlineRules: [],
      relocatedHeadScripts: [],
      nextInlineStyle: 0,
      cssContext,
      svgPlans,
      stripped: [...registrationStripped],
    };
    const outputDocument = parse('<!doctype html><html><head></head><body></body></html>');
    const outputBody = findBody(outputDocument);
    if (!outputBody) return { ok: false, violations: [{ code: HTML_VIOLATION_CODES.internal, detail: 'could not construct output body' }] };

    const outputNodes: SanitizedNode[] = [];
    for (const sourceNode of sourceNodes) {
      const sanitized = sanitizeNode(sourceNode, context, outputBody);
      if (isFailure(sanitized)) return { ok: false, violations: [sanitized.violation] };
      outputNodes.push(...sanitized);
    }
    outputNodes.unshift(...context.relocatedHeadScripts);
    outputBody.childNodes = outputNodes as DefaultTreeAdapterTypes.ChildNode[];
    for (const child of outputBody.childNodes) child.parentNode = outputBody;
    context.stripped.push(...svgStripped);

    // Structural floor: a response that is not structural HTML — e.g. model
    // narration/prose — parses to a body with (near-)zero elements and is
    // rejected. Marker-free fragments discard top-level narration alongside
    // structural content; complete documents preserve authored body text.
    if (options.requireStructuralDocument) {
      const bodyElementCount = countElementDescendants(outputBody);
      if (bodyElementCount < HTML_MIN_BODY_ELEMENT_NODES) {
        return {
          ok: false,
          violations: [
            {
              code: HTML_VIOLATION_CODES.noStructure,
              detail: `sanitized body has ${bodyElementCount} element node(s); a structural HTML document is required (>= ${HTML_MIN_BODY_ELEMENT_NODES})`,
            },
          ],
        };
      }
      const topLevelNarration = new Set(
        options.extractedDocument
          ? []
          : childNodes(outputBody).filter(
              (child) =>
                (child as { nodeName?: string }).nodeName === '#text' &&
                !isHtmlAsciiWhitespaceOnly(textValue(child)),
            ),
      );
      if (topLevelNarration.size > 0) {
        outputBody.childNodes = childNodes(outputBody).filter((child) => !topLevelNarration.has(child)) as DefaultTreeAdapterTypes.ChildNode[];
        for (const child of outputBody.childNodes) child.parentNode = outputBody;
        context.stripped.push({
          code: HTML_VIOLATION_CODES.topLevelNarration,
          detail: 'stripped top-level narration/prose text',
        });
      }
    }

    const rootIdentity = contentRootIdentity(document, isAllowedAssetId);
    transferRootInlineStyles(document, context);
    return {
      ok: true,
      bodyHtml: serialize(outputBody),
      documentHtml: serialize(outputDocument),
      contentCss: `@layer he-authored{${context.stylesheetRules.join('')}}${context.inlineRules.join('')}`,
      counts,
      stripped: context.stripped.map((violation) => violation.code),
      ...rootIdentity,
    };
  } catch {
    return { ok: false, violations: [{ code: HTML_VIOLATION_CODES.internal, detail: 'HTML sanitization failed' }] };
  }
}
