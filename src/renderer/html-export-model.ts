/**
 * html-export-model.ts — the deterministic HTML-export data contract (G001).
 *
 * Two halves:
 *  1. HtmlExportRequest — everything the user/wizard selects, fed into ONE prompt
 *     block (see html-export-content-prompt.ts). Selections are carried verbatim
 *     so the deterministic engine can enforce + a manifest can prove reflection.
 *  2. ContentModel — the bounded JSON the AI returns. The AI produces CONTENT
 *     only (summary/structure/chart specs); it never authors HTML/CSS/JS. The
 *     renderer (later stories) owns all layout. `validateContentModel` is the
 *     hard gate: malformed / oversized / HTML-ish output is rejected so a bad
 *     model can never reach the renderer (and never overflow).
 *
 * Pure module: no DOM, no electron, no node — safe in the renderer bundle and
 * fully unit-testable.
 */

import type { Orientation, LayoutKind } from './html-export-state';

/** Summary / visualization strength chosen per generation (AC: user-selected). */
export type SummaryChartMode = 'A' | 'B' | 'C' | 'D';
export const SUMMARY_CHART_MODES: readonly SummaryChartMode[] = ['A', 'B', 'C', 'D'];

/** Where the design.md came from (kept for the manifest + theme provenance). */
export type DesignSource = 'getdesign' | 'custom' | 'default' | 'none';

/** Everything the wizard selects — composed into a single prompt block. */
export type HtmlExportRequest = {
  orientation: Orientation; // 'vertical' | 'horizontal'
  layout: LayoutKind; // 'scroll' | 'slides'
  designSource: DesignSource;
  /** Raw design.md content (clamped before prompting); '' when none. */
  designMd: string;
  summaryChartMode: SummaryChartMode;
  /** User free-text requirement (the renamed, clearly-labelled field). */
  freeRequirement: string;
  /** Source markdown document. */
  markdown: string;
  model?: string;
};

// ---------------------------------------------------------------------------
// ContentModel — the AI's JSON output (content only, never layout)
// ---------------------------------------------------------------------------

export type ChartType = 'bar' | 'line' | 'pie' | 'donut' | 'timeline';
export const CHART_TYPES: readonly ChartType[] = ['bar', 'line', 'pie', 'donut', 'timeline'];

export type ChartSeries = { name?: string; values: number[] };
export type ChartSpec = {
  type: ChartType;
  title?: string;
  labels: string[];
  series: ChartSeries[];
  unit?: string;
  note?: string;
};

export type ContentBlock =
  | { kind: 'kicker'; text: string }
  | { kind: 'heading'; level: 1 | 2 | 3 | 4; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'table'; headers: string[]; rows: string[][] }
  | { kind: 'code'; language?: string; code: string }
  | { kind: 'quote'; text: string }
  | { kind: 'callout'; tone?: string; text: string }
  | { kind: 'chart'; chart: ChartSpec };

export type ContentSection = {
  title?: string;
  kicker?: string;
  blocks: ContentBlock[];
};

export type ContentModel = {
  title: string;
  sections: ContentSection[];
};

// ---------------------------------------------------------------------------
// Bounds — guard against oversized AI output that could never fit / DoS layout
// ---------------------------------------------------------------------------

export const CONTENT_LIMITS = {
  maxSections: 200,
  maxBlocksPerSection: 200,
  maxBlocksTotal: 1500,
  maxTextLen: 20_000,
  maxListItems: 200,
  maxTableRows: 500,
  maxTableCols: 40,
  maxCodeLen: 50_000,
  maxChartsTotal: 200,
  maxChartLabels: 200,
  maxChartSeries: 24,
  maxSeriesValues: 500,
  maxTitleLen: 600,
} as const;

export type ValidateResult =
  | { ok: true; model: ContentModel }
  | { ok: false; error: string };

const BLOCK_KINDS = new Set([
  'kicker',
  'heading',
  'paragraph',
  'list',
  'table',
  'code',
  'quote',
  'callout',
  'chart',
]);

function isStr(v: unknown): v is string {
  return typeof v === 'string';
}
function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
/** Reject AI output that smuggles HTML/CSS/JS (the engine owns markup, not the model). */
function looksLikeHtml(v: string): boolean {
  return /<!doctype html|<html[\s>]|<style[\s>]|<script[\s>]|<body[\s>]|<div[\s>]/i.test(v);
}

function validateChart(c: unknown, path: string): string | null {
  if (typeof c !== 'object' || c === null) return `${path}: chart must be an object`;
  const chart = c as Record<string, unknown>;
  if (!CHART_TYPES.includes(chart.type as ChartType)) return `${path}.type invalid`;
  if (!Array.isArray(chart.labels) || chart.labels.length > CONTENT_LIMITS.maxChartLabels) {
    return `${path}.labels invalid/oversized`;
  }
  if (!chart.labels.every(isStr)) return `${path}.labels must be strings`;
  if (!Array.isArray(chart.series) || chart.series.length === 0 || chart.series.length > CONTENT_LIMITS.maxChartSeries) {
    return `${path}.series invalid/oversized`;
  }
  for (let i = 0; i < chart.series.length; i++) {
    const s = chart.series[i] as Record<string, unknown>;
    if (typeof s !== 'object' || s === null) return `${path}.series[${i}] invalid`;
    if (s.name !== undefined && !isStr(s.name)) return `${path}.series[${i}].name invalid`;
    if (!Array.isArray(s.values) || s.values.length > CONTENT_LIMITS.maxSeriesValues) {
      return `${path}.series[${i}].values invalid/oversized`;
    }
    if (!s.values.every(isFiniteNum)) return `${path}.series[${i}].values must be finite numbers`;
  }
  return null;
}

function validateBlock(b: unknown, path: string, counters: { charts: number }): string | null {
  if (typeof b !== 'object' || b === null) return `${path} must be an object`;
  const block = b as Record<string, unknown>;
  const kind = block.kind;
  if (!isStr(kind) || !BLOCK_KINDS.has(kind)) return `${path}.kind invalid`;

  const checkText = (key: string, max = CONTENT_LIMITS.maxTextLen): string | null => {
    const t = block[key];
    if (!isStr(t)) return `${path}.${key} must be a string`;
    if (t.length > max) return `${path}.${key} exceeds ${max} chars`;
    if (looksLikeHtml(t)) return `${path}.${key} contains raw HTML (forbidden)`;
    return null;
  };

  switch (kind) {
    case 'kicker':
    case 'paragraph':
    case 'quote':
      return checkText('text');
    case 'callout': {
      if (block.tone !== undefined && !isStr(block.tone)) return `${path}.tone invalid`;
      return checkText('text');
    }
    case 'heading': {
      if (![1, 2, 3, 4].includes(block.level as number)) return `${path}.level must be 1-4`;
      return checkText('text');
    }
    case 'list': {
      if (typeof block.ordered !== 'boolean') return `${path}.ordered must be boolean`;
      if (!Array.isArray(block.items) || block.items.length > CONTENT_LIMITS.maxListItems) {
        return `${path}.items invalid/oversized`;
      }
      for (let i = 0; i < block.items.length; i++) {
        if (!isStr(block.items[i])) return `${path}.items[${i}] must be a string`;
        if ((block.items[i] as string).length > CONTENT_LIMITS.maxTextLen) return `${path}.items[${i}] too long`;
      }
      return null;
    }
    case 'code': {
      if (block.language !== undefined && !isStr(block.language)) return `${path}.language invalid`;
      if (!isStr(block.code)) return `${path}.code must be a string`;
      if ((block.code as string).length > CONTENT_LIMITS.maxCodeLen) return `${path}.code too long`;
      return null;
    }
    case 'table': {
      if (!Array.isArray(block.headers) || block.headers.length > CONTENT_LIMITS.maxTableCols) {
        return `${path}.headers invalid/oversized`;
      }
      if (!block.headers.every(isStr)) return `${path}.headers must be strings`;
      if (!Array.isArray(block.rows) || block.rows.length > CONTENT_LIMITS.maxTableRows) {
        return `${path}.rows invalid/oversized`;
      }
      for (let r = 0; r < block.rows.length; r++) {
        const row = block.rows[r];
        if (!Array.isArray(row) || row.length > CONTENT_LIMITS.maxTableCols) return `${path}.rows[${r}] invalid`;
        if (!row.every(isStr)) return `${path}.rows[${r}] cells must be strings`;
      }
      return null;
    }
    case 'chart': {
      counters.charts += 1;
      if (counters.charts > CONTENT_LIMITS.maxChartsTotal) return `${path}: too many charts`;
      return validateChart(block.chart, `${path}.chart`);
    }
    default:
      return `${path}.kind unsupported`;
  }
}

/**
 * Validate raw parsed JSON into a typed ContentModel. Rejects malformed,
 * oversized, or HTML-smuggling output. Never throws.
 */
export function validateContentModel(input: unknown): ValidateResult {
  if (typeof input !== 'object' || input === null) return { ok: false, error: 'root must be an object' };
  const root = input as Record<string, unknown>;
  if (!isStr(root.title)) return { ok: false, error: 'title must be a string' };
  if (root.title.length > CONTENT_LIMITS.maxTitleLen) return { ok: false, error: 'title too long' };
  if (looksLikeHtml(root.title)) return { ok: false, error: 'title contains raw HTML (forbidden)' };
  if (!Array.isArray(root.sections)) return { ok: false, error: 'sections must be an array' };
  if (root.sections.length === 0) return { ok: false, error: 'sections must not be empty' };
  if (root.sections.length > CONTENT_LIMITS.maxSections) return { ok: false, error: 'too many sections' };

  const counters = { charts: 0 };
  let totalBlocks = 0;
  for (let s = 0; s < root.sections.length; s++) {
    const sec = root.sections[s] as Record<string, unknown>;
    if (typeof sec !== 'object' || sec === null) return { ok: false, error: `sections[${s}] invalid` };
    if (sec.title !== undefined && !isStr(sec.title)) return { ok: false, error: `sections[${s}].title invalid` };
    if (sec.kicker !== undefined && !isStr(sec.kicker)) return { ok: false, error: `sections[${s}].kicker invalid` };
    if (!Array.isArray(sec.blocks)) return { ok: false, error: `sections[${s}].blocks must be an array` };
    if (sec.blocks.length > CONTENT_LIMITS.maxBlocksPerSection) return { ok: false, error: `sections[${s}].blocks oversized` };
    totalBlocks += sec.blocks.length;
    if (totalBlocks > CONTENT_LIMITS.maxBlocksTotal) return { ok: false, error: 'too many blocks total' };
    for (let b = 0; b < sec.blocks.length; b++) {
      const err = validateBlock(sec.blocks[b], `sections[${s}].blocks[${b}]`, counters);
      if (err) return { ok: false, error: err };
    }
  }
  return { ok: true, model: input as ContentModel };
}

/**
 * Parse an AI reply into a validated ContentModel. Strips a surrounding code
 * fence, slices the outermost JSON object, parses, and validates. Returns an
 * actionable error instead of throwing — callers MUST NOT fall back to raw HTML.
 */
export function parseContentModel(aiText: unknown): ValidateResult {
  if (!isStr(aiText) || !aiText.trim()) return { ok: false, error: 'empty AI response' };
  let text = aiText.trim();
  // Strip a ```json ... ``` (or bare ```) fence if present.
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) text = fence[1].trim();
  // Slice from the first { to the last } to tolerate minor prose around it.
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first < 0 || last <= first) return { ok: false, error: 'no JSON object found in AI response' };
  const slice = text.slice(first, last + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch (e) {
    return { ok: false, error: `AI response is not valid JSON: ${(e as Error).message}` };
  }
  return validateContentModel(parsed);
}

// ---------------------------------------------------------------------------
// A/B/C/D summary + chart policy (drives the prompt; deterministic)
// ---------------------------------------------------------------------------

export type SummaryChartPolicy = {
  mode: SummaryChartMode;
  label: string;
  summarization: string;
  chartPolicy: string;
};

const POLICIES: Record<SummaryChartMode, SummaryChartPolicy> = {
  A: {
    mode: 'A',
    label: 'Visual brief',
    summarization: 'Aggressively summarize: keep only the key points; condense prose into tight bullets and short sections.',
    chartPolicy: 'Visualize generously: turn any numeric, comparative, or time-series data into chart specs.',
  },
  B: {
    mode: 'B',
    label: 'Balanced digest',
    summarization: 'Moderately summarize: keep the meaningful detail but trim filler and redundancy.',
    chartPolicy: 'Chart clear numeric or time-series data; leave ambiguous data as text/tables.',
  },
  C: {
    mode: 'C',
    label: 'Detailed brief',
    summarization: 'Preserve most factual detail; apply only light cleanup and structuring.',
    chartPolicy: 'Only chart high-confidence numeric/time data; otherwise keep tables.',
  },
  D: {
    mode: 'D',
    label: 'Source-near appendix',
    summarization: 'Minimal summarization: preserve content closely; prefer splitting/pagination over condensation.',
    chartPolicy: 'Charts optional; never replace critical tables with charts.',
  },
};

export function resolveSummaryChartPolicy(mode: SummaryChartMode): SummaryChartPolicy {
  return POLICIES[mode] ?? POLICIES.A;
}
