import { parse, serialize, type DefaultTreeAdapterTypes } from 'parse5';
import {
  createCssSanitizeContext,
  CSS_MAX_STYLESHEET_BYTES,
  registerCssKeyframes,
  sanitizeDeclarationList,
  sanitizeStylesheet,
  type CssSanitizeContext,
  type CssViolation,
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
  cssRejected: 'css_rejected',
  internal: 'html_internal',
  noStructure: 'html_no_structure',
} as const;

type HtmlSanitizerViolationCode = (typeof HTML_VIOLATION_CODES)[keyof typeof HTML_VIOLATION_CODES] | SvgViolationCode;
type HtmlSanitizerViolation = { code: HtmlSanitizerViolationCode; detail: string };
type HtmlSanitizerCounts = { nodeCount: number; maxDepth: number; attributeCount: number };
export type HtmlExportParse = (html: string) => DefaultTreeAdapterTypes.Document;

type HtmlExportSanitizeSuccess = {
  ok: true;
  bodyHtml: string;
  documentHtml: string;
  contentCss: string;
  counts: HtmlSanitizerCounts;
};

type HtmlExportSanitizeFailure = {
  ok: false;
  violations: HtmlSanitizerViolation[];
};

export type HtmlExportSanitizeResult = HtmlExportSanitizeSuccess | HtmlExportSanitizeFailure;
export type HtmlExportSanitizeOptions = {
  html: string;
  parse?: HtmlExportParse;
  isAllowedAssetId?: (src: string) => boolean;
  /**
   * When true, require the sanitized body to be a structural HTML document (at
   * least `HTML_MIN_BODY_ELEMENT_NODES` element nodes) — the pipeline enables this
   * so a non-HTML answer (model narration/prose) is rejected fail-closed, never
   * finalized (issue #27). The raw sanitizer (unit tests, ad-hoc fragments) leaves
   * it off and stays a pure filter.
   */
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
  nextInlineStyle: number;
  cssContext: CssSanitizeContext;
  svgPlans: Map<Node, SvgRootPlan>;
};
type Failure = { violation: HtmlSanitizerViolation };

const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const ALLOWED_TAGS = new Set([
  'section', 'div', 'article', 'header', 'footer', 'nav', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p',
  'span', 'strong', 'em', 'b', 'i', 'u', 's', 'small', 'mark', 'sub', 'sup', 'br', 'hr', 'ul', 'ol',
  'li', 'dl', 'dt', 'dd', 'blockquote', 'figure', 'figcaption', 'img', 'picture', 'source', 'svg',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'code', 'pre', 'kbd', 'samp',
  'abbr', 'time', 'a',
]);
const ACTIVE_TAGS = new Set([
  'iframe', 'object', 'embed', 'base', 'frame', 'frameset', 'applet', 'script', 'link', 'template',
  'slot', 'form', 'input', 'button',
]);
const GLOBAL_ATTRIBUTES = new Set(['class', 'id', 'title', 'lang', 'dir', 'role']);
const TABLE_ATTRIBUTES = new Set(['colspan', 'rowspan', 'scope']);
const IMAGE_ATTRIBUTES = new Set(['alt', 'width', 'height']);
const RESERVED_CLASS_OR_ID = /^(?:he-s|he-(?:doc|slide|scaler|runtime|manifest|shell|csp)|(?:shell|runtime|manifest|csp))/i;
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

function isAllowedAttribute(tag: string, name: string): boolean {
  if (GLOBAL_ATTRIBUTES.has(name) || isAriaAttribute(name) || name === 'data-section-id') return true;
  if (TABLE_ATTRIBUTES.has(name)) return ['th', 'td'].includes(tag);
  if (name === 'datetime') return tag === 'time';
  if (IMAGE_ATTRIBUTES.has(name)) return ['img', 'source'].includes(tag);
  if (name === 'href') return tag === 'a';
  if (name === 'src') return ['img', 'source'].includes(tag);
  return false;
}

function hasReservedNamespace(attribute: Attribute): boolean {
  const name = attribute.name.toLowerCase();
  return name.startsWith('data-he-')
    || attribute.prefix?.toLowerCase() === 'xlink'
    || attribute.namespace?.toLowerCase().includes('xlink') === true;
}
function isInternalFragment(value: string): boolean {
  return value.length > 1 && value.startsWith('#') && !/[\u0000-\u0020]/.test(value);
}

function rejectDangerousAttribute(
  attribute: Attribute,
  isAllowedAssetId: (src: string) => boolean = () => true,
): Failure | null {
  const name = attribute.name.toLowerCase();
  if (name.startsWith('on')) return fail(HTML_VIOLATION_CODES.eventHandler, `event handler attribute ${name}`);
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
function preflightAttributeFailure(
  node: Node,
  tag: string,
  survives: boolean,
  isAllowedAssetId: (src: string) => boolean,
): Failure | null {
  for (const attribute of attrs(node)) {
    const name = attribute.name.toLowerCase();
    const dangerous = rejectDangerousAttribute(attribute, isAllowedAssetId);
    if (dangerous) return dangerous;
    if ((name === 'class' || name === 'id') && isReservedValue(attribute.value)) {
      return fail(HTML_VIOLATION_CODES.reservedNamespace, `reserved ${name} value`);
    }
    if (name === 'style' || !survives) continue;
    if (!isAllowedAttribute(tag, name)) {
      return fail(HTML_VIOLATION_CODES.attribute, `attribute ${name} is not allowed on ${tag}`);
    }
    if ((name === 'width' || name === 'height') && !DIMENSION.test(attribute.value)) {
      return fail(HTML_VIOLATION_CODES.attribute, `${name} must be unitless or px`);
    }
  }
  return null;
}
function preflightHtmlBoundary(root: Node, isAllowedAssetId: (src: string) => boolean): Failure | null {
  const visit = (node: Node): Failure | null => {
    const name = tagName(node);
    if (name === 'svg') {
      // SVG attributes are preflighted by the static SVG sanitizer after outer HTML boundaries.
      return null;
    }
    if (name) {
      if (ACTIVE_TAGS.has(name) || (name === 'meta' && attrs(node).some((attribute) => attribute.name.toLowerCase() === 'http-equiv'))) {
        return fail(HTML_VIOLATION_CODES.activeTag, `active tag ${name}`);
      }
      const attributeFailure = preflightAttributeFailure(node, name, ALLOWED_TAGS.has(name), isAllowedAssetId);
      if (attributeFailure) return attributeFailure;
    }
    for (const child of childNodes(node)) {
      const childFailure = visit(child);
      if (childFailure) return childFailure;
    }
    return null;
  };
  return visit(root);
}

function cssFailure(violation: CssViolation): Failure {
  return fail(HTML_VIOLATION_CODES.cssRejected, `${violation.code}: ${violation.detail}`);
}

function sanitizeAttributes(node: Node, tag: string, context: Context, survives: boolean): SanitizedAttributes | Failure {
  const output: Attribute[] = [];
  let inlineCss: string | null = null;
  for (const attribute of attrs(node)) {
    const name = attribute.name.toLowerCase();
    const dangerous = rejectDangerousAttribute(attribute, context.isAllowedAssetId);
    if (dangerous) return dangerous;
    if ((name === 'class' || name === 'id') && isReservedValue(attribute.value)) {
      return fail(HTML_VIOLATION_CODES.reservedNamespace, `reserved ${name} value`);
    }
    if (name === 'style') {
      const result = sanitizeDeclarationList(attribute.value, context.cssContext);
      if (!result.ok) return cssFailure(result.violations[0]);
      inlineCss = result.css;
      continue;
    }
    if (!survives) continue;
    if (!isAllowedAttribute(tag, name)) return fail(HTML_VIOLATION_CODES.attribute, `attribute ${name} is not allowed on ${tag}`);
    if ((name === 'width' || name === 'height') && !DIMENSION.test(attribute.value)) {
      return fail(HTML_VIOLATION_CODES.attribute, `${name} must be unitless or px`);
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
function validateStyleAttributes(node: Node): Failure | null {
  for (const attribute of attrs(node)) {
    const dangerous = rejectDangerousAttribute(attribute);
    if (dangerous) return dangerous;
    return fail(HTML_VIOLATION_CODES.attribute, `attribute ${attribute.name} is not allowed on style`);
  }
  return null;
}

function scanDiscardedNode(node: Node, context: Context): Failure | null {
  if (context.svgPlans.has(node)) return null;
  const name = tagName(node);
  if (!name) return null;
  if (ACTIVE_TAGS.has(name) || (name === 'meta' && attrs(node).some((attribute) => attribute.name.toLowerCase() === 'http-equiv'))) {
    return fail(HTML_VIOLATION_CODES.activeTag, `active tag ${name}`);
  }
  if (name === 'style') {
    const attributeFailure = validateStyleAttributes(node);
    if (attributeFailure) return attributeFailure;
    const result = sanitizeStylesheet(styleText(node), context.cssContext);
    if (!result.ok) return cssFailure(result.violations[0]);
    context.stylesheetRules.push(result.css);
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
  if (svgPlans.has(node)) return null;
  if (tagName(node) === 'style') {
    const registration = registerCssKeyframes(styleText(node), context);
    if (!registration.ok) return cssFailure(registration.violations[0]);
  }
  for (const child of childNodes(node)) {
    const childFailure = registerDocumentKeyframes(child, context, svgPlans);
    if (childFailure) return childFailure;
  }
  const templateContent = (node as { content?: Node }).content;
  return templateContent ? registerDocumentKeyframes(templateContent, context, svgPlans) : null;
}
function preflightCssSurfaces(
  root: Node,
  isAllowedAssetId: (src: string) => boolean,
  svgPlans: Map<Node, SvgRootPlan>,
): Failure | null {
  let cssBytes = 0;
  const addBytes = (css: string): Failure | null => {
    cssBytes += Buffer.byteLength(css, 'utf8');
    return cssBytes > CSS_MAX_STYLESHEET_BYTES
      ? fail(HTML_VIOLATION_CODES.cssRejected, `css_too_large: document CSS exceeds ${CSS_MAX_STYLESHEET_BYTES} bytes`)
      : null;
  };
  const visit = (node: Node): Failure | null => {
    if (svgPlans.has(node)) return null;
    const name = tagName(node);
    if (name && (ACTIVE_TAGS.has(name) || (name === 'meta' && attrs(node).some((attribute) => attribute.name.toLowerCase() === 'http-equiv')))) {
      return fail(HTML_VIOLATION_CODES.activeTag, `active tag ${name}`);
    }
    if (name) {
      const attributeFailure = preflightAttributeFailure(node, name, ALLOWED_TAGS.has(name), isAllowedAssetId);
      if (attributeFailure) return attributeFailure;
    }
    if (name === 'style') {
      const attributeFailure = validateStyleAttributes(node);
      if (attributeFailure) return attributeFailure;
      return addBytes(styleText(node));
    }
    if (name) {
      for (const attribute of attrs(node)) {
        if (attribute.name.toLowerCase() !== 'style') continue;
        const byteFailure = addBytes(attribute.value);
        if (byteFailure) return byteFailure;
      }
    }
    for (const child of childNodes(node)) {
      const childFailure = visit(child);
      if (childFailure) return childFailure;
    }
    return null;
  };
  return visit(root);
}

function sanitizeNode(node: Node, context: Context, parentNode: DefaultTreeAdapterTypes.ParentNode | null): SanitizedNode[] | Failure {
  const svgPlan = context.svgPlans.get(node);
  if (svgPlan) return [reconstructSvgRoot(svgPlan, parentNode)];
  const name = tagName(node);
  if (!name) {
    if ((node as { nodeName?: string }).nodeName === '#text') return [makeText(textValue(node), parentNode)];
    return [];
  }
  if (ACTIVE_TAGS.has(name) || (name === 'meta' && attrs(node).some((attribute) => attribute.name.toLowerCase() === 'http-equiv'))) {
    return fail(HTML_VIOLATION_CODES.activeTag, `active tag ${name}`);
  }
  if (name === 'style') {
    const attributeFailure = validateStyleAttributes(node);
    if (attributeFailure) return attributeFailure;
    const sourceCss = styleText(node);
    const result = sanitizeStylesheet(sourceCss, context.cssContext);
    if (!result.ok) return cssFailure(result.violations[0]);
    context.stylesheetRules.push(result.css);
    return [];
  }
  if (name === 'head') {
    const scan = scanDiscardedNode(node, context);
    return scan ?? [];
  }

  const survives = ALLOWED_TAGS.has(name);
  const attributes = sanitizeAttributes(node, name, context, survives);
  if (isFailure(attributes)) return attributes;
  if (!survives) {
    const unwrapped: SanitizedNode[] = [];
    for (const child of childNodes(node)) {
      const sanitized = sanitizeNode(child, context, parentNode);
      if (isFailure(sanitized)) return sanitized;
      unwrapped.push(...sanitized);
    }
    return unwrapped;
  }

  const placeholder = makeElement(node as Element, attributes.attrs, [], parentNode);
  const children: SanitizedNode[] = [];
  for (const child of childNodes(node)) {
    const sanitized = sanitizeNode(child, context, placeholder);
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

function findBody(document: DefaultTreeAdapterTypes.Document): Element | null {
  const visit = (node: Node): Element | null => {
    if (tagName(node) === 'body') return node as Element;
    for (const child of childNodes(node)) {
      const match = visit(child);
      if (match) return match;
    }
    return null;
  };
  return visit(document);
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
    const isAllowedAssetId = options.isAllowedAssetId ?? (() => true);
    const htmlBoundaryFailure = preflightHtmlBoundary(document, isAllowedAssetId);
    if (htmlBoundaryFailure) return { ok: false, violations: [htmlBoundaryFailure.violation] };
    const svgPreflight = preflightSvgSubtrees(document, isReservedValue);
    if (!svgPreflight.ok) return { ok: false, violations: [svgPreflight.violation] };
    const preflightFailure = preflightCssSurfaces(document, isAllowedAssetId, svgPreflight.plans);
    if (preflightFailure) return { ok: false, violations: [preflightFailure.violation] };

    const sourceNodes = childNodes(document);
    const cssContext = createCssSanitizeContext();
    const context: Context = {
      isAllowedAssetId,
      stylesheetRules: [],
      inlineRules: [],
      nextInlineStyle: 0,
      cssContext,
      svgPlans: svgPreflight.plans,
    };
    const registrationFailure = registerDocumentKeyframes(document, cssContext, svgPreflight.plans);
    if (registrationFailure) return { ok: false, violations: [registrationFailure.violation] };
    const outputDocument = parse('<!doctype html><html><head></head><body></body></html>');
    const outputBody = findBody(outputDocument);
    if (!outputBody) return { ok: false, violations: [{ code: HTML_VIOLATION_CODES.internal, detail: 'could not construct output body' }] };

    const outputNodes: SanitizedNode[] = [];
    for (const sourceNode of sourceNodes) {
      const sanitized = sanitizeNode(sourceNode, context, outputBody);
      if (isFailure(sanitized)) return { ok: false, violations: [sanitized.violation] };
      outputNodes.push(...sanitized);
    }
    outputBody.childNodes = outputNodes as DefaultTreeAdapterTypes.ChildNode[];
    for (const child of outputBody.childNodes) child.parentNode = outputBody;

    // Fail-closed structural gate (issue #27): a response that is not a structural
    // HTML document — e.g. model narration/prose — parses to a body of text nodes
    // with (near-)zero elements. Reject it here so it can never sanitize→finalize→
    // save as an export; the pipeline maps this to a retryable pipeline-reject.
    const bodyElementCount = countElementDescendants(outputBody);
    if (options.requireStructuralDocument && bodyElementCount < HTML_MIN_BODY_ELEMENT_NODES) {
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

    return {
      ok: true,
      bodyHtml: serialize(outputBody),
      documentHtml: serialize(outputDocument),
      contentCss: `@layer he-authored{${context.stylesheetRules.join('')}}${context.inlineRules.join('')}`,
      counts,
    };
  } catch {
    return { ok: false, violations: [{ code: HTML_VIOLATION_CODES.internal, detail: 'HTML sanitization failed' }] };
  }
}
