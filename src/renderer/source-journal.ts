import type MarkdownIt from 'markdown-it';

export type ByteInterval = readonly [start: number, end: number];
export type SourceOnlyKind =
  | 'prefix'
  | 'gap'
  | 'fence-delim'
  | 'marker'
  | 'align-row'
  | 'softbreak'
  | 'hardbreak'
  | 'task-marker'
  | 'terminal';
export type SourceOnlySlice = { kind: SourceOnlyKind; span: ByteInterval };
export type ContentRunKind =
  | 'paragraph'
  | 'heading'
  | 'list-item-content'
  | 'quote-paragraph'
  | 'table-cell'
  | 'fence-body'
  | 'deflist-item';
export type DomContentRun = {
  kind: 'content';
  subtype: ContentRunKind;
  runId: number;
  domPath: string;
  sourceSlices: ByteInterval[];
  tokenIndex?: number;
  syntheticIndentPrefixes?: readonly string[];
};
export type JournalInterval = SourceOnlySlice | DomContentRun;
export type MapId = number;

export type NormalizedEdit = {
  inputType: string;
  replacementKind: 'none' | 'text' | 'paste';
  boundary: 'leading' | 'middle' | 'trailing' | 'all';
  boundaryGaps: Array<{ gapId: number; sourceInterval: ByteInterval; role: 'before' | 'between' | 'after' }>;
  range:
    | { kind: 'collapsed'; edge: 'blockStart' | 'blockEnd' | 'interior' }
    | { kind: 'selection'; coverage: 'partial' | 'whole' };
  affected: { beforeIds: MapId[]; afterIds: MapId[]; delta: 'none' | 'add' | 'remove' | 'replace' };
};

export type ClassifyResult =
  | { kind: 'split' }
  | { kind: 'merge' }
  | { kind: 'whole-block-delete'; boundary: NormalizedEdit['boundary'] }
  | { kind: 'multi-selection-replace' }
  | { kind: 'single-block' }
  | { kind: 'rerender'; reason: string };

/** Pure, ordered B1–B6 disposition. */
export function classifyGapDisposition(n: NormalizedEdit): ClassifyResult {
  const { affected } = n;
  if (n.inputType === 'insertParagraph' && n.range.kind === 'collapsed' && affected.delta === 'add' && affected.afterIds.length === affected.beforeIds.length + 1) return { kind: 'split' };
  if (
    n.range.kind === 'collapsed' &&
    ((n.inputType === 'deleteContentBackward' && n.range.edge === 'blockStart') ||
      (n.inputType === 'deleteContentForward' && n.range.edge === 'blockEnd')) &&
    affected.delta === 'remove' &&
    affected.afterIds.length === affected.beforeIds.length - 1
  ) return { kind: 'merge' };
  if (n.range.kind === 'selection' && n.range.coverage === 'whole' && n.replacementKind === 'none' && affected.delta === 'remove') return { kind: 'whole-block-delete', boundary: n.boundary };
  if (n.range.kind === 'selection' && n.replacementKind !== 'none' && n.affected.beforeIds.length >= 2) return { kind: 'multi-selection-replace' };
  if (affected.delta === 'none' && affected.beforeIds.length === 1 && affected.afterIds.length === 1 && affected.beforeIds[0] === affected.afterIds[0]) return { kind: 'single-block' };
  return { kind: 'rerender', reason: 'unsupported-edit-shape' };
}

export type RunTable = {
  runs: DomContentRun[];
  intervals: JournalInterval[];
  source: string;
};

const encoder = new TextEncoder();
function byteLength(value: string): number { return encoder.encode(value).length; }
function byteAt(source: string, index: number): number { return byteLength(source.slice(0, index)); }
function jsAtByte(source: string, target: number): number {
  let bytes = 0;
  for (let i = 0; i < source.length;) {
    if (bytes === target) return i;
    const cp = source.codePointAt(i)!;
    const width = cp > 0xffff ? 2 : 1;
    bytes += byteLength(source.slice(i, i + width));
    if (bytes > target) throw new Error('byte interval splits a code point');
    i += width;
  }
  if (bytes !== target) throw new Error('byte interval outside source');
  return source.length;
}

function byteSpan(source: string, start: number, end: number): ByteInterval { return [byteAt(source, start), byteAt(source, end)]; }
function splitContentSlices(source: string, start: number, end: number, content: string): ByteInterval[] {
  const area = source.slice(start, end);
  const lines = content.split('\n');
  const result: ByteInterval[] = [];
  let cursor = 0;
  for (const originalLine of lines) {
    if (originalLine === '' && cursor >= area.length) continue;
    // Markdown hard-break markers are source-owned leaves, not inline content.
    const line = originalLine.endsWith('  ') ? originalLine.slice(0, -2) : originalLine;
    let found = area.indexOf(line, cursor);
    if (found < 0 && line.trimStart() !== line) found = area.indexOf(line.trimStart(), cursor);
    if (found < 0) return [];
    const actual = area.slice(found, found + line.length) === line ? line : line.trimStart();
    result.push(byteSpan(source, start + found, start + found + actual.length));
    cursor = found + actual.length;
    if (area[cursor] === '\n') cursor += 1;
  }
  return result;
}

function subtypeFor(tokens: ReturnType<MarkdownIt['parse']>, index: number): ContentRunKind | null {
  const token = tokens[index];
  if (token.type === 'fence' || token.type === 'code_block') return 'fence-body';
  if (token.type !== 'inline') return null;
  for (let i = index - 1; i >= 0; i--) {
    const previous = tokens[i];
    if (previous.level > token.level) continue;
    if (previous.type === 'heading_open') return 'heading';
    if (previous.type === 'td_open' || previous.type === 'th_open') return 'table-cell';
    if (previous.type === 'dd_open') return 'deflist-item';
    if (previous.type === 'list_item_open') return 'list-item-content';
    if (previous.type === 'blockquote_open') return 'quote-paragraph';
    if (previous.type === 'paragraph_open') return 'paragraph';
  }
  return 'paragraph';
}

function tokenSourceRange(source: string, token: ReturnType<MarkdownIt['parse']>[number]): [number, number] | null {
  if (!token.map) return null;
  const lines = source.match(/.*(?:\n|$)/g) ?? [];
  const starts: number[] = [];
  let position = 0;
  for (const line of lines) { starts.push(position); position += line.length; }
  const start = starts[token.map[0]];
  const end = token.map[1] < starts.length ? starts[token.map[1]] : source.length;
  return start == null ? null : [start, end];
}

/** Builds content ownership from the same token array that is rendered. */
export function buildRunTable(tokens: ReturnType<MarkdownIt['parse']>, source: string): { runTable: RunTable; sourceOnly: SourceOnlySlice[] } {
  const runs: DomContentRun[] = [];
  let nextId = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const subtype = subtypeFor(tokens, i);
    const range = tokenSourceRange(source, token);
    if (!subtype || !range || (!token.content && token.type !== 'inline')) continue;
    let slices: ByteInterval[];
    let syntheticIndentPrefixes: string[] | undefined;
    if (token.type === 'fence') {
      const openingEnd = source.indexOf('\n', range[0]);
      const closeStart = source.lastIndexOf('\n', range[1] - 1);
      const bodyStart = openingEnd < 0 ? range[1] : openingEnd + 1;
      const bodyEnd = closeStart > bodyStart && /^\s*(```|~~~)/.test(source.slice(closeStart + 1, range[1])) ? closeStart + 1 : range[1];
      slices = [byteSpan(source, bodyStart, bodyEnd)];
    } else if (token.type === 'code_block') {
      const area = source.slice(range[0], range[1]);
      slices = [];
      syntheticIndentPrefixes = [];
      let offset = range[0];
      const parsedLines = token.content.split('\n').filter((line, index, all) => line !== '' || index < all.length - 1);
      for (let lineIndex = 0; lineIndex < parsedLines.length; lineIndex++) {
        const rawLine = area.split(/(?<=\n)/)[lineIndex] ?? '';
        const line = rawLine.endsWith('\n') ? rawLine.slice(0, -1) : rawLine;
        const parsed = parsedLines[lineIndex];
        const literal = parsed.trimStart();
        const found = literal === '' ? line.length : line.lastIndexOf(literal);
        if (found < 0) { slices = []; break; }
        syntheticIndentPrefixes.push(parsed.slice(0, parsed.length - literal.length));
        slices.push(byteSpan(source, offset + found, offset + found + literal.length));
        offset += rawLine.length;
      }
    } else {
      slices = splitContentSlices(source, range[0], range[1], token.content);
    }
    if (slices.length === 0) continue;
    runs.push({ kind: 'content', subtype, runId: nextId++, domPath: '', sourceSlices: slices, tokenIndex: i, syntheticIndentPrefixes });
  }
  const covered = runs.flatMap((run) => run.sourceSlices).sort((a, b) => a[0] - b[0]);
  const sourceOnly: SourceOnlySlice[] = [];
  let cursor = 0;
  for (const span of covered) {
    if (cursor < span[0]) sourceOnly.push({ kind: source.slice(jsAtByte(source, cursor), jsAtByte(source, span[0])).includes('\n\n') ? 'gap' : 'prefix', span: [cursor, span[0]] });
    cursor = span[1];
  }
  const total = byteLength(source);
  if (cursor < total) sourceOnly.push({ kind: source.endsWith('\n') ? 'terminal' : 'prefix', span: [cursor, total] });
  const intervals: JournalInterval[] = [...sourceOnly, ...runs].sort((a, b) => (a.kind === 'content' ? a.sourceSlices[0][0] : a.span[0]) - (b.kind === 'content' ? b.sourceSlices[0][0] : b.span[0]));
  return { runTable: { runs, intervals, source }, sourceOnly };
}

export function injectRunIds(tokens: ReturnType<MarkdownIt['parse']>, runTable: RunTable): void {
  for (const run of runTable.runs) {
    if (run.tokenIndex == null) continue;
    const token = tokens[run.tokenIndex];
    token.meta = { ...(token.meta ?? {}), runId: run.runId };
    // Inline tokens cannot emit attributes. Their nearest block opener is tagged.
    if (token.type !== 'inline') continue;
    for (let i = run.tokenIndex - 1; i >= 0; i--) {
      if (tokens[i].nesting === 1 && tokens[i].tag) {
        tokens[i].attrSet('data-run-id', String(run.runId));
        tokens[i].attrSet('data-source-slice-count', String(run.sourceSlices.length));
        break;
      }
    }
  }
}

export type SerializedRun = { runId: number; segments: readonly string[] };
export function assembleSource(runTable: RunTable, changed: readonly SerializedRun[]): string {
  const byId = new Map(changed.map((entry) => [entry.runId, entry.segments]));
  let output = '';
  let cursor = 0;
  for (const run of runTable.runs) {
    const replacement = byId.get(run.runId);
    for (let i = 0; i < run.sourceSlices.length; i++) {
      const [start, end] = run.sourceSlices[i];
      output += runTable.source.slice(jsAtByte(runTable.source, cursor), jsAtByte(runTable.source, start));
      output += replacement ? replacement[i] : runTable.source.slice(jsAtByte(runTable.source, start), jsAtByte(runTable.source, end));
      cursor = end;
    }
  }
  output += runTable.source.slice(jsAtByte(runTable.source, cursor));
  return output;
}
