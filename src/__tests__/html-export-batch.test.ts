import { describe, expect, it } from 'vitest';

import {
  batchAuthorOutline,
  type SectionAuthor,
  type SectionAuthorResult,
} from '../renderer/html-export-batch';
import { approveOutline, createOutlineDraft, deleteSection, type OutlineDraft } from '../renderer/html-export-outline';

const SOURCE_LENGTH = 90;

function approvedOutline(): OutlineDraft {
  const created = createOutlineDraft(
    [
      { id: 'a', title: 'Intro', sourceRange: { start: 0, end: 30 } },
      { id: 'b', title: 'Body', sourceRange: { start: 30, end: 60 } },
      { id: 'c', title: 'End', sourceRange: { start: 60, end: 90 } },
    ],
    SOURCE_LENGTH,
  );
  if (!created.ok) throw new Error(created.reason);
  const approved = approveOutline(created.draft);
  if (!approved.ok) throw new Error(approved.reason);
  return approved.draft;
}

/** Author driven by a per-id queue of scripted results. */
function scriptedAuthor(script: Record<string, SectionAuthorResult[]>): SectionAuthor & { calls: Array<{ id: string; attempt: string }> } {
  const calls: Array<{ id: string; attempt: string }> = [];
  const queues: Record<string, SectionAuthorResult[]> = {};
  for (const [id, results] of Object.entries(script)) queues[id] = [...results];
  const author: SectionAuthor = async ({ section, attempt }) => {
    calls.push({ id: section.id, attempt });
    const next = queues[section.id]?.shift();
    if (!next) return { ok: true, html: `<p>${section.id}</p>` };
    return next;
  };
  return Object.assign(author, { calls });
}

function ok(html: string): SectionAuthorResult {
  return { ok: true, html };
}
function fail(kind: 'generation-failed' | 'missing-asset'): SectionAuthorResult {
  return { ok: false, kind };
}

describe('batchAuthorOutline — approval gate', () => {
  it('fails closed when the outline is not approved', async () => {
    const created = createOutlineDraft([{ id: 'a', title: 't', sourceRange: { start: 0, end: 5 } }], 5);
    if (!created.ok) throw new Error(created.reason);
    const author = scriptedAuthor({});
    const result = await batchAuthorOutline(created.draft, author);
    expect(result).toEqual({ ok: false, reason: 'not-approved' });
    expect(author.calls).toHaveLength(0);
  });
});

describe('batchAuthorOutline — happy path', () => {
  it('authors every section in order with no placeholder and complete coverage', async () => {
    const author = scriptedAuthor({
      a: [ok('<h1>A</h1>')],
      b: [ok('<h2>B</h2>')],
      c: [ok('<h3>C</h3>')],
    });
    const result = await batchAuthorOutline(approvedOutline(), author);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const o = result.outcome;
    expect(o.state).toBe('complete');
    expect(o.partialConfirmationRequired).toBe(false);
    expect(o.placeholderCount).toBe(0);
    expect(o.body).toBe('<h1>A</h1>\n<h2>B</h2>\n<h3>C</h3>');
    expect(o.sections.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(o.callCounts).toEqual({ generate: 3, repair: 0 });
    expect(o.coverage).toEqual({ complete: true, coveredChars: 90, totalChars: 90, gaps: [] });
  });
});

describe('batchAuthorOutline — one repair per failed section', () => {
  it('retries a generation failure exactly once and keeps the repaired output', async () => {
    const author = scriptedAuthor({
      b: [fail('generation-failed'), ok('<h2>repaired B</h2>')],
    });
    const result = await batchAuthorOutline(approvedOutline(), author);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const o = result.outcome;
    expect(o.state).toBe('complete');
    expect(o.sections.find((s) => s.id === 'b')).toEqual({ id: 'b', status: 'authored', html: '<h2>repaired B</h2>', calls: 2 });
    expect(o.callCounts).toEqual({ generate: 3, repair: 1 });
    expect(author.calls.filter((c) => c.id === 'b').map((c) => c.attempt)).toEqual(['initial', 'repair']);
  });

  it('falls back to a placeholder after the single repair also fails (no silent omission)', async () => {
    const author = scriptedAuthor({
      b: [fail('generation-failed'), fail('generation-failed')],
    });
    const result = await batchAuthorOutline(approvedOutline(), author);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const o = result.outcome;
    expect(o.state).toBe('partial');
    expect(o.partialConfirmationRequired).toBe(true);
    expect(o.placeholderCount).toBe(1);
    const b = o.sections.find((s) => s.id === 'b')!;
    expect(b.status).toBe('placeholder');
    expect(b).toMatchObject({ reason: 'generation-failed', calls: 2 });
    // The failed section is still present in order, never dropped.
    expect(o.sections.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(o.body).toContain('data-he-placeholder="generation-failed"');
    // b only ever gets 2 calls (initial + one repair).
    expect(author.calls.filter((c) => c.id === 'b')).toHaveLength(2);
  });
});

describe('batchAuthorOutline — missing asset', () => {
  it('uses a placeholder immediately for a missing asset (no repair attempt)', async () => {
    const author = scriptedAuthor({
      c: [fail('missing-asset')],
    });
    const result = await batchAuthorOutline(approvedOutline(), author);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const o = result.outcome;
    expect(o.state).toBe('partial');
    const c = o.sections.find((s) => s.id === 'c')!;
    expect(c).toMatchObject({ status: 'placeholder', reason: 'missing-asset', calls: 1 });
    expect(o.callCounts.repair).toBe(0);
    // Exactly one call for the missing-asset section (no repair).
    expect(author.calls.filter((call) => call.id === 'c')).toHaveLength(1);
    expect(o.body).toContain('data-he-placeholder="missing-asset"');
  });
});

describe('batchAuthorOutline — placeholder safety', () => {
  it('escapes the section title inside the default placeholder', async () => {
    const created = createOutlineDraft(
      [{ id: 'x', title: '<script>alert(1)</script>', sourceRange: { start: 0, end: 10 } }],
      10,
    );
    if (!created.ok) throw new Error(created.reason);
    const approved = approveOutline(created.draft);
    if (!approved.ok) throw new Error('approve');
    const author = scriptedAuthor({ x: [fail('generation-failed'), fail('generation-failed')] });

    const result = await batchAuthorOutline(approved.draft, author);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome.body).not.toContain('<script>alert(1)</script>');
    expect(result.outcome.body).toContain('&lt;script&gt;');
  });

  it('honors an injected placeholder factory', async () => {
    const author = scriptedAuthor({ a: [fail('generation-failed'), fail('generation-failed')] });
    const result = await batchAuthorOutline(approvedOutline(), author, {
      makePlaceholder: (section) => `<div data-custom="${section.id}"></div>`,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome.body).toContain('<div data-custom="a"></div>');
  });
});

describe('batchAuthorOutline — coverage reporting', () => {
  it('reports gaps when the approved outline no longer covers the whole source', async () => {
    const withGap = approveOutline(deleteSection(approvedOutline(), 'b'));
    if (!withGap.ok) throw new Error('approve');
    const author = scriptedAuthor({});
    const result = await batchAuthorOutline(withGap.draft, author);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // a [0,30) and c [60,90) leave a [30,60) gap; total still 90.
    expect(result.outcome.coverage).toEqual({
      complete: false,
      coveredChars: 60,
      totalChars: 90,
      gaps: [{ start: 30, end: 60 }],
    });
  });
});

describe('batchAuthorOutline — cancellation', () => {
  it('returns cancelled for an already-aborted signal without authoring', async () => {
    const controller = new AbortController();
    controller.abort();
    const author = scriptedAuthor({});
    const result = await batchAuthorOutline(approvedOutline(), author, { signal: controller.signal });
    expect(result).toEqual({ ok: false, reason: 'cancelled' });
    expect(author.calls).toHaveLength(0);
  });

  it('stops and returns cancelled when aborted mid-batch', async () => {
    const controller = new AbortController();
    const author: SectionAuthor = async ({ section }) => {
      if (section.id === 'b') controller.abort();
      return { ok: true, html: `<p>${section.id}</p>` };
    };
    const result = await batchAuthorOutline(approvedOutline(), author, { signal: controller.signal });
    expect(result).toEqual({ ok: false, reason: 'cancelled' });
  });
});
