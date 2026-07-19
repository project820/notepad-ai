import { generate, ident, lexer, List, parse, walk } from 'css-tree';

/** Frozen resource limits for model-authored export CSS. */
export const CSS_MAX_STYLESHEET_BYTES = 128 * 1024;
export const CSS_MAX_RULES = 2_000;
export const CSS_MAX_DECLARATIONS_PER_RULE = 60;
export const CSS_MAX_SELECTORS_PER_RULE = 20;
export const CSS_MAX_COMPOUND_DEPTH = 8;
export const CSS_MAX_NESTING_DEPTH = 4;
export const CSS_MAX_KEYFRAMES = 200;
export const CSS_MAX_FRAMES_PER_KEYFRAMES = 200;
export const CSS_MAX_ANIMATIONS_PER_ELEMENT = 32;
export const CSS_MIN_ANIMATION_DURATION_MS = 0;
export const CSS_MIN_Z_INDEX = -2_147_483_648;
export const CSS_MAX_Z_INDEX = 2_147_483_647;
export const CSS_MAX_FONT_SIZE_PX = 10_000;
export const CSS_MAX_VALUE_TOKEN_LENGTH = 512;
export const CSS_MAX_DECLARATIONS = 20_000;

const CSS_ALLOWED_PROPERTIES = [
  'display', 'position', 'top', 'right', 'bottom', 'left', 'inset', 'inset-block', 'inset-inline',
  'z-index', 'box-sizing', 'float', 'clear', 'width', 'height', 'min-width', 'min-height',
  'max-width', 'max-height', 'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'border',
  'border-width', 'border-style', 'border-color', 'border-top', 'border-right', 'border-bottom',
  'border-left', 'border-top-width', 'border-right-width', 'border-bottom-width',
  'border-left-width', 'border-top-style', 'border-right-style', 'border-bottom-style',
  'border-left-style', 'border-top-color', 'border-right-color', 'border-bottom-color',
  'border-left-color', 'border-radius', 'border-top-left-radius', 'border-top-right-radius',
  'border-bottom-right-radius', 'border-bottom-left-radius', 'outline', 'outline-width',
  'outline-style', 'outline-color', 'outline-offset', 'color', 'background', 'background-color',
  'background-image', 'background-position', 'background-size', 'background-repeat',
  'background-clip', 'background-origin', 'opacity', 'visibility', 'overflow', 'overflow-x',
  'overflow-y', 'flex', 'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis',
  'gap', 'row-gap', 'column-gap', 'order', 'align-items', 'align-content', 'align-self',
  'justify-items', 'justify-content', 'justify-self', 'place-items', 'place-content', 'place-self',
  'grid-template-columns', 'grid-template-rows', 'grid-template-areas', 'grid-auto-flow',
  'grid-auto-rows', 'grid-auto-columns', 'grid-column', 'grid-row', 'grid-area', 'font',
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant', 'font-stretch',
  'line-height', 'letter-spacing', 'word-spacing', 'text-align', 'text-decoration',
  'text-decoration-line', 'text-decoration-color', 'text-decoration-style', 'text-transform',
  'text-indent', 'text-overflow', 'text-shadow', 'white-space', 'word-break', 'overflow-wrap',
  'hyphens', 'vertical-align', 'list-style', 'list-style-type', 'list-style-position', 'content',
  'box-shadow', 'filter', 'transform', 'transform-origin', 'transition', 'transition-property',
  'transition-duration', 'transition-timing-function', 'transition-delay', 'animation',
  'animation-name', 'animation-duration', 'animation-timing-function', 'animation-delay',
  'animation-iteration-count', 'animation-direction', 'animation-fill-mode', 'cursor',
  'pointer-events', 'aspect-ratio', 'object-fit', 'object-position',
] as const;

const CSS_ALLOWED_FUNCTIONS = [
  'rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix',
  'calc', 'min', 'max', 'clamp', 'var', 'linear-gradient', 'radial-gradient', 'conic-gradient',
  'repeating-linear-gradient', 'repeating-radial-gradient', 'repeating-conic-gradient',
  'translate', 'translateX', 'translateY', 'translateZ', 'translate3d', 'scale', 'scaleX', 'scaleY',
  'scaleZ', 'scale3d', 'rotate', 'rotateX', 'rotateY', 'rotateZ', 'rotate3d', 'skew', 'skewX',
  'skewY', 'matrix', 'matrix3d', 'perspective', 'cubic-bezier', 'steps', 'blur', 'brightness',
  'contrast', 'drop-shadow', 'grayscale', 'hue-rotate', 'invert', 'opacity', 'saturate', 'sepia',
] as const;

const CSS_ALLOWED_AT_RULES = ['media', 'supports', 'keyframes'] as const;

export const CSS_VIOLATION_CODES = {
  parseError: 'css_parse_error',
  internal: 'css_internal',
  tooLarge: 'css_too_large',
  tooManyRules: 'css_too_many_rules',
  tooManyDeclarations: 'css_too_many_declarations',
  tooManyDeclarationsPerRule: 'css_too_many_declarations_per_rule',
  tooManySelectors: 'css_too_many_selectors',
  selectorTooDeep: 'css_selector_too_deep',
  nestingTooDeep: 'css_nesting_too_deep',
  reservedSelector: 'css_reserved_selector',
  disallowedSelector: 'css_disallowed_selector',
  important: 'css_important_not_allowed',
  customProperty: 'css_custom_property_not_allowed',
  networkFunction: 'css_network_function_not_allowed',
  valueIndirection: 'css_value_indirection_not_allowed',
  disallowedFunction: 'css_disallowed_function',
  contentNotAllowed: 'css_content_not_allowed',
  disallowedAtRule: 'css_disallowed_at_rule',
  tooManyKeyframes: 'css_too_many_keyframes',
  tooManyFrames: 'css_too_many_frames',
  duplicateKeyframes: 'css_duplicate_keyframes',
  reservedKeyframes: 'css_reserved_keyframes',
  unresolvedAnimation: 'css_unresolved_animation',
  tooManyAnimations: 'css_too_many_animations',
  animationTooShort: 'css_animation_duration_too_short',
  unsafePosition: 'css_unsafe_position',
  zIndexOutOfRange: 'css_z_index_out_of_range',
  fontSizeTooLarge: 'css_font_size_too_large',
  fontSizeNotAllowed: 'css_font_size_not_allowed',
  tokenTooLong: 'css_value_token_too_long',
} as const;

type CssViolationCode = (typeof CSS_VIOLATION_CODES)[keyof typeof CSS_VIOLATION_CODES];
export type CssViolation = { code: CssViolationCode; detail: string };
export type CssRejectedSubcode = CssViolationCode | 'svg_attribute';

export function cssRejectedCode<T extends CssRejectedSubcode>(inner: T): `css_rejected.${T}` {
  return `css_rejected.${inner}`;
}
export type CssSanitizeResult =
  | { ok: true; css: string; ruleCount: number; declarationCount: number; stripped: CssViolation[] }
  | { ok: false; violations: CssViolation[] };
export type CssContextRegistrationResult = { ok: true } | { ok: false; violations: CssViolation[] };

/**
 * Document-scoped accounting for multiple model <style> nodes and style attributes.
 * Callers that need forward animation references must pre-register every surviving
 * stylesheet first.
 */
export interface CssSanitizeContext {
  registrationBytes: number;
  rawBytes: number;
  seenRuleNodes: number;
  seenAtRuleNodes: number;
  seenDeclarations: number;
  keyframeCount: number;
  keyframes: Map<string, string>;
  consumedKeyframes: Set<string>;
  nextKeyframeSequence: number;
  stripped: CssViolation[];
}

type Failure = { violation: CssViolation };
type Counts = { ruleCount: number; declarationCount: number };

const PROPERTY_SET = new Set<string>(CSS_ALLOWED_PROPERTIES);
const FUNCTION_SET = new Set<string>(CSS_ALLOWED_FUNCTIONS.map((name) => name.toLowerCase()));
const AT_RULE_SET = new Set<string>(CSS_ALLOWED_AT_RULES);
const TYPE_SELECTORS = new Set([
  'section', 'div', 'article', 'main', 'aside', 'header', 'footer', 'nav', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'span', 'strong', 'em', 'b', 'i', 'u', 's', 'small', 'mark', 'sub', 'sup', 'br', 'hr',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'blockquote', 'figure', 'figcaption', 'img', 'picture',
  'source', 'svg', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'code',
  'pre', 'kbd', 'samp', 'abbr', 'time', 'a', 'form', 'input', 'button',
]);
const PSEUDO_CLASSES = new Set(['active', 'any-link', 'checked', 'default', 'defined', 'disabled', 'empty', 'enabled', 'first-child', 'first-of-type', 'focus', 'focus-visible', 'focus-within', 'has', 'hover', 'in-range', 'indeterminate', 'invalid', 'is', 'last-child', 'last-of-type', 'not', 'nth-child', 'nth-last-child', 'nth-last-of-type', 'nth-of-type', 'only-child', 'only-of-type', 'optional', 'out-of-range', 'placeholder-shown', 'read-only', 'read-write', 'required', 'root', 'target', 'user-invalid', 'valid', 'visited', 'where']);
const PSEUDO_ELEMENTS = new Set(['after', 'backdrop', 'before', 'first-letter', 'first-line', 'marker', 'placeholder', 'selection']);
const SAFE_ATTRIBUTE_SELECTOR_NAMES = new Set([
  'class', 'id', 'title', 'lang', 'dir', 'role', 'data-section-id', 'colspan', 'rowspan', 'scope',
  'alt', 'width', 'height', 'datetime', 'type',
]);
const MEDIA_FEATURES = new Set(['width', 'min-width', 'max-width', 'height', 'orientation', 'aspect-ratio', 'prefers-color-scheme']);
const FONT_SIZE_KEYWORDS = new Set(['xx-small', 'x-small', 'small', 'medium', 'large', 'x-large', 'xx-large', 'xxx-large']);
const RESERVED_NAME = /^(?:data-(?:he|nai)-|nai-|he-s|he-(?:doc|slide|scaler|runtime|manifest|shell|csp)|(?:data-)?(?:shell|runtime|manifest|csp))/i;
const NETWORK_FUNCTION = new Set(['url', 'image', 'image-set', '-webkit-image-set', 'cross-fade', 'element', 'expression']);
const VALUE_INDIRECTION_FUNCTION = new Set(['attr', 'env', 'paint']);
const ANIMATION_KEYWORDS = new Set([
  'none', 'linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out', 'step-start', 'step-end',
  'infinite', 'normal', 'reverse', 'alternate', 'alternate-reverse', 'forwards', 'backwards',
  'both', 'running', 'paused',
]);
const CSS_WIDE_KEYWORDS = new Set(['initial', 'inherit', 'unset', 'revert', 'revert-layer']);

export function createCssSanitizeContext(): CssSanitizeContext {
  return {
    rawBytes: 0,
    registrationBytes: 0,
    seenRuleNodes: 0,
    seenAtRuleNodes: 0,
    seenDeclarations: 0,
    keyframeCount: 0,
    keyframes: new Map(),
    consumedKeyframes: new Set(),
    nextKeyframeSequence: 0,
    stripped: [],
  };
}

function children(node: any): any[] {
  return node?.children ? Array.from(node.children as Iterable<any>) : [];
}

function fail(code: CssViolationCode, detail: string): Failure {
  return { violation: { code, detail } };
}

function isFailure(value: unknown): value is Failure {
  return typeof value === 'object' && value !== null && 'violation' in value;
}

function generated(node: any): string {
  return generate(node);
}

function valueNodes(node: any): any[] {
  const result: any[] = [];
  walk(node, { enter(current: any) { result.push(current); } });
  return result;
}

/** Decode CSS identifier escapes (`\XX ` hex, `\c` literal) so reserved-name and
 *  allowlist comparisons see the canonical value the browser would resolve — an
 *  escaped reserved name (e.g. `\64 ata-he-content`) must not evade the check. */
function decodeCssEscapes(s: string): string {
  return s.replace(/\\([0-9a-fA-F]{1,6})(?:\r\n|[ \t\n\r\f])?|\\([^0-9a-fA-F])/g, (_m, hex, ch) => {
    if (hex) {
      const code = parseInt(hex, 16);
      if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
      return String.fromCodePoint(code);
    }
    return ch;
  });
}

function canonicalizeIdent(raw: string): string {
  const s = String(raw);
  if (s.indexOf('\\') === -1) return s;
  // Prefer the parser's own escape decoder (handles CRLF terminators, surrogate/
  // over-range guards, etc.); fall back to a CRLF-aware regex if it ever throws.
  try {
    return ident.decode(s);
  } catch {
    return decodeCssEscapes(s);
  }
}

function hasReservedName(name: string): boolean {
  const n = canonicalizeIdent(name).toLowerCase();
  return RESERVED_NAME.test(n) || n === 'data-he-content';
}

const CONTENT_ROOT_ATTR = 'data-he-content';
const CONTENT_ROOT_SELECTOR = `[${CONTENT_ROOT_ATTR}]`;

function isGlobalRootAtom(node: any): boolean {
  if (node?.type === 'TypeSelector') {
    const name = String(node.name).toLowerCase();
    return name === 'html' || name === 'body';
  }
  // Only the non-functional `:root` atom is a rewrite target; `:root(...)` is a
  // functional pseudo whose arguments are never validated — never treat it as root.
  if (node?.type === 'PseudoClassSelector') {
    return String(node.name).toLowerCase() === 'root' && node.children == null;
  }
  return false;
}

function isUniversalAtom(node: any): boolean {
  if (node?.type === 'UniversalSelector') return true;
  return node?.type === 'TypeSelector' && String(node.name) === '*';
}

function contentRootAttributeSelector(): any {
  return {
    type: 'AttributeSelector',
    name: { type: 'Identifier', name: CONTENT_ROOT_ATTR },
    matcher: null,
    value: null,
    flags: null,
  };
}

/** Deep-clone a css-tree node / List so rewrite does not mutate the validated original. */
function cloneCssNode(node: any): any {
  if (node == null || typeof node !== 'object') return node;
  if (node instanceof List || (typeof node.forEach === 'function' && typeof node.appendData === 'function' && typeof node.toArray === 'function')) {
    const list = new List();
    node.forEach((child: any) => {
      list.appendData(cloneCssNode(child));
    });
    return list;
  }
  if (Array.isArray(node)) return node.map(cloneCssNode);
  const out: any = {};
  for (const key of Object.keys(node)) {
    if (key === 'loc') continue;
    out[key] = cloneCssNode(node[key]);
  }
  return out;
}

/** Replace model-authored html/body/:root atoms with the sanitizer content-root attribute. */
function rewriteGlobalRootAtoms(node: any): void {
  if (!node || typeof node !== 'object') return;
  if (isGlobalRootAtom(node)) {
    for (const key of Object.keys(node)) delete node[key];
    Object.assign(node, contentRootAttributeSelector());
    return;
  }
  if (node.children && typeof node.children.forEach === 'function') {
    node.children.forEach((child: any) => rewriteGlobalRootAtoms(child));
  }
}

function isThemeAttributeAtom(node: any): boolean {
  return node?.type === 'AttributeSelector' && String(node.name?.name ?? node.name ?? '').toLowerCase() === 'data-theme';
}

function isThemeRootSelector(selector: any): boolean {
  const nodes = children(selector);
  if (nodes.length === 1) return isThemeAttributeAtom(nodes[0]);
  return nodes.length === 2
    && isGlobalRootAtom(nodes[0])
    && isThemeAttributeAtom(nodes[1]);
}

function isLeadingThemeAtom(node: any): boolean {
  if (isThemeAttributeAtom(node)) return true;
  if (node?.type !== 'PseudoClassSelector') return false;
  const name = String(node.name).toLowerCase();
  if (name !== 'where' && name !== 'is') return false;
  const selectorList = children(node)[0];
  const selectors = children(selectorList);
  return selectorList?.type === 'SelectorList' && selectors.length > 0 && selectors.every(isThemeRootSelector);
}

function leadingThemeRootArgumentCount(node: any): number {
  if (node?.type !== 'PseudoClassSelector') return 0;
  return children(children(node)[0]).filter((selector) => isThemeRootSelector(selector)
    && isGlobalRootAtom(children(selector)[0])).length;
}

/** Approximate leading theme sibling selectors as descendants to retain containment. */
function rewriteLeadingThemeSiblingCombinator(selector: any, leadingThemeAtom: boolean): void {
  const nodes = children(selector);
  if (!leadingThemeAtom) return;
  for (const node of nodes) {
    if (node?.type !== 'Combinator') continue;
    if (node.name === '+' || node.name === '~') node.name = ' ';
    return;
  }
}

function isExactGlobalRootSelector(selector: any): boolean {
  const nodes = children(selector);
  return nodes.length === 1 && isGlobalRootAtom(nodes[0]);
}

function isExactUniversalSelector(selector: any): boolean {
  const nodes = children(selector);
  return nodes.length === 1 && isUniversalAtom(nodes[0]);
}



/**
 * Scope one validated selector to the export content root.
 * Global root atoms rewrite in-place; exact `*` becomes a descendant universal.
 * Never rewrites model-authored `[data-he-content]` — those fail reserved validation first.
 */
function scopeSelector(selector: any): string {
  if (isExactGlobalRootSelector(selector)) return CONTENT_ROOT_SELECTOR;
  if (isExactUniversalSelector(selector)) return `${CONTENT_ROOT_SELECTOR} *`;
  const leadingThemeAtom = isLeadingThemeAtom(children(selector)[0]);
  const rewritten = cloneCssNode(selector);
  rewriteGlobalRootAtoms(rewritten);
  rewriteLeadingThemeSiblingCombinator(rewritten, leadingThemeAtom);
  const text = generated(rewritten);
  if (text.startsWith(CONTENT_ROOT_SELECTOR)) return text;
  if (leadingThemeAtom) return `${CONTENT_ROOT_SELECTOR}${text}`;
  return `${CONTENT_ROOT_SELECTOR} ${text}`;
}

/** Collect every non-functional global-root atom anywhere in the selector tree,
 *  using the parser's structural walk so selector-bearing fields (e.g. the
 *  `of S` list on `:nth-child(... of S)`, stored on `Nth.selector`, not `.children`)
 *  are covered — a root hidden there must not evade the shape check. */
function collectRootAtoms(node: any, acc: any[]): void {
  if (!node || typeof node !== 'object') return;
  walk(node, {
    enter(current: any) {
      if (isGlobalRootAtom(current)) acc.push(current);
    },
  });
}

/**
 * Minimal safe global-root grammar (security): a non-functional html/body/:root
 * atom may appear ONLY as the single leading atom of a selector whose combinators
 * are descendant/child. Reject roots that are nested, repeated, non-leading, or
 * joined by sibling combinators (`+` / `~`) — those escape the content root or
 * silently mis-scope. Runs AFTER validateSelector (which rejects functional :root).
 */
function validateGlobalRootShape(selector: any): Failure | null {
  const roots: any[] = [];
  collectRootAtoms(selector, roots);
  if (roots.length === 0) return null;
  const top = children(selector);
  if (isLeadingThemeAtom(top[0]) && roots.length === leadingThemeRootArgumentCount(top[0])) return null;
  if (roots.length > 1) {
    return fail(CSS_VIOLATION_CODES.disallowedSelector, 'multiple global-root selectors');
  }
  if (top[0] !== roots[0]) {
    return fail(CSS_VIOLATION_CODES.disallowedSelector, 'global-root selector must be the leading atom');
  }
  for (const atom of top) {
    if (atom?.type === 'Combinator' && (atom.name === '+' || atom.name === '~')) {
      return fail(CSS_VIOLATION_CODES.disallowedSelector, 'global-root selector with sibling combinator');
    }
  }
  return null;
}

function violationResult(failure: Failure): CssSanitizeResult {
  return { ok: false, violations: [failure.violation] };
}

function strip(context: CssSanitizeContext, failure: Failure): void {
  context.stripped.push(failure.violation);
}


function countRule(context: CssSanitizeContext, atRule: boolean): Failure | null {
  if (atRule) context.seenAtRuleNodes++;
  else context.seenRuleNodes++;
  return context.seenAtRuleNodes + context.seenRuleNodes > CSS_MAX_RULES
    ? fail(CSS_VIOLATION_CODES.tooManyRules, `document has more than ${CSS_MAX_RULES} rules or at-rules`)
    : null;
}

function keyframeName(atRule: any): string | Failure {
  const name = atRule?.prelude ? generated(atRule.prelude).trim() : '';
  return /^[A-Za-z_-][A-Za-z0-9_-]*$/.test(name)
    ? name
    : fail(CSS_VIOLATION_CODES.disallowedAtRule, 'invalid @keyframes name');
}

function allocateKeyframe(name: string, context: CssSanitizeContext, consume: boolean): string | Failure {
  const lowerName = name.toLowerCase();
  if (hasReservedName(name) || lowerName.startsWith('he-') || ANIMATION_KEYWORDS.has(lowerName) || CSS_WIDE_KEYWORDS.has(lowerName)) {
    return fail(CSS_VIOLATION_CODES.reservedKeyframes, `reserved or ambiguous keyframes name ${name}`);
  }
  const existing = context.keyframes.get(name);
  if (existing) {
    if (consume) {
      if (context.consumedKeyframes.has(name)) return fail(CSS_VIOLATION_CODES.duplicateKeyframes, `duplicate @keyframes ${name}`);
      context.consumedKeyframes.add(name);
    } else {
      return fail(CSS_VIOLATION_CODES.duplicateKeyframes, `duplicate @keyframes ${name}`);
    }
    return existing;
  }
  context.keyframeCount++;
  if (context.keyframeCount > CSS_MAX_KEYFRAMES) {
    return fail(CSS_VIOLATION_CODES.tooManyKeyframes, `more than ${CSS_MAX_KEYFRAMES} keyframes`);
  }
  const scoped = `he-k${context.nextKeyframeSequence++}`;
  context.keyframes.set(name, scoped);
  if (consume) context.consumedKeyframes.add(name);
  return scoped;
}

/** Registers keyframe definitions from one stylesheet before multi-source sanitization. */
export function registerCssKeyframes(css: string, context: CssSanitizeContext): CssContextRegistrationResult {
  if (typeof css !== 'string') {
    return { ok: false, violations: [{ code: CSS_VIOLATION_CODES.parseError, detail: 'CSS must be a string' }] };
  }
  context.registrationBytes += Buffer.byteLength(css, 'utf8');
  if (context.registrationBytes > CSS_MAX_STYLESHEET_BYTES) {
    return { ok: false, violations: [{ code: CSS_VIOLATION_CODES.tooLarge, detail: `registered CSS exceeds ${CSS_MAX_STYLESHEET_BYTES} bytes` }] };
  }
  let ast: any;
  try {
    ast = parse(css, { context: 'stylesheet', positions: false });
  } catch {
    return { ok: false, violations: [{ code: CSS_VIOLATION_CODES.parseError, detail: 'CSS parse failed' }] };
  }
  try {
    const definitions: any[] = [];
    walk(ast, { enter(node: any) { if (node.type === 'Atrule' && String(node.name).toLowerCase() === 'keyframes') definitions.push(node); } });
    const validationContext = createCssSanitizeContext();
    const counts: Counts = { ruleCount: 0, declarationCount: 0 };
    for (const definition of definitions) {
      const name = keyframeName(definition);
      if (isFailure(name)) return { ok: false, violations: [name.violation] };
      const frames = sanitizeKeyframeFrames(definition, validationContext, counts);
      if (isFailure(frames) || !frames) continue;
      const scoped = allocateKeyframe(name, context, false);
      if (isFailure(scoped)) return { ok: false, violations: [scoped.violation] };
    }
    return { ok: true };
  } catch {
    return { ok: false, violations: [{ code: CSS_VIOLATION_CODES.internal, detail: 'sanitizer internal failure' }] };
  }
}

function validateSelectorAtom(node: any): Failure | null {
  const type = node?.type;
  if (type === 'TypeSelector') {
    const name = String(node.name).toLowerCase();
    // html/body/* are rewrite targets (scoped to [data-he-content]); head/style stay reserved.
    if (name === 'html' || name === 'body' || name === '*') return null;
    if (name === 'head' || name === 'style') return fail(CSS_VIOLATION_CODES.reservedSelector, `reserved type selector ${name}`);
    if (!TYPE_SELECTORS.has(name)) return fail(CSS_VIOLATION_CODES.disallowedSelector, `type selector ${name}`);
  } else if (type === 'UniversalSelector') {
    // Rewrite/scope target — accepted and rewritten in scopeSelector.
    return null;
  } else if (type === 'NestingSelector') {
    return fail(CSS_VIOLATION_CODES.disallowedSelector, 'nesting selector');
  } else if (type === 'ClassSelector' || type === 'IdSelector') {
    const name = String(node.name);
    if (hasReservedName(name) || (type === 'IdSelector' && canonicalizeIdent(name).toLowerCase().startsWith('he-'))) {
      return fail(CSS_VIOLATION_CODES.reservedSelector, `reserved selector ${name}`);
    }
  } else if (type === 'AttributeSelector') {
    const name = String(node.name?.name ?? node.name ?? '').toLowerCase();
    if (hasReservedName(name)) return fail(CSS_VIOLATION_CODES.reservedSelector, `reserved attribute ${name}`);
    const selectedValue = node.value ? generated(node.value).replace(/^['"]|['"]$/g, '').toLowerCase() : '';
    if ((name === 'class' && hasReservedName(selectedValue)) || (name === 'id' && (hasReservedName(selectedValue) || canonicalizeIdent(selectedValue).startsWith('he-')))) {
      return fail(CSS_VIOLATION_CODES.reservedSelector, `reserved attribute selector ${name}`);
    }
    if (!SAFE_ATTRIBUTE_SELECTOR_NAMES.has(name) && !name.startsWith('aria-') && !name.startsWith('data-')) {
      return fail(CSS_VIOLATION_CODES.disallowedSelector, `attribute selector ${name}`);
    }
  } else if (type === 'PseudoClassSelector') {
    const name = String(node.name).toLowerCase();
    // Only the non-functional `:root` atom is a rewrite target; `:root(...)` is a
    // functional pseudo whose arguments are never validated and must be rejected.
    if (name === 'root') {
      if (node.children != null) return fail(CSS_VIOLATION_CODES.disallowedSelector, 'functional pseudo-class :root()');
      return null;
    }
    if (!PSEUDO_CLASSES.has(name)) return fail(CSS_VIOLATION_CODES.disallowedSelector, `pseudo-class :${name}`);
  } else if (type === 'PseudoElementSelector') {
    const name = String(node.name).toLowerCase();
    if (!PSEUDO_ELEMENTS.has(name)) return fail(CSS_VIOLATION_CODES.disallowedSelector, `pseudo-element ::${name}`);
  } else if (type === 'Raw') {
    return fail(CSS_VIOLATION_CODES.disallowedSelector, 'unparsed selector');
  }
  return null;
}

function nestedSelectorLists(node: any): any[] {
  const lists: any[] = [];
  const visit = (current: any) => {
    if (current?.selector?.type === 'SelectorList' || current?.selector?.type === 'Selector') {
      lists.push(current.selector);
    }
    for (const child of children(current)) {
      if (child.type === 'SelectorList') lists.push(child);
      else visit(child);
    }
  };
  visit(node);
  return lists;
}

function validateSelectorList(selectorList: any): Failure | null {
  for (const selector of children(selectorList)) {
    const selectorFailure = validateSelector(selector);
    if (selectorFailure) return selectorFailure;
  }
  return null;
}

function validateSelector(selector: any): Failure | null {
  let combinators = 0;
  let compoundDepth = 0;
  for (const node of children(selector)) {
    if (node.type === 'Combinator') {
      if (![' ', '>', '+', '~'].includes(node.name)) return fail(CSS_VIOLATION_CODES.disallowedSelector, `combinator ${node.name}`);
      combinators++;
      compoundDepth = 0;
      if (combinators > CSS_MAX_COMPOUND_DEPTH) return fail(CSS_VIOLATION_CODES.selectorTooDeep, `selector depth exceeds ${CSS_MAX_COMPOUND_DEPTH}`);
      continue;
    }
    const atomFailure = validateSelectorAtom(node);
    if (atomFailure) return atomFailure;
    compoundDepth++;
    if (compoundDepth > CSS_MAX_COMPOUND_DEPTH) return fail(CSS_VIOLATION_CODES.selectorTooDeep, `compound depth exceeds ${CSS_MAX_COMPOUND_DEPTH}`);
    if (node.type === 'PseudoClassSelector') {
      for (const list of nestedSelectorLists(node)) {
        const nestedFailure = list.type === 'SelectorList'
          ? validateSelectorList(list)
          : validateSelector(list);
        if (nestedFailure) return nestedFailure;
      }
    }
  }
  return null;
}

function rawFunctionFailure(raw: string): Failure | null {
  const matches = raw.matchAll(/([a-z-]+)\s*\(/gi);
  for (const match of matches) {
    const name = match[1].toLowerCase();
    if (NETWORK_FUNCTION.has(name)) return fail(CSS_VIOLATION_CODES.networkFunction, `${name}()`);
    if (VALUE_INDIRECTION_FUNCTION.has(name)) return fail(CSS_VIOLATION_CODES.valueIndirection, `${name}()`);
    if (!FUNCTION_SET.has(name)) return fail(CSS_VIOLATION_CODES.disallowedFunction, `${name}()`);
  }
  return null;
}

function validateValue(value: any): Failure | null {
  for (const node of valueNodes(value)) {
    if (node?.type === 'Raw') {
      const rawFailure = rawFunctionFailure(String(node.value ?? ''));
      if (rawFailure) return rawFailure;
      continue;
    }
    if (node?.type === 'Url') return fail(CSS_VIOLATION_CODES.networkFunction, 'url()');
    if (node?.type === 'Function') {
      const name = String(node.name).toLowerCase();
      if (NETWORK_FUNCTION.has(name)) return fail(CSS_VIOLATION_CODES.networkFunction, `${name}()`);
      if (VALUE_INDIRECTION_FUNCTION.has(name)) return fail(CSS_VIOLATION_CODES.valueIndirection, `${name}()`);
      if (!FUNCTION_SET.has(name)) return fail(CSS_VIOLATION_CODES.disallowedFunction, `${name}()`);
    }
    if (node?.type !== 'Value' && node?.type !== 'Function' && generated(node).length > CSS_MAX_VALUE_TOKEN_LENGTH) {
      return fail(CSS_VIOLATION_CODES.tokenTooLong, `value token exceeds ${CSS_MAX_VALUE_TOKEN_LENGTH} characters`);
    }
  }
  return null;
}

function splitItems(value: any): any[][] {
  const items: any[][] = [[]];
  for (const node of children(value)) {
    if (node.type === 'Operator' && node.value === ',') items.push([]);
    else items[items.length - 1].push(node);
  }
  return items;
}

function durationMs(item: any[]): number | null {
  for (const node of item) {
    if (node.type !== 'Dimension') continue;
    const unit = String(node.unit).toLowerCase();
    if (unit === 'ms') return Number(node.value);
    if (unit === 's') return Number(node.value) * 1_000;
  }
  return null;
}

function rewriteAnimation(property: string, value: any, context: CssSanitizeContext): Failure | null {
  const items = splitItems(value);
  if (items.length > CSS_MAX_ANIMATIONS_PER_ELEMENT) return fail(CSS_VIOLATION_CODES.tooManyAnimations, `more than ${CSS_MAX_ANIMATIONS_PER_ELEMENT} animations`);
  if (CSS_WIDE_KEYWORDS.has(generated(value).toLowerCase())) {
    return fail(CSS_VIOLATION_CODES.unresolvedAnimation, `animation cannot use ${generated(value)}`);
  }
  if (property === 'animation' || property === 'animation-duration') {
    for (const item of items) {
      const duration = durationMs(item);
      if (duration === null || !Number.isFinite(duration) || duration < CSS_MIN_ANIMATION_DURATION_MS) {
        return fail(CSS_VIOLATION_CODES.animationTooShort, `animation duration must be at least ${CSS_MIN_ANIMATION_DURATION_MS}ms`);
      }
    }
  }
  if (property === 'animation-duration' || property === 'animation-delay') return null;
  const match = lexer.matchProperty(property, value);
  if (match.error) return null;
  for (const node of valueNodes(value)) {
    if (!(match as unknown as { isType(node: unknown, type: string): boolean }).isType(node, 'keyframes-name')) continue;
    const name = node.type === 'String'
      ? String(node.value).replace(/^['"]|['"]$/g, '')
      : String(node.name ?? '');
    if (name.toLowerCase() === 'none') continue;
    const scoped = context.keyframes.get(name);
    if (!scoped) return fail(CSS_VIOLATION_CODES.unresolvedAnimation, `animation references undefined keyframes ${name}`);
    if (node.type === 'String') node.value = scoped;
    else node.name = scoped;
  }
  return null;
}

function validateFontSize(value: any): Failure | null {
  const tokens = children(value);
  if (tokens.length !== 1) return fail(CSS_VIOLATION_CODES.fontSizeNotAllowed, 'font-size must be one safe value');
  const token = tokens[0];
  if (token.type === 'Number' && Number(token.value) === 0) return null;
  if (token.type === 'Dimension' && ['px', 'rem', 'em'].includes(String(token.unit).toLowerCase())) {
    const size = Number(token.value);
    if (Number.isFinite(size) && size >= 0 && size <= CSS_MAX_FONT_SIZE_PX) return null;
    return fail(CSS_VIOLATION_CODES.fontSizeTooLarge, `font-size must be from 0 to ${CSS_MAX_FONT_SIZE_PX}`);
  }
  if (token.type === 'Percentage') {
    const size = Number(token.value);
    if (Number.isFinite(size) && size >= 0 && size <= CSS_MAX_FONT_SIZE_PX) return null;
    return fail(CSS_VIOLATION_CODES.fontSizeTooLarge, `font-size percentage must be from 0 to ${CSS_MAX_FONT_SIZE_PX}%`);
  }
  if (token.type === 'Identifier' && FONT_SIZE_KEYWORDS.has(String(token.name).toLowerCase())) return null;
  return fail(CSS_VIOLATION_CODES.fontSizeNotAllowed, 'font-size must be zero, px, rem, em, %, or a safe absolute keyword');
}
function validateFontShorthand(value: any): Failure | null {
  let beforeLineHeight = true;
  let foundSize = false;
  for (const token of children(value)) {
    if (token.type === 'Operator' && token.value === '/') {
      beforeLineHeight = false;
      continue;
    }
    if (token.type === 'Identifier' && CSS_WIDE_KEYWORDS.has(String(token.name).toLowerCase())) {
      return fail(CSS_VIOLATION_CODES.fontSizeNotAllowed, 'font shorthand cannot use global keywords');
    }
    if (!beforeLineHeight || foundSize) continue;
    if (token.type === 'Number' && Number(token.value) === 0) {
      foundSize = true;
      continue;
    }
    if (token.type === 'Dimension') {
      if (!['px', 'rem', 'em'].includes(String(token.unit).toLowerCase())) {
        return fail(CSS_VIOLATION_CODES.fontSizeNotAllowed, 'font shorthand size must use px, rem, or em');
      }
      const size = Number(token.value);
      if (!Number.isFinite(size) || size < 0 || size > CSS_MAX_FONT_SIZE_PX) {
        return fail(CSS_VIOLATION_CODES.fontSizeTooLarge, `font shorthand size must be from 0 to ${CSS_MAX_FONT_SIZE_PX}`);
      }
      foundSize = true;
      continue;
    }
    if (token.type === 'Percentage') {
      const size = Number(token.value);
      if (!Number.isFinite(size) || size < 0 || size > CSS_MAX_FONT_SIZE_PX) {
        return fail(CSS_VIOLATION_CODES.fontSizeTooLarge, `font shorthand percentage must be from 0 to ${CSS_MAX_FONT_SIZE_PX}%`);
      }
      foundSize = true;
      continue;
    }
    if (token.type === 'Identifier') {
      const keyword = String(token.name).toLowerCase();
      if (FONT_SIZE_KEYWORDS.has(keyword)) foundSize = true;
      else if (keyword === 'smaller' || keyword === 'larger') {
        return fail(CSS_VIOLATION_CODES.fontSizeNotAllowed, 'font shorthand size must be absolute');
      }
    }
  }
  return foundSize
    ? null
    : fail(CSS_VIOLATION_CODES.fontSizeNotAllowed, 'font shorthand must include a safe absolute size');
}

function validateContent(value: any): Failure | null {
  const tokens = children(value);
  if (tokens.length === 1 && tokens[0].type === 'Identifier' && String(tokens[0].name).toLowerCase() === 'none') return null;
  return tokens.length > 0 && tokens.every((token) => token.type === 'String')
    ? null
    : fail(CSS_VIOLATION_CODES.contentNotAllowed, 'content must contain only strings or none');
}


function validateNumericCaps(property: string, value: any, context: CssSanitizeContext): Failure | null {
  if (property === 'position') {
    const position = generated(value).toLowerCase();
    if (!['static', 'relative', 'absolute', 'fixed', 'sticky'].includes(position)) return fail(CSS_VIOLATION_CODES.unsafePosition, `position:${position} is not allowed`);
  }
  if (property === 'z-index') {
    const tokens = children(value);
    if (tokens.length === 1 && tokens[0].type === 'Number') {
      const numeric = Number(tokens[0].value);
      if (!Number.isInteger(numeric) || numeric < CSS_MIN_Z_INDEX || numeric > CSS_MAX_Z_INDEX) {
        return fail(CSS_VIOLATION_CODES.zIndexOutOfRange, `z-index must be an integer from ${CSS_MIN_Z_INDEX} to ${CSS_MAX_Z_INDEX}`);
      }
    } else if (generated(value).toLowerCase() !== 'auto' && !lexer.matchProperty(property, generated(value)).error) {
      return fail(CSS_VIOLATION_CODES.zIndexOutOfRange, `z-index must be an integer from ${CSS_MIN_Z_INDEX} to ${CSS_MAX_Z_INDEX}`);
    }
  }
  if (property === 'font-size') return validateFontSize(value);
  if (property === 'font') return validateFontShorthand(value);
  if (property === 'content') return validateContent(value);
  if (property === 'animation' || property === 'animation-name' || property === 'animation-duration' || property === 'animation-delay') {
    return rewriteAnimation(property, value, context);
  }
  return null;
}

function sanitizeDeclarations(block: any, context: CssSanitizeContext, counts: Counts): string {
  const output: string[] = [];
  const declarations = children(block);
  if (declarations.length > CSS_MAX_DECLARATIONS_PER_RULE) {
    strip(context, fail(CSS_VIOLATION_CODES.tooManyDeclarationsPerRule, `rule has more than ${CSS_MAX_DECLARATIONS_PER_RULE} declarations`));
    return '';
  }
  for (const declaration of declarations) {
    if (declaration.type !== 'Declaration') { strip(context, fail(CSS_VIOLATION_CODES.parseError, 'invalid declaration')); continue; }
    context.seenDeclarations++;
    if (context.seenDeclarations > CSS_MAX_DECLARATIONS) { strip(context, fail(CSS_VIOLATION_CODES.tooManyDeclarations, `more than ${CSS_MAX_DECLARATIONS} declarations`)); break; }
    const declaredProperty = String(declaration.property);
    const property = declaredProperty.toLowerCase();
    let failure: Failure | null = null;
    if (!failure) failure = validateValue(declaration.value);
    if (!failure && PROPERTY_SET.has(property)) failure = validateNumericCaps(property, declaration.value, context);
    if (failure) { strip(context, failure); continue; }
    const value = generated(declaration.value);
    if ((!PROPERTY_SET.has(property) && !property.startsWith('--')) || (!property.startsWith('--') && lexer.matchProperty(property, value).error)) continue;
    output.push(`${declaredProperty.startsWith('--') ? declaredProperty : property}:${value}${declaration.important ? '!important' : ''}`);
    counts.declarationCount++;
  }
  return output.join(';');
}

function sanitizeRule(rule: any, context: CssSanitizeContext, counts: Counts): string {
  const ruleFailure = countRule(context, false);
  if (ruleFailure) { strip(context, ruleFailure); return ''; }
  const selectors = children(rule.prelude);
  if (!selectors.length) { strip(context, fail(CSS_VIOLATION_CODES.parseError, 'rule without selectors')); return ''; }
  if (selectors.length > CSS_MAX_SELECTORS_PER_RULE) { strip(context, fail(CSS_VIOLATION_CODES.tooManySelectors, `rule has more than ${CSS_MAX_SELECTORS_PER_RULE} selectors`)); return ''; }
  const outputSelectors: string[] = [];
  for (const selector of selectors) {
    const failure = validateSelector(selector) ?? validateGlobalRootShape(selector);
    if (failure) { strip(context, failure); return ''; }
    outputSelectors.push(scopeSelector(selector));
  }
  const declarations = sanitizeDeclarations(rule.block, context, counts);
  if (declarations) counts.ruleCount++;
  return declarations ? `${outputSelectors.join(',')}{${declarations}}` : '';
}

function validateAtRulePrelude(atRule: any): Failure | null {
  if (!atRule.prelude) return fail(CSS_VIOLATION_CODES.parseError, `@${atRule.name} without prelude`);
  const name = String(atRule.name).toLowerCase();
  const nodes = valueNodes(atRule.prelude);
  if (name === 'media') {
    for (const node of nodes) {
      if (node?.type === 'MediaQuery' && node.mediaType && !['print', 'screen'].includes(String(node.mediaType).toLowerCase())) return fail(CSS_VIOLATION_CODES.disallowedAtRule, `media type ${node.mediaType}`);
      if (node?.type === 'Feature' && !MEDIA_FEATURES.has(String(node.name).toLowerCase())) return fail(CSS_VIOLATION_CODES.disallowedAtRule, `media feature ${node.name}`);
    }
  }
  if (name === 'supports') {
    const declarations = nodes.filter((node) => node?.type === 'SupportsDeclaration');
    if (!declarations.length || nodes.some((node) => node?.type === 'SupportsSelector' || node?.type === 'GeneralEnclosed') || /\bselector\s*\(/i.test(generated(atRule.prelude))) {
      return fail(CSS_VIOLATION_CODES.disallowedAtRule, '@supports requires property tests');
    }
    for (const support of declarations) {
      const declaration = support.declaration;
      const property = String(declaration?.property ?? '').toLowerCase();
      const value = declaration?.value;
      if (!PROPERTY_SET.has(property) || !value || lexer.matchProperty(property, generated(value)).error) return fail(CSS_VIOLATION_CODES.disallowedAtRule, `unsupported @supports property ${property}`);
      const valueFailure = validateValue(value);
      if (valueFailure) return valueFailure;
    }
  }
  for (const node of nodes) {
    if (node?.type === 'Url') return fail(CSS_VIOLATION_CODES.networkFunction, 'url() in at-rule prelude');
    if (node?.type === 'Function') {
      const functionName = String(node.name).toLowerCase();
      if (functionName === 'var') return fail(CSS_VIOLATION_CODES.customProperty, 'var() in at-rule prelude');
      if (!FUNCTION_SET.has(functionName)) return fail(CSS_VIOLATION_CODES.disallowedFunction, `${functionName}() in at-rule prelude`);
    }
    if (node?.type === 'Raw') {
      const rawFailure = rawFunctionFailure(String(node.value ?? ''));
      return rawFailure ?? fail(CSS_VIOLATION_CODES.disallowedAtRule, `unparsed @${atRule.name} prelude`);
    }
  }
  return null;
}

function sanitizeKeyframeFrames(atRule: any, context: CssSanitizeContext, counts: Counts): string | Failure {
  const frames = children(atRule.block);
  let effectiveFrameCount = 0;
  const output: string[] = [];
  for (const frame of frames) {
    if (frame.type !== 'Rule') return fail(CSS_VIOLATION_CODES.disallowedAtRule, 'invalid keyframe child');
    const ruleFailure = countRule(context, false);
    if (ruleFailure) return ruleFailure;
    const selectors = children(frame.prelude);
    effectiveFrameCount += selectors.length;
    if (effectiveFrameCount > CSS_MAX_FRAMES_PER_KEYFRAMES) return fail(CSS_VIOLATION_CODES.tooManyFrames, `keyframes has more than ${CSS_MAX_FRAMES_PER_KEYFRAMES} frame selectors`);
    if (!selectors.length || selectors.some((selector) => !/^(?:from|to|(?:\d|[1-9]\d|100)%)$/.test(generated(selector)))) {
      return fail(CSS_VIOLATION_CODES.disallowedSelector, 'invalid keyframe selector');
    }
    const declarations = sanitizeDeclarations(frame.block, context, counts);
    if (declarations) {
      counts.ruleCount++;
      output.push(`${selectors.map(generated).join(',')}{${declarations}}`);
    }
  }
  return output.join('');
}

function sanitizeKeyframes(atRule: any, context: CssSanitizeContext, counts: Counts): string | Failure {
  const name = keyframeName(atRule);
  if (isFailure(name)) return name;
  const frames = sanitizeKeyframeFrames(atRule, context, counts);
  if (isFailure(frames)) return frames;
  if (!frames) return '';
  const scopedName = allocateKeyframe(name, context, true);
  if (isFailure(scopedName)) return scopedName;
  return `@keyframes ${scopedName}{${frames}}`;
}

function sanitizeNodes(nodes: any[], context: CssSanitizeContext, counts: Counts, depth: number): string | Failure {
  if (depth > CSS_MAX_NESTING_DEPTH) return fail(CSS_VIOLATION_CODES.nestingTooDeep, `at-rule nesting exceeds ${CSS_MAX_NESTING_DEPTH}`);
  const output: string[] = [];
  for (const node of nodes) {
    if (node.type === 'Rule') {
      const rule = sanitizeRule(node, context, counts);
      if (isFailure(rule)) return rule;
      if (rule) output.push(rule);
      continue;
    }
    if (node.type !== 'Atrule') {
      strip(context, fail(CSS_VIOLATION_CODES.parseError, 'invalid stylesheet node'));
      continue;
    }
    const atRuleFailure = countRule(context, true);
    if (atRuleFailure) { strip(context, atRuleFailure); continue; }
    const name = String(node.name).toLowerCase();
    if (!AT_RULE_SET.has(name)) {
      strip(context, fail(CSS_VIOLATION_CODES.disallowedAtRule, `@${name}`));
      continue;
    }
    if (name === 'keyframes') {
      const keyframes = sanitizeKeyframes(node, context, counts);
      if (isFailure(keyframes)) {
        strip(context, keyframes);
        continue;
      }
      if (keyframes) output.push(keyframes);
      continue;
    }
    const preludeFailure = validateAtRulePrelude(node);
    if (preludeFailure) {
      strip(context, preludeFailure);
      continue;
    }
    if (!node.block) {
      strip(context, fail(CSS_VIOLATION_CODES.disallowedAtRule, `@${name} without block`));
      continue;
    }
    const content = sanitizeNodes(children(node.block), context, counts, depth + 1);
    if (isFailure(content)) {
      strip(context, content);
      continue;
    }
    if (content) output.push(`@${name} ${generated(node.prelude)}{${content}}`);
  }
  return output.join('');
}

function sanitize(input: unknown, kind: 'stylesheet' | 'declarationList', context: CssSanitizeContext): CssSanitizeResult {
  try {
    if (typeof input !== 'string') return violationResult(fail(CSS_VIOLATION_CODES.parseError, 'CSS must be a string'));
    const strippedStart = context.stripped.length;
    let source = input;
    const sourceBytes = Buffer.byteLength(source, 'utf8');
    const remaining = CSS_MAX_STYLESHEET_BYTES - context.rawBytes;
    if (sourceBytes > remaining) {
      const prefix = Buffer.from(source, 'utf8').subarray(0, Math.max(0, remaining)).toString('utf8');
      source = kind === 'stylesheet' ? prefix.slice(0, prefix.lastIndexOf('}') + 1) : prefix.slice(0, prefix.lastIndexOf(';') + 1);
      strip(context, fail(CSS_VIOLATION_CODES.tooLarge, `document CSS exceeds ${CSS_MAX_STYLESHEET_BYTES} bytes`));
    }
    context.rawBytes += Math.min(sourceBytes, Math.max(0, remaining));
    let ast: any;
    try {
      ast = parse(source, { context: kind, positions: false });
    } catch {
      return violationResult(fail(CSS_VIOLATION_CODES.parseError, 'CSS parse failed'));
    }
    try {
      const counts: Counts = { ruleCount: 0, declarationCount: 0 };
      const css = kind === 'stylesheet'
        ? sanitizeNodes(children(ast), context, counts, 0)
        : sanitizeDeclarations(ast, context, counts);
      return isFailure(css)
        ? violationResult(css)
        : { ok: true, css, ruleCount: counts.ruleCount, declarationCount: counts.declarationCount, stripped: context.stripped.slice(strippedStart) };
    } catch {
      return violationResult(fail(CSS_VIOLATION_CODES.internal, 'sanitizer internal failure'));
    }
  } catch {
    return violationResult(fail(CSS_VIOLATION_CODES.internal, 'sanitizer internal failure'));
  }
}

/** Sanitizes model-authored stylesheet rules and scopes them to export content. */
export function sanitizeStylesheet(css: string, context: CssSanitizeContext = createCssSanitizeContext()): CssSanitizeResult {
  return sanitize(css, 'stylesheet', context);
}

/** Sanitizes a style attribute declaration list without adding a selector scope. */
export function sanitizeDeclarationList(css: string, context: CssSanitizeContext = createCssSanitizeContext()): CssSanitizeResult {
  return sanitize(css, 'declarationList', context);
}
