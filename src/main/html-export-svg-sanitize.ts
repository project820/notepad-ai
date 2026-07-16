import { html, type DefaultTreeAdapterTypes } from 'parse5';
import { cssRejectedCode } from './html-export-css-sanitize';

export const SVG_NAMESPACE = html.NS.SVG;
export const SVG_ATTRIBUTE_MAX_BYTES = 128 * 1024;

export type SvgViolationCode =
  | 'html_active_tag'
  | 'html_reserved_namespace'
  | 'html_event_handler'
  | 'html_url'
  | 'html_svg_rejected'
  | ReturnType<typeof cssRejectedCode<'svg_attribute'>>;

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;
type Attribute = Element['attrs'][number];
type ParentNode = DefaultTreeAdapterTypes.ParentNode;
type SvgFailure = { violation: { code: SvgViolationCode; detail: string } };
type SvgPlanNode = {
  tag: string;
  attrs: Attribute[];
  children: SvgPlanNodeChild[];
};
type SvgPlanNodeChild = SvgPlanNode | { text: string };
type UseReference = { href: string };

export type SvgRootPlan = SvgPlanNode;
export type SvgPreflightResult = {
  ok: boolean;
  plans: Map<Node, SvgRootPlan>;
  stripped: SvgViolationCode[];
  violation?: { code: SvgViolationCode; detail: string };
};

const ACTIVE_SVG_TAGS = new Set([
  'script', 'foreignobject', 'image', 'style', 'animate', 'set', 'animatemotion', 'animatetransform',
  'animatecolor', 'discard', 'audio', 'video', 'iframe', 'canvas',
]);
const LEAF_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'use']);
const USE_TARGET_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text']);
const PRESENTATION = new Set([
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap',
  'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'opacity', 'vector-effect',
]);
const TEXT_PRESENTATION = new Set(['font-size', 'font-weight', 'text-anchor', 'dominant-baseline']);
const NUMBER = /^[+-]?(?:(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?|\.[0-9]{1,6})$/;
const NON_NEGATIVE = new Set(['width', 'height', 'r', 'rx', 'ry', 'pathLength', 'font-size', 'stroke-width']);
const ATTRIBUTE_CANONICAL = new Map([
  ['viewbox', 'viewBox'], ['preserveaspectratio', 'preserveAspectRatio'], ['fill', 'fill'],
  ['fill-opacity', 'fill-opacity'], ['fill-rule', 'fill-rule'], ['stroke', 'stroke'], ['stroke-width', 'stroke-width'],
  ['stroke-opacity', 'stroke-opacity'], ['stroke-linecap', 'stroke-linecap'], ['stroke-linejoin', 'stroke-linejoin'],
  ['stroke-miterlimit', 'stroke-miterlimit'], ['stroke-dasharray', 'stroke-dasharray'],
  ['stroke-dashoffset', 'stroke-dashoffset'], ['opacity', 'opacity'], ['vector-effect', 'vector-effect'],
  ['transform', 'transform'], ['font-size', 'font-size'], ['font-weight', 'font-weight'],
  ['text-anchor', 'text-anchor'], ['dominant-baseline', 'dominant-baseline'], ['pathlength', 'pathLength'],
  ['id', 'id'], ['d', 'd'], ['x', 'x'], ['y', 'y'], ['x1', 'x1'], ['y1', 'y1'], ['x2', 'x2'], ['y2', 'y2'],
  ['cx', 'cx'], ['cy', 'cy'], ['dx', 'dx'], ['dy', 'dy'], ['width', 'width'], ['height', 'height'],
  ['r', 'r'], ['rx', 'rx'], ['ry', 'ry'], ['points', 'points'], ['href', 'href'],
  ['role', 'role'], ['aria-label', 'aria-label'], ['aria-hidden', 'aria-hidden'],
]);

const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/';
const SVG_XMLNS_VALUE = 'http://www.w3.org/2000/svg';

/**
 * parse5 marks a bare `xmlns="http://www.w3.org/2000/svg"` with
 * namespace=xmlns/. Models routinely emit that default declaration on <svg>.
 * It is not a foreign/xlink attribute; drop it during planning (SVG namespace is
 * already implied by the element) instead of hard-failing the whole document.
 */
function isIgnorableSvgXmlnsDeclaration(attribute: Attribute): boolean {
  if (attribute.name.toLowerCase() !== 'xmlns') return false;
  if ((attribute.prefix ?? '') !== '') return false;
  if (attribute.namespace != null && attribute.namespace !== XMLNS_NAMESPACE) return false;
  return attribute.value === SVG_XMLNS_VALUE;
}

function fail(code: SvgViolationCode, detail: string): SvgFailure {
  return { violation: { code, detail } };
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

function localName(node: Node): string | null {
  const name = (node as { tagName?: unknown }).tagName;
  return typeof name === 'string' ? name : null;
}

function lowerName(node: Node): string | null {
  const name = localName(node);
  return name?.toLowerCase() ?? null;
}

function textValue(node: Node): string {
  const value = (node as { value?: unknown }).value;
  return typeof value === 'string' ? value : '';
}

function isElement(node: Node): node is Element {
  return localName(node) !== null;
}

function isWhitespace(value: string): boolean {
  return /^[\t\n\f\r ]*$/.test(value);
}

function parseNumber(value: string): number | null {
  if (!NUMBER.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= 1_000_000 ? number : null;
}

function isWhitespaceCharacter(value: string | undefined): boolean {
  return value === '\t' || value === '\n' || value === '\f' || value === '\r' || value === ' ';
}

function scanNumberEnd(value: string, start: number, end = value.length): number | null {
  let index = start;
  if (value[index] === '+' || value[index] === '-') index++;
  if (index === end) return null;

  if (value[index] === '.') {
    index++;
    const fractionStart = index;
    while (index < end && /[0-9]/.test(value[index])) index++;
    return index - fractionStart >= 1 && index - fractionStart <= 6 ? index : null;
  }

  if (value[index] === '0') {
    index++;
  } else if (/[1-9]/.test(value[index] ?? '')) {
    index++;
    while (index < end && /[0-9]/.test(value[index])) index++;
  } else {
    return null;
  }

  if (value[index] !== '.') return index;
  index++;
  const fractionStart = index;
  while (index < end && /[0-9]/.test(value[index])) index++;
  return index - fractionStart >= 1 && index - fractionStart <= 6 ? index : null;
}

function parseNumberList(value: string, maxTokens: number, start = 0, end = value.length): string[] | null {
  const tokens: string[] = [];
  let index = start;
  while (index < end) {
    const tokenEnd = scanNumberEnd(value, index, end);
    if (tokenEnd === null) return null;
    const token = value.slice(index, tokenEnd);
    if (parseNumber(token) === null || tokens.length === maxTokens) return null;
    tokens.push(token);
    index = tokenEnd;
    if (index === end) break;

    let whitespace = false;
    while (isWhitespaceCharacter(value[index])) {
      whitespace = true;
      index++;
    }
    if (value[index] === ',') {
      index++;
      while (isWhitespaceCharacter(value[index])) index++;
    } else if (!whitespace) {
      return null;
    }
    if (index === end || value[index] === ',') return null;
  }
  return tokens;
}

function validateNumber(value: string, nonNegative = false): boolean {
  const number = parseNumber(value);
  return number !== null && (!nonNegative || number >= 0);
}

function validateViewBox(value: string): boolean {
  const tokens = parseNumberList(value, 4);
  return tokens?.length === 4 && Number(tokens[2]) > 0 && Number(tokens[3]) > 0;
}

function validatePaint(value: string): boolean {
  return value === 'none' || /^#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/.test(value);
}

function validateOpacity(value: string): boolean {
  const number = parseNumber(value);
  return number !== null && number >= 0 && number <= 1;
}

function validatePoints(value: string): boolean {
  const tokens = parseNumberList(value, 4096);
  return tokens !== null && tokens.length >= 4 && tokens.length % 2 === 0;
}

type PathToken = { kind: 'command'; value: string } | { kind: 'number'; value: string };

function tokenizePath(value: string): PathToken[] | null {
  const tokens: PathToken[] = [];
  let index = 0;
  let previous: 'start' | 'command' | 'number' | 'comma' = 'start';
  while (index < value.length) {
    while (isWhitespaceCharacter(value[index])) index++;
    if (index === value.length) break;

    if (value[index] === ',') {
      if (previous !== 'number') return null;
      previous = 'comma';
      index++;
      continue;
    }

    const command = value[index];
    if (command && 'MmZzLlHhVvCcSsQqTtAa'.includes(command)) {
      if (previous === 'comma' || tokens.length === 4096) return null;
      tokens.push({ kind: 'command', value: command });
      previous = 'command';
      index++;
      continue;
    }

    const tokenEnd = scanNumberEnd(value, index);
    if (tokenEnd === null || tokens.length === 4096) return null;
    const token = value.slice(index, tokenEnd);
    if (parseNumber(token) === null) return null;
    tokens.push({ kind: 'number', value: token });
    previous = 'number';
    index = tokenEnd;
  }
  return previous === 'comma' ? null : tokens;
}

function validatePath(value: string): boolean {
  const tokens = tokenizePath(value);
  if (!tokens?.length || tokens[0].kind !== 'command' || !/[Mm]/.test(tokens[0].value)) return false;
  const arity: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7 };
  let index = 0;
  while (index < tokens.length) {
    const command = tokens[index++];
    if (command.kind !== 'command') return false;
    const upper = command.value.toUpperCase();
    if (upper === 'Z') continue;
    const values: string[] = [];
    while (index < tokens.length && tokens[index].kind === 'number') values.push(tokens[index++].value);
    const required = arity[upper];
    if (!required || values.length < required || values.length % required !== 0) return false;
    if (upper === 'A') {
      for (let offset = 0; offset < values.length; offset += 7) {
        if (Number(values[offset]) < 0 || Number(values[offset + 1]) < 0 || !/^[01]$/.test(values[offset + 3]) || !/^[01]$/.test(values[offset + 4])) return false;
      }
    }
  }
  return true;
}

function validateTransform(value: string): boolean {
  const expected: Record<string, number[]> = {
    matrix: [6], translate: [1, 2], scale: [1, 2], rotate: [1, 3], skewX: [1], skewY: [1],
  };
  const names = Object.keys(expected);
  let index = 0;
  let count = 0;
  while (index < value.length) {
    while (isWhitespaceCharacter(value[index])) index++;
    if (index === value.length) break;

    const name = names.find((candidate) => value.startsWith(`${candidate}(`, index));
    if (!name) return false;
    index += name.length + 1;
    const close = value.indexOf(')', index);
    if (close < 0) return false;
    const values = parseNumberList(value, 6, index, close);
    if (!values || !expected[name].includes(values.length)) return false;
    index = close + 1;

    let separator = false;
    while (isWhitespaceCharacter(value[index])) {
      separator = true;
      index++;
    }
    if (value[index] === ',') {
      separator = true;
      index++;
      while (isWhitespaceCharacter(value[index])) index++;
      if (index === value.length) return false;
    }
    if (index < value.length && !separator) return false;
    count++;
    if (count > 32) return false;
  }
  return count > 0;
}

function isCssHexDigit(character: string): boolean {
  const code = character.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
}

function isCssNameCharacter(character: string): boolean {
  const code = character.codePointAt(0);
  return code !== undefined && (code >= 0x80 || character === '-' || character === '_' || (
    code >= 48 && code <= 57
  ) || (
    code >= 65 && code <= 90
  ) || (
    code >= 97 && code <= 122
  ));
}

function skipCssComment(value: string, start: number): number {
  let index = start + 2;
  while (index + 1 < value.length && (value[index] !== '*' || value[index + 1] !== '/')) index++;
  return index + 1 < value.length ? index + 2 : value.length;
}

function readCssEscape(value: string, start: number): { character: string | null; next: number } | null {
  let index = start + 1;
  if (index >= value.length) return null;
  if (value[index] === '\n' || value[index] === '\f') return { character: null, next: index + 1 };
  if (value[index] === '\r') return { character: null, next: value[index + 1] === '\n' ? index + 2 : index + 1 };

  if (!isCssHexDigit(value[index])) return { character: value[index], next: index + 1 };

  let codePoint = 0;
  let digits = 0;
  while (index < value.length && digits < 6 && isCssHexDigit(value[index])) {
    codePoint = (codePoint * 16) + Number.parseInt(value[index], 16);
    index++;
    digits++;
  }
  if (isWhitespaceCharacter(value[index])) index++;
  return {
    character: codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ? '\uFFFD'
      : String.fromCodePoint(codePoint),
    next: index,
  };
}

function startsCssIdentifier(value: string, index: number): boolean {
  if (index >= value.length) return false;
  if (value[index] !== '\\') return isCssNameCharacter(value[index]);
  const escape = readCssEscape(value, index);
  return escape !== null && escape.character !== null;
}

type CssIdentifierScan = { end: number; matches: boolean; resume: number | null };

function scanCssIdentifier(value: string, start: number, expected: string): CssIdentifierScan {
  let index = start;
  let length = 0;
  let matches = true;
  let resume: number | null = null;

  while (index < value.length) {
    if (value[index] === '/' && value[index + 1] === '*') {
      const next = skipCssComment(value, index);
      if (!matches) return { end: next, matches: false, resume: resume ?? next };
      if (resume === null) resume = next;
      index = next;
      continue;
    }

    let character: string;
    if (value[index] === '\\') {
      const escape = readCssEscape(value, index);
      if (!escape) break;
      index = escape.next;
      if (escape.character === null) continue;
      character = escape.character;
    } else {
      if (!isCssNameCharacter(value[index])) break;
      character = value[index++];
    }

    if (length >= expected.length || asciiLowercase(character) !== expected[length]) matches = false;
    length++;
  }

  return { end: index, matches: matches && length === expected.length, resume };
}

function asciiLowercase(character: string): string {
  const code = character.charCodeAt(0);
  return code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : character;
}

function skipCssWhitespaceAndComments(value: string, start: number): number {
  let index = start;
  while (index < value.length) {
    if (isWhitespaceCharacter(value[index])) {
      index++;
      continue;
    }
    if (value[index] === '/' && value[index + 1] === '*') {
      index = skipCssComment(value, index);
      continue;
    }
    break;
  }
  return index;
}

function skipCssString(value: string, start: number): number {
  const quote = value[start];
  let index = start + 1;
  while (index < value.length) {
    if (value[index] === quote) return index + 1;
    if (value[index] === '\\') {
      const escape = readCssEscape(value, index);
      index = escape ? escape.next : index + 1;
      continue;
    }
    index++;
  }
  return index;
}

function hasCssUrlOrImport(value: string): boolean {
  let index = 0;
  while (index < value.length) {
    if (value[index] === '/' && value[index + 1] === '*') {
      index = skipCssComment(value, index);
      continue;
    }
    if (value[index] === '"' || value[index] === "'") {
      index = skipCssString(value, index);
      continue;
    }
    if (value[index] === '@' && startsCssIdentifier(value, index + 1)) {
      const identifier = scanCssIdentifier(value, index + 1, 'import');
      if (identifier.matches) return true;
      index = identifier.resume ?? identifier.end;
      continue;
    }
    if (startsCssIdentifier(value, index)) {
      const identifier = scanCssIdentifier(value, index, 'url');
      if (identifier.matches && value[skipCssWhitespaceAndComments(value, identifier.end)] === '(') return true;
      index = identifier.resume ?? identifier.end;
      continue;
    }
    index++;
  }
  return false;
}

function allowedAttributes(tag: string): Set<string> {
  const output = new Set<string>();
  const add = (...names: string[]) => names.forEach((name) => output.add(name));
  if (tag === 'svg') add('width', 'height', 'viewBox', 'preserveAspectRatio', 'role', 'aria-label', 'aria-hidden', ...PRESENTATION);
  if (tag === 'g') add('transform', ...PRESENTATION);
  if (tag === 'path') add('id', 'd', 'pathLength', 'transform', ...PRESENTATION);
  if (tag === 'rect') add('id', 'x', 'y', 'width', 'height', 'rx', 'ry', 'pathLength', 'transform', ...PRESENTATION);
  if (tag === 'circle') add('id', 'cx', 'cy', 'r', 'pathLength', 'transform', ...PRESENTATION);
  if (tag === 'ellipse') add('id', 'cx', 'cy', 'rx', 'ry', 'pathLength', 'transform', ...PRESENTATION);
  if (tag === 'line') add('id', 'x1', 'y1', 'x2', 'y2', 'pathLength', 'transform', ...PRESENTATION);
  if (tag === 'polyline' || tag === 'polygon') add('id', 'points', 'pathLength', 'transform', ...PRESENTATION);
  if (tag === 'text') add('id', 'x', 'y', 'dx', 'dy', 'transform', ...PRESENTATION, ...TEXT_PRESENTATION);
  if (tag === 'tspan') add('x', 'y', 'dx', 'dy', ...PRESENTATION, ...TEXT_PRESENTATION);
  if (tag === 'use') add('href', 'x', 'y', 'width', 'height', 'transform', ...PRESENTATION);
  return output;
}

function allowedChild(parent: string, child: string): boolean {
  const children: Record<string, Set<string>> = {
    svg: new Set(['g', 'defs', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'use', 'title', 'desc']),
    g: new Set(['g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'use', 'title', 'desc']),
    defs: new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'title', 'desc']),
    text: new Set(['tspan']),
  };
  return children[parent]?.has(child) === true;
}

function validateAttributeValue(tag: string, name: string, value: string, isReservedValue: (value: string) => boolean): boolean {
  if (name === 'id') return !isReservedValue(value);
  if (name === 'd') return validatePath(value);
  if (name === 'points') return validatePoints(value);
  if (name === 'transform') return validateTransform(value);
  if (name === 'viewBox') return validateViewBox(value);
  if (name === 'preserveAspectRatio') return value === 'none' || /^(?:xMin|xMid|xMax)(?:YMin|YMid|YMax)(?: (?:meet|slice))?$/.test(value);
  if (name === 'fill' || name === 'stroke') return validatePaint(value);
  if (name === 'fill-opacity' || name === 'stroke-opacity' || name === 'opacity') return validateOpacity(value);
  if (name === 'fill-rule') return value === 'nonzero' || value === 'evenodd';
  if (name === 'stroke-linecap') return value === 'butt' || value === 'round' || value === 'square';
  if (name === 'stroke-linejoin') return value === 'miter' || value === 'round' || value === 'bevel';
  if (name === 'vector-effect') return value === 'none' || value === 'non-scaling-stroke';
  if (name === 'font-weight') return /^(?:normal|bold|[1-9]00)$/.test(value);
  if (name === 'text-anchor') return value === 'start' || value === 'middle' || value === 'end';
  if (name === 'dominant-baseline') return ['auto', 'alphabetic', 'central', 'middle', 'hanging'].includes(value);
  if (name === 'stroke-dasharray') {
    const values = value === 'none' ? [] : parseNumberList(value, 32);
    return value === 'none' || (values !== null && values.length >= 1 && values.every((token) => Number(token) >= 0));
  }
  if (name === 'stroke-dashoffset') return validateNumber(value);
  if (name === 'stroke-miterlimit') return validateNumber(value) && Number(value) >= 1;
  if (name === 'role') return value === 'img';
  if (name === 'aria-hidden') return value === 'true' || value === 'false';
  if (name === 'aria-label') return Array.from(value).length >= 1 && Array.from(value).length <= 512 && !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/.test(value);
  if (NON_NEGATIVE.has(name)) return validateNumber(value, true);
  return ['x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'dx', 'dy'].includes(name) ? validateNumber(value) : true;
}

function collectDocumentIdCounts(root: Node): Map<string, number> {
  const ids = new Map<string, number>();
  const visit = (node: Node): void => {
    for (const attribute of attrs(node)) {
      if (attribute.name.toLowerCase() === 'id') ids.set(attribute.value, (ids.get(attribute.value) ?? 0) + 1);
    }
    for (const child of childNodes(node)) visit(child);
  };
  visit(root);
  return ids;
}

function nodeName(node: Node): string {
  return typeof (node as { nodeName?: unknown }).nodeName === 'string' ? (node as { nodeName: string }).nodeName : '';
}

function validateRoot(
  root: Element,
  idCounts: Map<string, number>,
  isReservedValue: (value: string) => boolean,
  stripped: SvgViolationCode[],
): SvgRootPlan | SvgFailure {
  const ids = new Map<string, SvgPlanNode>();
  const uses: UseReference[] = [];
  const visit = (node: Node, parent: string | null, rootNode: boolean): SvgPlanNode | SvgFailure => {
    if (!isElement(node) || node.namespaceURI !== SVG_NAMESPACE) return fail('html_reserved_namespace', 'foreign namespace in SVG subtree');
    const rawTag = localName(node);
    const tag = rawTag?.toLowerCase();
    if (!rawTag || !tag) return fail('html_svg_rejected', 'SVG element has no local name');
    if (ACTIVE_SVG_TAGS.has(tag)) return fail('html_active_tag', `active SVG tag ${rawTag}`);
    if (tag === 'math') return fail('html_reserved_namespace', 'foreign namespace in SVG subtree');
    if (tag === 'svg' && !rootNode) return fail('html_svg_rejected', 'nested svg is not allowed');
    if (!['svg', 'g', 'defs', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'use', 'title', 'desc'].includes(tag)) {
      return fail('html_svg_rejected', `SVG tag ${rawTag} is not allowed`);
    }
    if (!rootNode && (!parent || !allowedChild(parent, tag))) return fail('html_svg_rejected', `SVG child ${rawTag} is not allowed in ${parent}`);
    if (tag === 'defs' && parent !== 'svg') return fail('html_svg_rejected', 'defs must be a direct svg child');

    const outputAttrs: Attribute[] = [];
    const seen = new Set<string>();
    // Drop the routine default SVG xmlns declaration parse5 marks as namespaced.
    const sourceAttrs = attrs(node).filter((attribute) => !isIgnorableSvgXmlnsDeclaration(attribute));
    const rejectAttribute = (code: SvgViolationCode): void => {
      stripped.push(code);
    };
    for (const attribute of sourceAttrs) {
      const rawName = attribute.name.toLowerCase();
      if (rawName.startsWith('on')) {
        rejectAttribute('html_event_handler');
        continue;
      }
      // Reject real foreign prefixes/namespaces (xlink:, xml:, custom). Empty-string
      // prefix alone is not enough evidence of a foreign attr after xmlns filtering.
      if ((attribute.namespace != null && attribute.namespace !== '') || (attribute.prefix != null && attribute.prefix !== '')) {
        rejectAttribute('html_reserved_namespace');
        continue;
      }
      if (Buffer.byteLength(attribute.value, 'utf8') > SVG_ATTRIBUTE_MAX_BYTES) {
        rejectAttribute('html_svg_rejected');
        continue;
      }
      const canonical = ATTRIBUTE_CANONICAL.get(rawName);
      if (canonical === 'href' && (!/^#[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(attribute.value) || tag !== 'use')) {
        rejectAttribute('html_url');
        continue;
      }
      if (hasCssUrlOrImport(attribute.value) || rawName === 'style') {
        rejectAttribute(cssRejectedCode('svg_attribute'));
        continue;
      }
      const allowed = allowedAttributes(tag);
      if (!canonical || !allowed.has(canonical) || seen.has(canonical)) {
        rejectAttribute('html_svg_rejected');
        continue;
      }
      if (!validateAttributeValue(tag, canonical, attribute.value, isReservedValue)) {
        rejectAttribute('html_svg_rejected');
        continue;
      }
      seen.add(canonical);
      outputAttrs.push({ name: canonical, value: attribute.value });
    }
    if (tag === 'use') {
      const href = outputAttrs.find((attribute) => attribute.name === 'href')?.value;
      if (!href || outputAttrs.filter((attribute) => attribute.name === 'href').length !== 1) return fail('html_svg_rejected', 'use requires exactly one href');
    }

    const plan: SvgPlanNode = { tag, attrs: outputAttrs, children: [] };
    const id = outputAttrs.find((attribute) => attribute.name === 'id')?.value;
    if (id) ids.set(id, plan);
    if (tag === 'use') uses.push({ href: outputAttrs.find((attribute) => attribute.name === 'href')!.value });
    for (const child of childNodes(node)) {
      const childName = nodeName(child);
      if (childName === '#comment') continue;
      if (childName === '#text') {
        const value = textValue(child);
        if (tag === 'text' || tag === 'tspan' || tag === 'title' || tag === 'desc') plan.children.push({ text: value });
        else if (!isWhitespace(value)) return fail('html_svg_rejected', `text is not allowed in ${rawTag}`);
        continue;
      }
      if (!isElement(child)) return fail('html_svg_rejected', `unexpected node in ${rawTag}`);
      if (LEAF_TAGS.has(tag) || tag === 'tspan' || tag === 'title' || tag === 'desc') return fail('html_svg_rejected', `children are not allowed in ${rawTag}`);
      const childPlan = visit(child, tag, false);
      if ('violation' in childPlan) return childPlan;
      plan.children.push(childPlan);
    }
    return plan;
  };

  const plan = visit(root, null, true);
  if ('violation' in plan) return plan;
  for (const use of uses) {
    const targetId = use.href.slice(1);
    const target = ids.get(targetId);
    if (!target || idCounts.get(targetId) !== 1 || !USE_TARGET_TAGS.has(target.tag)) {
      return fail('html_svg_rejected', 'use href must reference a unique same-root leaf');
    }
  }
  return plan;
}

/** Preflights all SVG roots before generic HTML/CSS handling. */
export function preflightSvgSubtrees(root: Node, isReservedValue: (value: string) => boolean): SvgPreflightResult {
  const plans = new Map<Node, SvgRootPlan>();
  const stripped: SvgViolationCode[] = [];
  const idCounts = collectDocumentIdCounts(root);
  const visit = (node: Node): void => {
    const name = lowerName(node);
    if (name === 'svg') {
      if ((node as Element).namespaceURI !== SVG_NAMESPACE) {
        stripped.push('html_reserved_namespace');
        return;
      }
      const plan = validateRoot(node as Element, idCounts, isReservedValue, stripped);
      if ('violation' in plan) {
        stripped.push(plan.violation.code);
        return;
      }
      plans.set(node, plan);
      return;
    }
    for (const child of childNodes(node)) visit(child);
  };
  visit(root);
  return {
    ok: stripped.length === 0,
    plans,
    stripped,
    ...(stripped.length > 0 ? { violation: { code: stripped[0], detail: 'stripped SVG surface' } } : {}),
  };
}

function makeText(value: string, parentNode: ParentNode | null): DefaultTreeAdapterTypes.TextNode {
  return { nodeName: '#text', value, parentNode };
}

function reconstructNode(plan: SvgPlanNode, parentNode: ParentNode | null): Element {
  const output: Element = {
    nodeName: plan.tag,
    tagName: plan.tag,
    attrs: plan.attrs.map((attribute) => ({ name: attribute.name, value: attribute.value })),
    namespaceURI: SVG_NAMESPACE,
    parentNode,
    childNodes: [],
  };
  output.childNodes = plan.children.map((child) => 'text' in child
    ? makeText(child.text, output)
    : reconstructNode(child, output)) as DefaultTreeAdapterTypes.ChildNode[];
  return output;
}

/** Reconstructs a preflighted SVG plan without invoking HTML or CSS sanitization. */
export function reconstructSvgRoot(plan: SvgRootPlan, parentNode: ParentNode | null): Element {
  return reconstructNode(plan, parentNode);
}
