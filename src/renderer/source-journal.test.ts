// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { serializeChangedRun } from './fragment-serialize';
import { classifyGapDisposition, assembleSource, buildRunTable, type NormalizedEdit } from './source-journal';
import { createMarkdownIt } from './markdown-it';

function table(source: string) {
  const md = createMarkdownIt();
  return buildRunTable(md.parse(source, {}), source).runTable;
}

function replaceLast(source: string, value: string): string {
  const runTable = table(source);
  const run = runTable.runs.at(-1)!;
  return assembleSource(runTable, [{
    runId: run.runId,
    segments: run.sourceSlices.map((span, index) => index === run.sourceSlices.length - 1 ? value : source.slice(span[0], span[1])),
  }]);
}

describe('source journal golden assembly', () => {
  it('preserves quote prefixes and terminal bytes', () => {
    expect(replaceLast('> first\n> second\n', 'second!')).toBe('> first\n> second!\n');
  });
  it('preserves indented code without an invented terminal newline', () => {
    expect(replaceLast('    a\n    b', 'b!')).toBe('    a\n    b!');
  });
  it('preserves nested partial-tab prefixes', () => {
    expect(replaceLast('> \t\ta', 'a!')).toBe('> \t\ta!');
  });
  it('preserves ordered-list marker and loose-list gap', () => {
    expect(replaceLast('1. first\n\n2. second\n', 'second!')).toBe('1. first\n\n2. second!\n');
  });
});

describe('gap classifier', () => {
  const base: NormalizedEdit = {
    inputType: 'insertText', replacementKind: 'text', boundary: 'middle', boundaryGaps: [],
    range: { kind: 'collapsed', edge: 'interior' },
    affected: { beforeIds: [1], afterIds: [1], delta: 'none' },
  };
  it('selects exactly one B branch for the supported single block edit', () => {
    expect(classifyGapDisposition(base)).toEqual({ kind: 'single-block' });
  });
  it('rejects unsupported edit shapes instead of silently converting the document', () => {
    expect(classifyGapDisposition({ ...base, affected: { beforeIds: [1], afterIds: [2], delta: 'replace' } })).toMatchObject({ kind: 'rerender' });
  });
});

describe('fragment serializer', () => {
  it('keeps soft breaks as source-owned segment boundaries', () => {
    const p = document.createElement('p');
    p.dataset.sourceSliceCount = '2';
    p.append('first');
    p.append(document.createElement('br'));
    p.append('second!');
    expect(serializeChangedRun('paragraph', p)).toEqual({ kind: 'segments', segments: ['first', 'second!'] });
  });
  it('fails narrowly when synthetic indent is edited', () => {
    const pre = document.createElement('pre');
    pre.dataset.sourceSliceCount = '1';
    pre.dataset.syntheticIndentPrefixes = JSON.stringify(['  ']);
    pre.textContent = 'a';
    expect(serializeChangedRun('fence-body', pre)).toEqual({ kind: 'rerender', reason: 'synthetic-indent-prefix-mutated' });
  });
});
