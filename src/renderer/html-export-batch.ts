/**
 * html-export-batch.ts — long-document section batching + partial assembly for
 * the redesigned HTML export (PR-M2b / §5.15, AC-M2a/b).
 *
 * When an approved outline's source exceeds the single-pass boundary, each section
 * is authored on its own. This module drives that batch:
 *   - authors every section in outline order (one at a time);
 *   - on a generation failure it makes exactly ONE repair attempt, then falls back
 *     to a SAFE PLACEHOLDER — a failed section is NEVER silently dropped;
 *   - a section whose required asset is unresolved goes straight to a placeholder
 *     (a repair cannot conjure a missing asset), folded into the same partial frame;
 *   - assembles the section fragments (authored or placeholder) in order;
 *   - reports source coverage over the outline;
 *   - marks the result `partial` (requiring explicit confirmation + a distinct
 *     filename/status) whenever any placeholder was used, else `complete`.
 *
 * Pure module (no DOM / electron / node). Foundation only: not wired into the live
 * wizard until the single cutover. Consumes the approved outline from
 * html-export-outline.ts; the per-section author is injected.
 */

import { canGenerate, type OutlineDraft, type OutlineSection, type SourceRange } from './html-export-outline';

type SectionFailureKind = 'generation-failed' | 'missing-asset';

/** Result of one injected section-author call. */
export type SectionAuthorResult =
  | { ok: true; html: string }
  | { ok: false; kind: SectionFailureKind };

/** Injected per-section author. `attempt` is 'initial' or the single 'repair'. */
export type SectionAuthor = (input: {
  section: OutlineSection;
  attempt: 'initial' | 'repair';
  signal: AbortSignal;
}) => Promise<SectionAuthorResult>;

type SectionOutcome =
  | { id: string; status: 'authored'; html: string; calls: number }
  | { id: string; status: 'placeholder'; reason: SectionFailureKind; html: string; calls: number };

type CoverageReport = {
  complete: boolean;
  coveredChars: number;
  totalChars: number;
  gaps: readonly SourceRange[];
};

export type BatchOutcome = {
  state: 'complete' | 'partial';
  /** True whenever `state === 'partial'`: the caller must confirm before saving. */
  partialConfirmationRequired: boolean;
  sections: readonly SectionOutcome[];
  /** Section fragments assembled in outline order. */
  body: string;
  placeholderCount: number;
  coverage: CoverageReport;
  callCounts: { generate: number; repair: number };
};

export type BatchOptions = {
  /** App-owned inert placeholder for a section that could not be authored. */
  makePlaceholder?: (section: OutlineSection, reason: SectionFailureKind) => string;
  signal?: AbortSignal;
};

function defaultPlaceholder(section: OutlineSection, reason: SectionFailureKind): string {
  const label = reason === 'missing-asset' ? 'a required image is unavailable' : 'this section could not be generated';
  // Inert, app-authored markup (no model bytes); the main pipeline still sanitizes it.
  return `<section data-he-placeholder="${reason}"><p>[${escapeText(section.title)} — ${label}]</p></section>`;
}

function escapeText(text: string): string {
  return text.replace(/[&<>"]/g, (c) => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'
  ));
}

/** Merge ranges and compute covered chars + ordered gaps over [0, totalChars). */
function computeCoverage(sections: readonly OutlineSection[], totalChars: number): CoverageReport {
  const ranges = sections
    .map((s) => s.sourceRange)
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: SourceRange[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) {
      if (r.end > last.end) last.end = r.end;
    } else {
      merged.push({ start: r.start, end: r.end });
    }
  }

  let coveredChars = 0;
  const gaps: SourceRange[] = [];
  let cursor = 0;
  for (const r of merged) {
    coveredChars += r.end - r.start;
    if (r.start > cursor) gaps.push({ start: cursor, end: r.start });
    cursor = Math.max(cursor, r.end);
  }
  if (cursor < totalChars) gaps.push({ start: cursor, end: totalChars });

  return {
    complete: coveredChars === totalChars && gaps.length === 0,
    coveredChars,
    totalChars,
    gaps,
  };
}

/**
 * Author every section of an APPROVED outline with one repair per failed section
 * and a safe placeholder fallback, then assemble the body. Fails closed when the
 * outline is not approved or the run is cancelled.
 */
export async function batchAuthorOutline(
  draft: OutlineDraft,
  author: SectionAuthor,
  opts: BatchOptions = {},
): Promise<{ ok: true; outcome: BatchOutcome } | { ok: false; reason: 'not-approved' | 'cancelled' }> {
  if (!canGenerate(draft)) return { ok: false, reason: 'not-approved' };
  const signal = opts.signal ?? new AbortController().signal;
  if (signal.aborted) return { ok: false, reason: 'cancelled' };

  const makePlaceholder = opts.makePlaceholder ?? defaultPlaceholder;
  const sections: SectionOutcome[] = [];
  let generate = 0;
  let repair = 0;

  for (const section of draft.sections) {
    if (signal.aborted) return { ok: false, reason: 'cancelled' };

    generate += 1;
    const first = await author({ section, attempt: 'initial', signal });
    if (signal.aborted) return { ok: false, reason: 'cancelled' };

    if (first.ok) {
      sections.push({ id: section.id, status: 'authored', html: first.html, calls: 1 });
      continue;
    }

    // A missing asset cannot be fixed by a reped generation → placeholder now.
    if (first.kind === 'missing-asset') {
      sections.push({
        id: section.id,
        status: 'placeholder',
        reason: 'missing-asset',
        html: makePlaceholder(section, 'missing-asset'),
        calls: 1,
      });
      continue;
    }

    // Exactly ONE repair attempt for a generation failure.
    repair += 1;
    const second = await author({ section, attempt: 'repair', signal });
    if (signal.aborted) return { ok: false, reason: 'cancelled' };

    if (second.ok) {
      sections.push({ id: section.id, status: 'authored', html: second.html, calls: 2 });
      continue;
    }

    const reason: SectionFailureKind = second.kind === 'missing-asset' ? 'missing-asset' : 'generation-failed';
    sections.push({
      id: section.id,
      status: 'placeholder',
      reason,
      html: makePlaceholder(section, reason),
      calls: 2,
    });
  }

  const placeholderCount = sections.filter((s) => s.status === 'placeholder').length;
  const body = sections.map((s) => s.html).join('\n');
  const coverage = computeCoverage(draft.sections, draft.sourceLength);
  const partial = placeholderCount > 0;

  return {
    ok: true,
    outcome: {
      state: partial ? 'partial' : 'complete',
      partialConfirmationRequired: partial,
      sections,
      body,
      placeholderCount,
      coverage,
      callCounts: { generate, repair },
    },
  };
}
