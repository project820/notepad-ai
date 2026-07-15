import { describe, expect, it } from 'vitest';

import {
  addSection,
  approveOutline,
  authorizeRegeneration,
  canGenerate,
  createOutlineDraft,
  deleteSection,
  editSectionTitle,
  reorderSection,
  type OutlineDraft,
} from '../renderer/html-export-outline';

const SOURCE_LENGTH = 100;

function seqIds(): () => string {
  let n = 0;
  return () => `s${++n}`;
}

function draftOf(): OutlineDraft {
  const result = createOutlineDraft(
    [
      { id: 'a', title: 'Intro', sourceRange: { start: 0, end: 30 } },
      { id: 'b', title: 'Body', sourceRange: { start: 30, end: 70 } },
      { id: 'c', title: 'End', sourceRange: { start: 70, end: 100 } },
    ],
    SOURCE_LENGTH,
  );
  if (!result.ok) throw new Error(`unexpected: ${result.reason}`);
  return result.draft;
}

function approved(): OutlineDraft {
  const r = approveOutline(draftOf());
  if (!r.ok) throw new Error('approve failed');
  return r.draft;
}

describe('createOutlineDraft', () => {
  it('builds a draft-state outline with preserved ids/ranges and normalized titles', () => {
    const r = createOutlineDraft(
      [{ id: 'x', title: '  Title  ', sourceRange: { start: 0, end: 10 } }],
      SOURCE_LENGTH,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.state).toBe('draft');
    expect(r.draft.sections[0]).toEqual({ id: 'x', title: 'Title', sourceRange: { start: 0, end: 10 } });
  });

  it('assigns ids from the factory when missing and enforces uniqueness', () => {
    const r = createOutlineDraft(
      [
        { title: 'one', sourceRange: { start: 0, end: 5 } },
        { title: 'two', sourceRange: { start: 5, end: 9 } },
      ],
      SOURCE_LENGTH,
      seqIds(),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.sections.map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('rejects empty, duplicate-id, invalid-range, and invalid-source-length inputs', () => {
    expect(createOutlineDraft([], SOURCE_LENGTH)).toEqual({ ok: false, reason: 'empty' });
    expect(
      createOutlineDraft(
        [
          { id: 'd', title: 'a', sourceRange: { start: 0, end: 1 } },
          { id: 'd', title: 'b', sourceRange: { start: 1, end: 2 } },
        ],
        SOURCE_LENGTH,
      ),
    ).toEqual({ ok: false, reason: 'duplicate-id' });
    for (const bad of [
      { start: -1, end: 5 },
      { start: 0, end: 101 },
      { start: 8, end: 4 },
      { start: 0.5, end: 5 },
    ]) {
      expect(createOutlineDraft([{ title: 't', sourceRange: bad }], SOURCE_LENGTH).ok).toBe(false);
    }
    expect(createOutlineDraft([{ title: 't', sourceRange: { start: 0, end: 1 } }], -1)).toEqual({
      ok: false,
      reason: 'invalid-source-length',
    });
  });
});

describe('approval invariant (AC-M2a: no generation before approval)', () => {
  it('canGenerate is false for a draft and true only after approval', () => {
    const d = draftOf();
    expect(canGenerate(d)).toBe(false);
    const a = approveOutline(d);
    expect(a.ok && canGenerate(a.draft)).toBe(true);
  });

  it('refuses to approve an empty outline', () => {
    const emptied = deleteSection(deleteSection(deleteSection(draftOf(), 'a'), 'b'), 'c');
    expect(approveOutline(emptied)).toEqual({ ok: false, reason: 'empty' });
  });

  it.each([
    ['reorder', (d: OutlineDraft) => reorderSection(d, 'a', 2)],
    ['delete', (d: OutlineDraft) => deleteSection(d, 'b')],
    ['editTitle', (d: OutlineDraft) => editSectionTitle(d, 'a', 'New')],
    ['addSection', (d: OutlineDraft) => {
      const r = addSection(d, { title: 'x', sourceRange: { start: 10, end: 20 } }, () => 'new');
      if (!r.ok) throw new Error('add failed');
      return r.draft;
    }],
  ])('re-opens an approved outline to draft after a %s edit (re-approval required)', (_name, edit) => {
    const a = approved();
    expect(a.state).toBe('approved');
    const edited = edit(a);
    expect(edited.state).toBe('draft');
    expect(canGenerate(edited)).toBe(false);
  });
});

describe('reorderSection', () => {
  it('moves a section while preserving every id and source range', () => {
    const d = reorderSection(draftOf(), 'c', 0);
    expect(d.sections.map((s) => s.id)).toEqual(['c', 'a', 'b']);
    expect(d.sections.find((s) => s.id === 'a')!.sourceRange).toEqual({ start: 0, end: 30 });
    expect(d.sections.find((s) => s.id === 'c')!.sourceRange).toEqual({ start: 70, end: 100 });
  });

  it('clamps the target index and is a no-op for an unknown id', () => {
    expect(reorderSection(draftOf(), 'a', 99).sections.map((s) => s.id)).toEqual(['b', 'c', 'a']);
    const unknown = reorderSection(draftOf(), 'zzz', 0);
    expect(unknown.sections.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('deleteSection', () => {
  it('removes only the target and keeps other ids/ranges intact', () => {
    const d = deleteSection(draftOf(), 'b');
    expect(d.sections.map((s) => s.id)).toEqual(['a', 'c']);
    expect(d.sections.find((s) => s.id === 'c')!.sourceRange).toEqual({ start: 70, end: 100 });
  });

  it('is a no-op for an unknown id', () => {
    const d = deleteSection(draftOf(), 'zzz');
    expect(d.sections).toHaveLength(3);
  });
});

describe('editSectionTitle', () => {
  it('changes only the title and preserves the id and source range', () => {
    const d = editSectionTitle(draftOf(), 'b', '  Updated Body  ');
    const b = d.sections.find((s) => s.id === 'b')!;
    expect(b.title).toBe('Updated Body');
    expect(b.sourceRange).toEqual({ start: 30, end: 70 });
    expect(d.sections.find((s) => s.id === 'a')!.title).toBe('Intro');
  });

  it('is a no-op for an unknown id', () => {
    expect(editSectionTitle(draftOf(), 'zzz', 'x').sections.map((s) => s.title)).toEqual([
      'Intro',
      'Body',
      'End',
    ]);
  });
});

describe('addSection', () => {
  it('inserts a new section with a fresh id and the given range/title', () => {
    const r = addSection(draftOf(), { title: 'Added', sourceRange: { start: 40, end: 50 }, atIndex: 1 }, () => 'new-1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.section).toEqual({ id: 'new-1', title: 'Added', sourceRange: { start: 40, end: 50 } });
    expect(r.draft.sections.map((s) => s.id)).toEqual(['a', 'new-1', 'b', 'c']);
    // Existing sections keep their exact ids and ranges.
    expect(r.draft.sections.find((s) => s.id === 'c')!.sourceRange).toEqual({ start: 70, end: 100 });
  });

  it('appends when no index is given and rejects an invalid range', () => {
    const appended = addSection(draftOf(), { title: 't', sourceRange: { start: 0, end: 5 } }, () => 'z');
    expect(appended.ok && appended.draft.sections.at(-1)!.id).toBe('z');
    expect(addSection(draftOf(), { title: 't', sourceRange: { start: 0, end: 999 } }, () => 'z')).toEqual({
      ok: false,
      reason: 'invalid-range',
    });
  });

  it('never reuses a deleted section id', () => {
    const afterDelete = deleteSection(draftOf(), 'b');
    // The add-one-section factory must not hand back the deleted id 'b'.
    const r = addSection(afterDelete, { title: 'fresh', sourceRange: { start: 30, end: 40 } }, () => 'b2');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.section.id).toBe('b2');
    expect(r.draft.sections.some((s) => s.id === 'b')).toBe(false);
  });

  it('refuses to re-mint a deleted id even when the factory returns it (retired id)', () => {
    const afterDelete = deleteSection(draftOf(), 'b');
    const reused = addSection(afterDelete, { title: 'x', sourceRange: { start: 30, end: 40 } }, () => 'b');
    expect(reused).toEqual({ ok: false, reason: 'duplicate-id' });
  });
});

describe('authorizeRegeneration (full-regeneration guard)', () => {
  it('refuses any regeneration before approval', () => {
    expect(authorizeRegeneration(draftOf(), { kind: 'section', sectionId: 'a' })).toEqual({
      ok: false,
      reason: 'not-approved',
    });
    expect(authorizeRegeneration(draftOf(), { kind: 'full', confirmedCost: true })).toEqual({
      ok: false,
      reason: 'not-approved',
    });
  });

  it('authorizes one-section regeneration for an existing approved section', () => {
    const r = authorizeRegeneration(approved(), { kind: 'section', sectionId: 'b' });
    expect(r).toEqual({ ok: true, kind: 'section', section: { id: 'b', title: 'Body', sourceRange: { start: 30, end: 70 } } });
  });

  it('rejects one-section regeneration for an unknown section', () => {
    expect(authorizeRegeneration(approved(), { kind: 'section', sectionId: 'zzz' })).toEqual({
      ok: false,
      reason: 'unknown-section',
    });
  });

  it('refuses full regeneration without a confirmed cost and allows it with confirmation', () => {
    expect(authorizeRegeneration(approved(), { kind: 'full', confirmedCost: false })).toEqual({
      ok: false,
      reason: 'cost-not-confirmed',
    });
    // Only a strict boolean true confirms — truthy non-booleans must be refused.
    for (const truthy of [1, 'true', {}, [], new Boolean(true)] as unknown[]) {
      expect(
        authorizeRegeneration(approved(), { kind: 'full', confirmedCost: truthy as never }),
      ).toEqual({ ok: false, reason: 'cost-not-confirmed' });
    }
    expect(authorizeRegeneration(approved(), { kind: 'full', confirmedCost: true })).toEqual({
      ok: true,
      kind: 'full',
    });
  });
});
