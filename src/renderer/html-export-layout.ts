/**
 * html-export-layout.ts — deterministic measure → paginate → scale engine (G005).
 *
 * The CORE containment guarantee for the HTML export: given a validated
 * ContentModel, decide WHICH blocks land on WHICH slide and at WHAT uniform
 * scale, so that every slide fits inside its safe area WITHOUT slide-internal
 * scrolling and WITHOUT shrinking body text below the readability floor.
 *
 * Strategy (per slide):
 *   1. await fontsReady() once before any measurement (fonts settle first).
 *   2. Seed candidate slides from sections (one section → its own slide).
 *   3. Greedily pack a section's blocks: measure the running set at scale 1.
 *      - fits as-is              → keep scale 1.
 *      - fits via uniform scale  → keep that scale, IF scale >= MIN_SCALE.
 *      - would be sub-readable   → SPLIT BEFORE SCALING (paginate / split the
 *                                  oversized block) and re-measure.
 *   4. A HARD iteration cap fails SAFE: it returns `{ ok:false }` with a reason
 *      rather than emitting a broken / over-scaled slide.
 *
 * Measurement is INJECTED (`MeasureFn`) so the engine is fully unit-testable
 * without a browser: tests pass deterministic fake measurements; G006 injects
 * the real offscreen-DOM adapter at runtime. Likewise `FontsReadyFn` is
 * injected (real = `document.fonts.ready` + a layout-settle tick).
 *
 * Pure module: NO direct DOM / electron import. Deterministic: identical
 * inputs (model + fake measure) → identical plan.
 */

import type { ChartSpec, ContentBlock, ContentModel, ContentSection } from './html-export-model';
import type { Orientation } from './html-export-state';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Slide geometry derived from orientation, minus the safe-area padding. */
export type SlideDims = {
  width: number;
  height: number;
  /** Usable inner width (safe area). Content must fit within this after scaling. */
  safeW: number;
  /** Usable inner height (safe area). Content must fit within this after scaling. */
  safeH: number;
};

/**
 * Measure the natural pixel footprint of `blocks` laid out for `dims` at the
 * given `scale`. The engine measures at scale 1 to compute the needed uniform
 * scale; the runtime adapter applies that scale via a uniform CSS transform
 * (no reflow), so a scale-1 measurement is exact. INJECTED.
 */
export type MeasureFn = (
  blocks: ContentBlock[],
  dims: SlideDims,
  scale: number,
) => { contentW: number; contentH: number };

/** Resolve once fonts are loaded + a layout tick has settled. INJECTED. */
export type FontsReadyFn = () => Promise<void>;

/** One planned slide: the blocks to render, the uniform scale, repeated header. */
export type PlannedSlide = {
  blocks: ContentBlock[];
  /** Uniform scale in [MIN_SCALE, 1] applied to the slide content. */
  scale: number;
  /** Section title repeated on every slide of the section. */
  sectionTitle?: string;
  /** Section kicker repeated on every slide of the section. */
  kicker?: string;
  /** True for continuation slides produced by a split. */
  continued?: boolean;
};

export type LayoutDiagnostics = {
  /** Number of planned slides (0 when the plan failed). */
  slideCount: number;
  /** Number of split operations performed. */
  splits: number;
  /** Smallest scale applied to any slide (or the failing scale on failure). */
  minScale: number;
  /** Total measure→split iterations consumed. */
  iterations: number;
  /** Slides that could not be contained — MUST be 0 when `ok`. */
  overflowSlides: number;
  /** Set on failure: why no safe plan could be produced. */
  reason?: string;
  /** True iff every slide is contained at a readable scale. */
  containmentPass: boolean;
};

export type LayoutResult = {
  ok: boolean;
  slides: PlannedSlide[];
  diagnostics: LayoutDiagnostics;
};

/** Diagnostics for the scroll layout (vertical scroll OK, horizontal = failure). */
export type ScrollContainmentResult = {
  /** True when the full-width column overflows horizontally — a failure. */
  horizontalOverflow: boolean;
  contentW: number;
  contentH: number;
  safeW: number;
  safeH: number;
};

export type PlanSlidesArgs = {
  model: ContentModel;
  orientation: Orientation;
  /** Defaults to `slideDimsFor(orientation)`. */
  dims?: SlideDims;
  measure: MeasureFn;
  /** Defaults to an already-resolved promise. */
  fontsReady?: FontsReadyFn;
  /** Hard cap on measure→split iterations (fail-safe). Defaults to 200. */
  maxIterations?: number;
};

export type PlanScrollContainmentArgs = {
  model: ContentModel;
  orientation: Orientation;
  dims?: SlideDims;
  measure: MeasureFn;
  fontsReady?: FontsReadyFn;
};

// ---------------------------------------------------------------------------
// Readability floor + geometry constants (exported for tests + the renderer)
// ---------------------------------------------------------------------------

/** Body text must never render below this size — the hard readability floor. */
export const MIN_BODY_PX = 14;
/** Captions / chart notes must never render below this size. */
export const MIN_CAPTION_PX = 11;
/** The body size at scale 1. MIN_SCALE is derived from this + MIN_BODY_PX. */
export const BASE_BODY_PX = 20;
/**
 * The smallest uniform scale the engine will apply. Derived from the base body
 * size so scaled body text never drops below MIN_BODY_PX. Below this, the
 * engine SPLITS instead of scaling.
 */
export const MIN_SCALE = MIN_BODY_PX / BASE_BODY_PX;
/** Default hard iteration cap for the measure→split loop. */
export const DEFAULT_MAX_ITERATIONS = 200;

/** Safe-area padding (per edge) trimmed from the raw slide rectangle. */
const SAFE_PAD = 48;
/** Charts cannot be reduced below this label count — fewer would be meaningless. */
const MIN_CHART_LABELS = 2;

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Slide dimensions for an orientation (horizontal 1280×720, vertical 720×1280). */
export function slideDimsFor(orientation: Orientation): SlideDims {
  const width = orientation === 'vertical' ? 720 : 1280;
  const height = orientation === 'vertical' ? 1280 : 720;
  return {
    width,
    height,
    safeW: width - SAFE_PAD * 2,
    safeH: height - SAFE_PAD * 2,
  };
}

const noopFontsReady: FontsReadyFn = () => Promise.resolve();

/** Compute the uniform scale that makes `m` fit `dims`; 1 when it already fits. */
function scaleToFit(m: { contentW: number; contentH: number }, dims: SlideDims): number {
  if (m.contentW <= dims.safeW && m.contentH <= dims.safeH) return 1;
  const sw = m.contentW > 0 ? dims.safeW / m.contentW : 1;
  const sh = m.contentH > 0 ? dims.safeH / m.contentH : 1;
  return Math.min(1, sw, sh);
}

// ---------------------------------------------------------------------------
// Section header (repeated on every slide of a section)
// ---------------------------------------------------------------------------

type SectionHeader = { title?: string; kicker?: string };

/**
 * Synthetic header blocks (kicker + section title) prepended to a slide's
 * content for measurement. The repeated header occupies real vertical space,
 * so it MUST be measured; the renderer re-emits it from `sectionTitle`/`kicker`.
 */
function headerBlocks(header: SectionHeader): ContentBlock[] {
  const hb: ContentBlock[] = [];
  if (header.kicker) hb.push({ kind: 'kicker', text: header.kicker });
  if (header.title) hb.push({ kind: 'heading', level: 2, text: header.title });
  return hb;
}

function makeSlide(
  blocks: ContentBlock[],
  header: SectionHeader,
  continued: boolean,
  scale: number,
): PlannedSlide {
  const slide: PlannedSlide = { blocks: [...blocks], scale };
  if (header.title) slide.sectionTitle = header.title;
  if (header.kicker) slide.kicker = header.kicker;
  if (continued) slide.continued = true;
  return slide;
}

// ---------------------------------------------------------------------------
// Block splitting — the split-before-scaling strategy
// ---------------------------------------------------------------------------

/** Split prose into sentences; CJK terminators split without a trailing space. */
function splitSentences(text: string): string[] {
  const t = (text ?? '').trim();
  if (!t) return [];
  const parts = t
    .split(/(?<=[.!?])\s+|(?<=[。！？])/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : [t];
}

/**
 * Split one oversized block into smaller pieces, preserving meaning + order.
 * Returns `null` when the block is atomic and cannot be split further (the
 * caller then fails safe rather than emitting a sub-readable slide).
 *
 * Order of strategies by block kind:
 *   - list      → split items by count
 *   - table     → split by ROWS (repeat headers); a too-wide single row falls
 *                 back to a STACKED key/value transpose (best-effort, safe)
 *   - code      → split by line groups
 *   - paragraph / quote / callout → split by sentences
 *   - chart     → reduce labels (own-slide placement is handled by packing)
 *   - heading / kicker → atomic (null)
 */
function splitBlock(block: ContentBlock): ContentBlock[] | null {
  switch (block.kind) {
    case 'list': {
      const items = Array.isArray(block.items) ? block.items : [];
      if (items.length <= 1) return null;
      const mid = Math.ceil(items.length / 2);
      return [
        { kind: 'list', ordered: block.ordered, items: items.slice(0, mid) },
        { kind: 'list', ordered: block.ordered, items: items.slice(mid) },
      ];
    }
    case 'table': {
      const headers = Array.isArray(block.headers) ? block.headers : [];
      const rows = Array.isArray(block.rows) ? block.rows : [];
      if (rows.length >= 2) {
        const mid = Math.ceil(rows.length / 2);
        return [
          { kind: 'table', headers, rows: rows.slice(0, mid) },
          { kind: 'table', headers, rows: rows.slice(mid) },
        ];
      }
      // A single (or zero) row that is still too wide: stacked-row fallback —
      // transpose to a tall 2-column key/value table (narrow, then row-split).
      if (rows.length === 1 && headers.length > 1) {
        const row = rows[0] ?? [];
        const stacked = headers.map((h, i) => [h, row[i] ?? '']);
        return [{ kind: 'table', headers: [], rows: stacked }];
      }
      return null;
    }
    case 'code': {
      const lines = (block.code ?? '').split('\n');
      if (lines.length <= 1) return null;
      const mid = Math.ceil(lines.length / 2);
      return [
        { kind: 'code', language: block.language, code: lines.slice(0, mid).join('\n') },
        { kind: 'code', language: block.language, code: lines.slice(mid).join('\n') },
      ];
    }
    case 'paragraph': {
      const s = splitSentences(block.text);
      if (s.length <= 1) return null;
      const mid = Math.ceil(s.length / 2);
      return [
        { kind: 'paragraph', text: s.slice(0, mid).join(' ') },
        { kind: 'paragraph', text: s.slice(mid).join(' ') },
      ];
    }
    case 'quote': {
      const s = splitSentences(block.text);
      if (s.length <= 1) return null;
      const mid = Math.ceil(s.length / 2);
      return [
        { kind: 'quote', text: s.slice(0, mid).join(' ') },
        { kind: 'quote', text: s.slice(mid).join(' ') },
      ];
    }
    case 'callout': {
      const s = splitSentences(block.text);
      if (s.length <= 1) return null;
      const mid = Math.ceil(s.length / 2);
      return [
        { kind: 'callout', tone: block.tone, text: s.slice(0, mid).join(' ') },
        { kind: 'callout', tone: block.tone, text: s.slice(mid).join(' ') },
      ];
    }
    case 'chart': {
      const chart = block.chart;
      const labels = Array.isArray(chart?.labels) ? chart.labels : [];
      if (labels.length <= MIN_CHART_LABELS) return null;
      const keep = Math.max(MIN_CHART_LABELS, Math.ceil(labels.length / 2));
      const reduced: ChartSpec = {
        ...chart,
        labels: labels.slice(0, keep),
        series: (Array.isArray(chart.series) ? chart.series : []).map((s) => ({
          ...s,
          values: Array.isArray(s.values) ? s.values.slice(0, keep) : [],
        })),
      };
      return [{ kind: 'chart', chart: reduced }];
    }
    case 'heading':
    case 'kicker':
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Packing — greedy measure → pack → split, per section
// ---------------------------------------------------------------------------

type Budget = { iterations: number; splits: number; max: number; minScale: number; failScale: number };

type PackResult = { ok: true; slides: PlannedSlide[] } | { ok: false; reason: string };

/**
 * Greedily pack one section's blocks into contained slides. Blocks are added to
 * the current slide while it stays readable (scale >= MIN_SCALE). When adding a
 * block would make the slide sub-readable, the current slide is closed and the
 * block retried on a fresh continuation; a block that is sub-readable ALONE is
 * split. Shares the global `budget` (iteration cap + diagnostics).
 */
function packSection(
  section: ContentSection,
  dims: SlideDims,
  measure: MeasureFn,
  budget: Budget,
): PackResult {
  const header: SectionHeader = { title: section.title, kicker: section.kicker };
  const hb = headerBlocks(header);
  const out: PlannedSlide[] = [];
  const remaining: ContentBlock[] = Array.isArray(section.blocks) ? [...section.blocks] : [];
  let current: ContentBlock[] = [];

  const closeCurrent = (): void => {
    // `current` was last verified readable when its final block was added, so
    // re-measuring here is guaranteed >= MIN_SCALE (deterministic measure).
    const scale = scaleToFit(measure([...hb, ...current], dims, 1), dims);
    budget.minScale = Math.min(budget.minScale, scale);
    out.push(makeSlide(current, header, out.length > 0, scale));
    current = [];
  };

  // Section with a header but no content blocks → a single header-only slide.
  if (remaining.length === 0) {
    if (hb.length === 0) return { ok: true, slides: [] };
    const scale = scaleToFit(measure(hb, dims, 1), dims);
    if (scale < MIN_SCALE) {
      budget.failScale = scale;
      return { ok: false, reason: 'section header cannot fit readably' };
    }
    budget.minScale = Math.min(budget.minScale, scale);
    out.push(makeSlide([], header, false, scale));
    return { ok: true, slides: out };
  }

  while (remaining.length > 0) {
    budget.iterations += 1;
    if (budget.iterations > budget.max) {
      return { ok: false, reason: `exceeded maxIterations (${budget.max})` };
    }
    const block = remaining[0];
    const scale = scaleToFit(measure([...hb, ...current, block], dims, 1), dims);
    if (scale >= MIN_SCALE) {
      current.push(block);
      remaining.shift();
      continue;
    }
    if (current.length > 0) {
      // The accumulated slide + this block is sub-readable → split BEFORE
      // scaling: close the readable slice, retry this block on a continuation.
      closeCurrent();
      continue;
    }
    // The block is sub-readable on its own → split the block itself.
    const pieces = splitBlock(block);
    if (pieces === null) {
      budget.failScale = scale;
      return {
        ok: false,
        reason: `block (${block.kind}) cannot fit readably and cannot be split further`,
      };
    }
    budget.splits += 1;
    remaining.shift();
    remaining.unshift(...pieces);
  }
  if (current.length > 0) closeCurrent();
  return { ok: true, slides: out };
}

// ---------------------------------------------------------------------------
// planSlides — the public engine entry point
// ---------------------------------------------------------------------------

/**
 * Plan the slide layout for a model: measure → paginate → scale, splitting
 * before scaling below the readability floor and failing SAFE (ok:false) if no
 * contained plan exists within the iteration cap. NEVER emits an over-scaled or
 * scrolling slide.
 */
export async function planSlides(args: PlanSlidesArgs): Promise<LayoutResult> {
  const dims = args.dims ?? slideDimsFor(args.orientation);
  const measure = args.measure;
  const max = args.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const fontsReady = args.fontsReady ?? noopFontsReady;

  // (1) Settle fonts BEFORE any measurement.
  await fontsReady();

  const budget: Budget = { iterations: 0, splits: 0, max, minScale: 1, failScale: 1 };
  const slides: PlannedSlide[] = [];
  const sections = Array.isArray(args.model?.sections) ? args.model.sections : [];

  for (const section of sections) {
    const res = packSection(section, dims, measure, budget);
    if (!res.ok) {
      // Fail SAFE: return no slides so a sub-readable slide can never be used.
      return {
        ok: false,
        slides: [],
        diagnostics: {
          slideCount: 0,
          splits: budget.splits,
          minScale: budget.failScale,
          iterations: budget.iterations,
          overflowSlides: 1,
          reason: res.reason,
          containmentPass: false,
        },
      };
    }
    slides.push(...res.slides);
  }

  return {
    ok: true,
    slides,
    diagnostics: {
      slideCount: slides.length,
      splits: budget.splits,
      minScale: slides.length > 0 ? budget.minScale : 1,
      iterations: budget.iterations,
      overflowSlides: 0,
      containmentPass: true,
    },
  };
}

// ---------------------------------------------------------------------------
// planScrollContainment — scroll docs need horizontal containment only
// ---------------------------------------------------------------------------

/** Flatten the whole model into a single full-width column (doc title + sections). */
function flattenModel(model: ContentModel): ContentBlock[] {
  const out: ContentBlock[] = [];
  if (model?.title) out.push({ kind: 'heading', level: 1, text: model.title });
  const sections = Array.isArray(model?.sections) ? model.sections : [];
  for (const s of sections) {
    if (s.kicker) out.push({ kind: 'kicker', text: s.kicker });
    if (s.title) out.push({ kind: 'heading', level: 2, text: s.title });
    if (Array.isArray(s.blocks)) out.push(...s.blocks);
  }
  return out;
}

/**
 * Assert the scroll layout needs only HORIZONTAL containment. A scroll document
 * is a single vertical column: vertical height may exceed the viewport (scroll
 * is allowed) regardless of orientation; horizontal overflow is a FAILURE.
 * Uses the same injected `measure` for the full-width column.
 */
export async function planScrollContainment(
  args: PlanScrollContainmentArgs,
): Promise<ScrollContainmentResult> {
  const dims = args.dims ?? slideDimsFor(args.orientation);
  const fontsReady = args.fontsReady ?? noopFontsReady;
  await fontsReady();
  const m = args.measure(flattenModel(args.model), dims, 1);
  return {
    horizontalOverflow: m.contentW > dims.safeW,
    contentW: m.contentW,
    contentH: m.contentH,
    safeW: dims.safeW,
    safeH: dims.safeH,
  };
}
