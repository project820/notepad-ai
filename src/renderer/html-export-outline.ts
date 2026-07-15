/**
 * html-export-outline.ts — outline approval state for the redesigned HTML export
 * (PR-M2a / §5.15, AC-M2a).
 *
 * A long source (> the single-pass boundary) is first turned into an ORDERED
 * outline of sections. The user reviews and edits that outline — reorder, delete,
 * inline title edit, add-one-section — before ANY HTML is generated. Section IDs
 * are STABLE and `sourceRange` is preserved across edits so a later phase can
 * regenerate exactly one section locally.
 *
 * Two invariants are enforced here:
 *   1. No generation before approval — `canGenerate` is false until `approveOutline`.
 *   2. Any edit re-opens the draft — editing an approved outline reverts it to
 *      `draft`, forcing an explicit re-approval before generation resumes.
 * Full (whole-document) regeneration additionally requires an explicit request
 * with a displayed cost confirmation; one-section regeneration does not.
 *
 * Pure module (no DOM / electron / node). Foundation only: not wired into the
 * live wizard until the single cutover. Section shape matches buildSectionPrompt
 * in html-export-direct-prompt.ts.
 */

/** A half-open source span [start, end) into the SOURCE document. */
export type SourceRange = { start: number; end: number };

/** One ordered outline section. `id` is stable; `sourceRange` is preserved across edits. */
export type OutlineSection = {
  id: string;
  title: string;
  sourceRange: SourceRange;
};

type OutlineApprovalState = 'draft' | 'approved';

export type OutlineDraft = {
  state: OutlineApprovalState;
  sections: readonly OutlineSection[];
  sourceLength: number;
  /** Ids that have ever been used (incl. deleted). A new section id is never reused. */
  retiredIds: ReadonlySet<string>;
};

/** Injected id factory so new section ids are stable and tests are deterministic. */
export type OutlineIdFactory = () => string;

const MAX_TITLE_LENGTH = 200;

function defaultIdFactory(): OutlineIdFactory {
  let n = 0;
  return () => `section-${++n}`;
}

function isValidRange(range: SourceRange, sourceLength: number): boolean {
  return (
    Number.isInteger(range.start)
    && Number.isInteger(range.end)
    && range.start >= 0
    && range.end >= range.start
    && range.end <= sourceLength
  );
}

function normalizeTitle(title: string): string {
  return title.trim().slice(0, MAX_TITLE_LENGTH);
}

/**
 * Build a draft outline from raw sections. Every range must be an integer span
 * within [0, sourceLength]; ids are assigned from `makeId` when missing and MUST
 * be unique. Returns a `draft`-state outline (never pre-approved).
 */
export function createOutlineDraft(
  rawSections: ReadonlyArray<{ id?: string; title: string; sourceRange: SourceRange }>,
  sourceLength: number,
  makeId: OutlineIdFactory = defaultIdFactory(),
):
  | { ok: true; draft: OutlineDraft }
  | { ok: false; reason: 'empty' | 'invalid-range' | 'duplicate-id' | 'invalid-source-length' } {
  if (!Number.isInteger(sourceLength) || sourceLength < 0) {
    return { ok: false, reason: 'invalid-source-length' };
  }
  if (rawSections.length === 0) return { ok: false, reason: 'empty' };

  const seen = new Set<string>();
  const sections: OutlineSection[] = [];
  for (const raw of rawSections) {
    if (!isValidRange(raw.sourceRange, sourceLength)) return { ok: false, reason: 'invalid-range' };
    const id = raw.id ?? makeId();
    if (seen.has(id)) return { ok: false, reason: 'duplicate-id' };
    seen.add(id);
    sections.push({
      id,
      title: normalizeTitle(raw.title),
      sourceRange: { start: raw.sourceRange.start, end: raw.sourceRange.end },
    });
  }
  return { ok: true, draft: { state: 'draft', sections, sourceLength, retiredIds: new Set(seen) } };
}

/** An edit re-opens the draft: an approved outline reverts to `draft`. */
function reopened(
  sections: readonly OutlineSection[],
  sourceLength: number,
  retiredIds: ReadonlySet<string>,
): OutlineDraft {
  return { state: 'draft', sections, sourceLength, retiredIds };
}

/** Move the section with `id` to `toIndex`. Ids and source ranges are preserved. */
export function reorderSection(draft: OutlineDraft, id: string, toIndex: number): OutlineDraft {
  const from = draft.sections.findIndex((s) => s.id === id);
  if (from === -1) return draft;
  const clamped = Math.max(0, Math.min(toIndex, draft.sections.length - 1));
  if (clamped === from) return reopened(draft.sections, draft.sourceLength, draft.retiredIds);
  const next = [...draft.sections];
  const [moved] = next.splice(from, 1);
  next.splice(clamped, 0, moved!);
  return reopened(next, draft.sourceLength, draft.retiredIds);
}

/** Remove the section with `id`. Every other section keeps its id and range. */
export function deleteSection(draft: OutlineDraft, id: string): OutlineDraft {
  const next = draft.sections.filter((s) => s.id !== id);
  if (next.length === draft.sections.length) return draft;
  // Retire the deleted id so a later add-one-section can never mint it again.
  const retiredIds = new Set(draft.retiredIds);
  retiredIds.add(id);
  return reopened(next, draft.sourceLength, retiredIds);
}

/** Edit only the title of the section with `id`; its id and source range are untouched. */
export function editSectionTitle(draft: OutlineDraft, id: string, title: string): OutlineDraft {
  let changed = false;
  const next = draft.sections.map((s) => {
    if (s.id !== id) return s;
    changed = true;
    return { ...s, title: normalizeTitle(title) };
  });
  return changed ? reopened(next, draft.sourceLength, draft.retiredIds) : draft;
}

/**
 * Add ONE new section (the "+" add-one-section affordance). The new section gets a
 * fresh stable id (never a reused/deleted id) and the caller-supplied range/title;
 * only that section is regenerated later. Inserts at `atIndex` (appended by default).
 */
export function addSection(
  draft: OutlineDraft,
  input: { title: string; sourceRange: SourceRange; atIndex?: number },
  makeId: OutlineIdFactory,
):
  | { ok: true; draft: OutlineDraft; section: OutlineSection }
  | { ok: false; reason: 'invalid-range' | 'duplicate-id' } {
  if (!isValidRange(input.sourceRange, draft.sourceLength)) return { ok: false, reason: 'invalid-range' };
  const id = makeId();
  // Never reuse a live OR a retired (previously deleted) id.
  if (draft.sections.some((s) => s.id === id) || draft.retiredIds.has(id)) {
    return { ok: false, reason: 'duplicate-id' };
  }
  const section: OutlineSection = {
    id,
    title: normalizeTitle(input.title),
    sourceRange: { start: input.sourceRange.start, end: input.sourceRange.end },
  };
  const next = [...draft.sections];
  const at = input.atIndex === undefined
    ? next.length
    : Math.max(0, Math.min(input.atIndex, next.length));
  next.splice(at, 0, section);
  const retiredIds = new Set(draft.retiredIds);
  retiredIds.add(id);
  return { ok: true, draft: reopened(next, draft.sourceLength, retiredIds), section };
}

/** Approve the current outline. Generation is only permitted after this. */
export function approveOutline(draft: OutlineDraft):
  | { ok: true; draft: OutlineDraft }
  | { ok: false; reason: 'empty' } {
  if (draft.sections.length === 0) return { ok: false, reason: 'empty' };
  if (draft.state === 'approved') return { ok: true, draft };
  return { ok: true, draft: { ...draft, state: 'approved' } };
}

/** No HTML may be generated until the outline is approved (AC-M2a invariant). */
export function canGenerate(draft: OutlineDraft): boolean {
  return draft.state === 'approved';
}

/**
 * Regeneration request. One-section regeneration is a normal approved action;
 * full (whole-document) regeneration requires an explicit request AND a displayed
 * cost confirmation (`confirmedCost: true`).
 */
export type RegenerationRequest =
  | { kind: 'section'; sectionId: string }
  | { kind: 'full'; confirmedCost: boolean };

/**
 * Authorize a regeneration against the current draft. Fails closed: nothing is
 * regenerable before approval, an unknown section is rejected, and a full
 * regeneration without a confirmed cost is refused (no one-click unsafe regen).
 */
export function authorizeRegeneration(
  draft: OutlineDraft,
  request: RegenerationRequest,
):
  | { ok: true; kind: 'section'; section: OutlineSection }
  | { ok: true; kind: 'full' }
  | { ok: false; reason: 'not-approved' | 'unknown-section' | 'cost-not-confirmed' } {
  if (!canGenerate(draft)) return { ok: false, reason: 'not-approved' };
  if (request.kind === 'section') {
    const section = draft.sections.find((s) => s.id === request.sectionId);
    if (!section) return { ok: false, reason: 'unknown-section' };
    return { ok: true, kind: 'section', section };
  }
  if (request.confirmedCost !== true) return { ok: false, reason: 'cost-not-confirmed' };
  return { ok: true, kind: 'full' };
}
