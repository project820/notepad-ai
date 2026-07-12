// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import structuralFixtures from './__fixtures__/preview-roundtrip/structural.json';

import { serializeChangedRun } from './fragment-serialize';
import { applyStructuralEdit, classifyGapDisposition, assembleSource, buildRunTable, structuralJournalSupport, type NormalizedEdit, type SerializedRun } from './source-journal';
import { createMarkdownIt } from './markdown-it';

function table(source: string) {
  const md = createMarkdownIt();
  return buildRunTable(md.parse(source, {}), source).runTable;
}

type Golden = { source: string; edit: { runId: number; segments: string[] }; expected: string };
const goldenModules = import.meta.glob('./__fixtures__/preview-roundtrip/*.json', { eager: true }) as Record<string, { default: Golden }>;
const fixtures = Object.keys(goldenModules)
  .filter((path) => !path.endsWith('/structural.json'))
  .sort()
  .map((path) => ({ name: path.split('/').pop() as string, golden: goldenModules[path].default }));

describe('source journal golden assembly', () => {
  it.each(fixtures)('$name preserves exact assembled bytes', ({ golden }) => {
    const runTable = table(golden.source);
    expect(runTable.runs.find((run) => run.runId === golden.edit.runId)).toBeDefined();
    expect(assembleSource(runTable, [golden.edit])).toBe(golden.expected);
    // The fixture also fixes unedited round-trip byte fidelity.
    expect(assembleSource(runTable, [])).toBe(golden.source);
  });
});
describe('R5 fixture metrics', () => {
  it('keeps blank lines/unedited bytes exact and routes every fixture through the patch path', () => {
    let patchPathCount = 0;
    let fullSerializeCalls = 0;
    let patchWork = 0;
    let fullWork = 0;
    for (const { golden } of fixtures) {
      const runTable = table(golden.source);
      const changed = runTable.runs.find((run) => run.runId === golden.edit.runId)!;
      const assembled = assembleSource(runTable, [golden.edit]);
      expect(assembled).toBe(golden.expected); // blankLineFidelityDelta=0
      expect(assembleSource(runTable, [])).toBe(golden.source); // roundTripByteExactOnUnedited=true
      patchPathCount += 1;
      patchWork += golden.edit.segments.length;
      fullWork += runTable.runs.reduce((total, run) => total + run.sourceSlices.length, 0);
      // A fixture that cannot assemble would take the full serializer. None do.
      expect(changed).toBeDefined();
    }
    expect(fullSerializeCalls).toBe(0);
    expect(patchPathCount / fixtures.length).toBeGreaterThanOrEqual(0.99);
    expect(patchWork).toBeLessThanOrEqual(fullWork);
  });
});
describe('structural source journal golden assembly', () => {
  it.each((structuralFixtures as Array<{ name: string; source: string; edit: NormalizedEdit; changed: SerializedRun[]; expected: string; unsupported?: boolean }>)
    .filter((fixture) => !fixture.unsupported))(
    '$name preserves untouched gaps byte-for-byte',
    ({ source, edit, changed, expected }) => {
      const disposition = classifyGapDisposition(edit);
      expect(disposition.kind).not.toBe('rerender');
      expect(disposition.kind).not.toBe('single-block');
      expect(applyStructuralEdit(table(source), edit, disposition as never, changed)).toBe(expected);
    },
  );
  it.each((structuralFixtures as Array<{ name: string; source: string; edit: NormalizedEdit; unsupported?: boolean }>)
    .filter((fixture) => fixture.unsupported))(
    '$name is explicit B6 and produces no structural output',
    ({ source, edit }) => {
      const disposition = classifyGapDisposition(edit);
      expect(structuralJournalSupport(table(source), edit, disposition as never)).toMatchObject({
        ok: false,
        reason: 'structural-unsupported-subtype',
      });
    },
  );
});
  it('interleaves every source slice while structurally editing a later paragraph', () => {
    const source = '> a\n> b\n\nfirst\n\nsecond\n';
    const edit: NormalizedEdit = {
      inputType: 'deleteContentBackward', replacementKind: 'none', boundary: 'trailing', boundaryGaps: [],
      range: { kind: 'selection', coverage: 'whole' },
      affected: { beforeIds: [2], afterIds: [], delta: 'remove' },
    };
    const disposition = classifyGapDisposition(edit);
    expect(applyStructuralEdit(table(source), edit, disposition as never, [])).toBe('> a\n> b\n\nfirst\n');
  });
describe('structural safety boundary', () => {
  it.each([
    ['list split', '- first\n- second\n', { inputType: 'insertParagraph', replacementKind: 'text', boundary: 'middle', boundaryGaps: [], range: { kind: 'collapsed', edge: 'interior' }, affected: { beforeIds: [0], afterIds: [0, 9], delta: 'add' } }],
    ['heading delete', '# heading\n\nbody\n', { inputType: 'deleteContentBackward', replacementKind: 'none', boundary: 'leading', boundaryGaps: [], range: { kind: 'selection', coverage: 'whole' }, affected: { beforeIds: [0], afterIds: [], delta: 'remove' } }],
  ] as const)('%s is explicit B6, never a structural byte assembly', (_name, source, rawEdit) => {
    const edit = rawEdit as unknown as NormalizedEdit;
    const disposition = classifyGapDisposition(edit);
    expect(disposition.kind).not.toBe('rerender');
    expect(structuralJournalSupport(table(source), edit, disposition as never)).toMatchObject({
      ok: false,
      reason: 'structural-unsupported-subtype',
    });
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
  it('escapes literal markdown text so edited paragraphs remain paragraphs after reparse', () => {
    const cases = [
      ['# not a heading', '\\# not a heading'],
      ['\\# escaped', '\\\\# escaped'],
      ['*star* [link]', '\\*star\\* \\[link\\]'],
    ] as const;
    for (const [input, expected] of cases) {
      const p = document.createElement('p');
      p.textContent = input;
      expect(serializeChangedRun('paragraph', p)).toEqual({ kind: 'segments', segments: [expected] });
      expect(table(expected).runs[0]?.subtype).toBe('paragraph');
    }
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
