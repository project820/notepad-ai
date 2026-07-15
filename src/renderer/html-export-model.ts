/**
 * html-export-model.ts — the small shared enums the HTML-export wizard still owns.
 *
 * After the R1 cutover the model authors HTML/CSS directly (main-owned pipeline),
 * so the legacy JSON ContentModel, its validators, and the deterministic renderer
 * are gone. What remains here is the config-surface contract the wizard reads:
 * the summary/chart strength (A/B/C/D) and the design.md provenance enum.
 */

/** Summary / visualization strength chosen per generation (AC: user-selected). */
export type SummaryChartMode = 'A' | 'B' | 'C' | 'D';
export const SUMMARY_CHART_MODES: readonly SummaryChartMode[] = ['A', 'B', 'C', 'D'];

/** Where the design.md came from (kept for the manifest + theme provenance). */
export type DesignSource = 'getdesign' | 'custom' | 'default' | 'none';

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
