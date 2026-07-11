/**
 * html-export-state.ts — pure reducer for the HTML-export wizard (G002).
 *
 * No side effects, no DOM, no IPC: `htmlExportReducer(state, event) -> state`.
 * The controller (`html-export-wizard.ts`) owns fetch/AI side effects and feeds
 * their results back in as events. The user makes four core selections —
 * orientation, layout, a design.md, and summary/chart strength (A/B/C/D) — plus
 * a free-text requirement; "generate" composes them into a single content-model
 * prompt. A design is mandatory: a failed fetch keeps the user on choose-design,
 * and the only no-fetch path forward is an explicit "use the default design".
 * The deterministic HTML renderer lands later (G004); for now AI_DONE holds the
 * validated ContentModel rather than authored HTML.
 */

import type { SummaryChartMode, DesignSource, ContentModel } from './html-export-model';

export type Orientation = 'vertical' | 'horizontal';
export type LayoutKind = 'scroll' | 'slides';

/** Entry mode for the advanced panel: auto = read-good defaults; detail = extra knobs. */
type HtmlExportMode = 'auto' | 'detail';
/** Generation purpose — an optional ADVANCED knob (no longer part of the 4-core flow). */
export type HtmlPurpose =
  | 'presentation'
  | 'report'
  | 'landing'
  | 'blog'
  | 'portfolio'
  | 'proposal'
  | 'custom';
/** Optional advanced density + reading-width knobs. */
export type Density = 'compact' | 'normal' | 'roomy';
export type ReadableWidth = 'narrow' | 'normal' | 'wide';

type HtmlExportStep =
  | 'idle'
  | 'choose-orientation'
  | 'choose-layout'
  | 'choose-design'
  | 'fetching-design'
  | 'summary-requirement'
  | 'token-warning'
  | 'generating'
  | 'generated'
  | 'error';

export type HtmlExportState = {
  step: HtmlExportStep;
  orientation?: Orientation;
  layout?: LayoutKind;
  /** Present only when a design.md was successfully fetched. */
  design?: { rawUrl: string; designMd: string };
  /** Provenance of the chosen design (drives the request's designSource). */
  designSource?: DesignSource;
  /** Set when the most recent design fetch failed (keeps the user on choose-design). */
  fetchError?: string;
  /** Core selection: summary/chart strength A/B/C/D. */
  summaryChartMode?: SummaryChartMode;
  /** Core selection: the user's free-text requirement (renamed from the old 'tone'). */
  freeRequirement?: string;
  /** Advanced (optional): auto vs detail entry; auto fills read-good defaults. */
  mode?: HtmlExportMode;
  /** Advanced (optional): purpose preset (or 'custom' with customPurpose text). */
  purpose?: HtmlPurpose;
  customPurpose?: string;
  /** Advanced (optional): detail-mode overrides. */
  density?: Density;
  readableWidth?: ReadableWidth;
  interactive?: boolean;
  /** Free requirement awaiting an explicit token-warning confirmation before generation. */
  pendingRequirement?: string;
  /** The validated content model held in renderer memory (the AI_DONE result). */
  contentModel?: ContentModel;
  /** Error message for the error step. */
  error?: string;
};

export type HtmlExportEvent =
  | { type: 'START' }
  | { type: 'SET_MODE'; mode: HtmlExportMode }
  | { type: 'SELECT_ORIENTATION'; orientation: Orientation }
  | { type: 'SELECT_LAYOUT'; layout: LayoutKind }
  | { type: 'SUBMIT_DESIGN'; input: string }
  | { type: 'FETCH_OK'; rawUrl: string; designMd: string }
  | { type: 'FETCH_FAIL'; error: string }
  | { type: 'USE_DEFAULT_DESIGN' }
  | { type: 'SELECT_SUMMARY_CHART'; mode: SummaryChartMode }
  | {
      type: 'SUBMIT_REQUIREMENT';
      freeRequirement: string;
      summaryChartMode: SummaryChartMode;
      tokenWarning?: boolean;
      purpose?: HtmlPurpose;
      customPurpose?: string;
      density?: Density;
      readableWidth?: ReadableWidth;
      interactive?: boolean;
    }
  | { type: 'CONFIRM_TOKEN_WARNING' }
  | { type: 'AI_DONE'; model: ContentModel }
  | { type: 'AI_ERROR'; error: string }
  | { type: 'BACK' }
  | { type: 'CANCEL' };

export const initialHtmlExportState: HtmlExportState = { step: 'idle' };

/** The previous step a `BACK` event returns to from each backable step. */
function back(state: HtmlExportState): HtmlExportState {
  switch (state.step) {
    case 'choose-layout':
      return { ...state, step: 'choose-orientation' };
    case 'choose-design':
      return { ...state, step: 'choose-layout', fetchError: undefined };
    case 'summary-requirement':
      return { ...state, step: 'choose-design' };
    case 'token-warning':
      return { ...state, step: 'summary-requirement' };
    case 'generated':
      return { ...state, step: 'summary-requirement' };
    case 'error':
      // The only error is a generation failure — return to the summary step.
      return { ...state, step: 'summary-requirement', error: undefined };
    default:
      return state;
  }
}

export function htmlExportReducer(state: HtmlExportState, event: HtmlExportEvent): HtmlExportState {
  switch (event.type) {
    case 'START':
      return { step: 'choose-orientation', mode: state.mode };

    case 'SET_MODE':
      return { ...state, mode: event.mode };

    case 'SELECT_ORIENTATION':
      if (state.step !== 'choose-orientation') return state;
      return { ...state, step: 'choose-layout', orientation: event.orientation };

    case 'SELECT_LAYOUT':
      // Every orientation×layout combo is allowed (incl. vertical + slides).
      if (state.step !== 'choose-layout') return state;
      return { ...state, step: 'choose-design', layout: event.layout };

    case 'SUBMIT_DESIGN':
      if (state.step !== 'choose-design') return state;
      return { ...state, step: 'fetching-design', fetchError: undefined };

    case 'FETCH_OK':
      if (state.step !== 'fetching-design') return state;
      return {
        ...state,
        step: 'summary-requirement',
        design: { rawUrl: event.rawUrl, designMd: event.designMd },
        designSource: 'getdesign',
        fetchError: undefined,
      };

    case 'FETCH_FAIL':
      // design.md is mandatory: stay on choose-design with a visible error.
      // NEVER silently proceed to the next step with no design.
      if (state.step !== 'fetching-design') return state;
      return {
        ...state,
        step: 'choose-design',
        design: undefined,
        designSource: undefined,
        fetchError: event.error,
      };

    case 'USE_DEFAULT_DESIGN':
      // The only no-fetch path forward: an explicit choice of the built-in theme.
      if (state.step !== 'choose-design') return state;
      return {
        ...state,
        step: 'summary-requirement',
        design: undefined,
        designSource: 'default',
        fetchError: undefined,
      };

    case 'SELECT_SUMMARY_CHART':
      if (state.step !== 'summary-requirement') return state;
      return { ...state, summaryChartMode: event.mode };

    case 'SUBMIT_REQUIREMENT': {
      // Valid from summary-requirement (first run) or generated (regenerate).
      if (state.step !== 'summary-requirement' && state.step !== 'generated') return state;
      const cfg = {
        summaryChartMode: event.summaryChartMode,
        purpose: event.purpose ?? state.purpose,
        customPurpose: event.customPurpose ?? state.customPurpose,
        density: event.density ?? state.density,
        readableWidth: event.readableWidth ?? state.readableWidth,
        interactive: event.interactive ?? state.interactive,
      };
      if (event.tokenWarning) {
        return {
          ...state,
          ...cfg,
          step: 'token-warning',
          freeRequirement: event.freeRequirement,
          pendingRequirement: event.freeRequirement,
        };
      }
      return {
        ...state,
        ...cfg,
        step: 'generating',
        freeRequirement: event.freeRequirement,
        pendingRequirement: undefined,
      };
    }

    case 'CONFIRM_TOKEN_WARNING':
      if (state.step !== 'token-warning') return state;
      return {
        ...state,
        step: 'generating',
        freeRequirement: state.pendingRequirement ?? state.freeRequirement,
        pendingRequirement: undefined,
      };

    case 'AI_DONE':
      if (state.step !== 'generating') return state;
      return { ...state, step: 'generated', contentModel: event.model, error: undefined };

    case 'AI_ERROR':
      if (state.step !== 'generating') return state;
      return { ...state, step: 'error', error: event.error };

    case 'BACK':
      return back(state);

    case 'CANCEL':
      return { step: 'idle' };

    default:
      return state;
  }
}

/** Per-purpose read-good defaults. Auto mode applies these; detail mode lets the
 *  user override density/readableWidth/interactive on top. */
export type PurposePreset = {
  density: Density;
  readableWidth: ReadableWidth;
  typography: 'compact' | 'normal' | 'large';
  interactive: boolean;
  /** One-line intent injected into the generation prompt. */
  brief: string;
};

export const HTML_PURPOSE_PRESETS: Record<Exclude<HtmlPurpose, 'custom'>, PurposePreset> = {
  presentation: { density: 'roomy', readableWidth: 'wide', typography: 'large', interactive: true,
    brief: 'A presentation deck: bold, scannable slides with large type, strong visual hierarchy, minimal text per view.' },
  report: { density: 'compact', readableWidth: 'normal', typography: 'normal', interactive: false,
    brief: 'A formal report/document: dense but legible, clear sections and headings, tables and figures, print-friendly.' },
  landing: { density: 'roomy', readableWidth: 'wide', typography: 'large', interactive: true,
    brief: 'A marketing landing page: a strong hero, generous sectioned rhythm, clear calls-to-action, persuasive layout.' },
  blog: { density: 'normal', readableWidth: 'narrow', typography: 'normal', interactive: false,
    brief: 'A blog/article: a single comfortable reading column, excellent typography, restrained accents.' },
  portfolio: { density: 'normal', readableWidth: 'wide', typography: 'large', interactive: true,
    brief: 'A portfolio/résumé: confident visual identity, project/section cards, balanced whitespace.' },
  proposal: { density: 'normal', readableWidth: 'normal', typography: 'normal', interactive: false,
    brief: 'A proposal: structured and persuasive, clear sections (summary, scope, timeline, pricing), professional polish.' },
};

/** Resolve the effective config for a purpose (+ user overrides). Custom uses
 *  balanced defaults and the user's free-text purpose as the brief. */
export function resolvePurposeConfig(args: {
  purpose?: HtmlPurpose;
  customPurpose?: string;
  density?: Density;
  readableWidth?: ReadableWidth;
  interactive?: boolean;
}): { purpose: HtmlPurpose; density: Density; readableWidth: ReadableWidth; typography: 'compact' | 'normal' | 'large'; interactive: boolean; brief: string } {
  const purpose: HtmlPurpose = args.purpose ?? 'report';
  const base: PurposePreset =
    purpose === 'custom'
      ? {
          density: 'normal',
          readableWidth: 'normal',
          typography: 'normal',
          interactive: false,
          brief: (args.customPurpose?.trim() || 'A clean, purpose-fit web document.'),
        }
      : HTML_PURPOSE_PRESETS[purpose];
  return {
    purpose,
    density: args.density ?? base.density,
    readableWidth: args.readableWidth ?? base.readableWidth,
    typography: base.typography,
    interactive: args.interactive ?? base.interactive,
    brief: base.brief,
  };
}
