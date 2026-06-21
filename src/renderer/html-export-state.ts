/**
 * html-export-state.ts — pure reducer for the HTML-export wizard (G004 / ⑤).
 *
 * No side effects, no DOM, no IPC: `htmlExportReducer(state, event) -> state`.
 * The controller (`html-export-wizard.ts`) owns fetch/save/open side effects and
 * feeds their results back in as events. All four orientation×layout combos are
 * reachable (including vertical + slides). A failed design fetch falls back to
 * the tone-only path (style-tone) and never jumps straight to generation.
 */

export type Orientation = 'vertical' | 'horizontal';
export type LayoutKind = 'scroll' | 'slides';

/** Entry mode: auto = minimal picks + read-good defaults; detail = extra knobs. */
export type HtmlExportMode = 'auto' | 'detail';
/** Generation purpose — drives read-good defaults (density/width/typography). */
export type HtmlPurpose =
  | 'presentation'
  | 'report'
  | 'landing'
  | 'blog'
  | 'portfolio'
  | 'proposal'
  | 'custom';
/** Detail-mode density + reading-width knobs (auto applies the purpose default). */
export type Density = 'compact' | 'normal' | 'roomy';
export type ReadableWidth = 'narrow' | 'normal' | 'wide';

/** Resolved design context once the design step is done. */
export type DesignSource =
  | { kind: 'skipped' }
  | { kind: 'fetched'; rawUrl: string; designMd: string };

/** The generated artifact held in renderer memory (never inserted into the doc). */
export type GeneratedHtml = { html: string; title: string; bytes: number };

export type HtmlExportStep =
  | 'idle'
  | 'choose-orientation'
  | 'choose-layout'
  | 'choose-design'
  | 'fetching-design'
  | 'style-tone'
  | 'token-warning'
  | 'generating'
  | 'generated'
  | 'saving'
  | 'saved'
  | 'opening-saved'
  | 'error';

export type HtmlExportState = {
  step: HtmlExportStep;
  orientation?: Orientation;
  layout?: LayoutKind;
  /** Present only when a DESIGN.md was successfully fetched. */
  design?: { rawUrl: string; designMd: string };
  /** Set when the most recent design fetch failed (drives the tone-only fallback UI). */
  fetchError?: string;
  tone?: string;
  /** Auto vs detail entry; auto fills read-good defaults for the rest. */
  mode?: HtmlExportMode;
  /** Generation purpose preset (or 'custom' with customPurpose text). */
  purpose?: HtmlPurpose;
  customPurpose?: string;
  /** Detail-mode overrides (omitted → purpose default). */
  density?: Density;
  readableWidth?: ReadableWidth;
  interactive?: boolean;
  /** Tone awaiting an explicit token-warning confirmation before generation. */
  pendingTone?: string;
  generated?: GeneratedHtml;
  savedPath?: string;
  /** Error message for the error step, or a non-fatal open error shown on the saved card. */
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
  | { type: 'SKIP_DESIGN' }
  | {
      type: 'SUBMIT_TONE';
      tone: string;
      tokenWarning?: boolean;
      purpose?: HtmlPurpose;
      customPurpose?: string;
      density?: Density;
      readableWidth?: ReadableWidth;
      interactive?: boolean;
    }
  | { type: 'CONFIRM_TOKEN_WARNING' }
  | { type: 'AI_DONE'; html: string; title: string; bytes: number }
  | { type: 'AI_ERROR'; error: string }
  | { type: 'DOWNLOAD' }
  | { type: 'SAVE_OK'; savedPath: string }
  | { type: 'SAVE_CANCEL' }
  | { type: 'SAVE_ERROR'; error: string }
  | { type: 'OPEN_SAVED' }
  | { type: 'OPEN_OK' }
  | { type: 'OPEN_ERROR'; error: string }
  | { type: 'BACK' }
  | { type: 'CANCEL' };

export const initialHtmlExportState: HtmlExportState = { step: 'idle' };

/** The previous step a `BACK` event returns to from each backable step. */
function back(state: HtmlExportState): HtmlExportState {
  switch (state.step) {
    case 'choose-layout':
      return { ...state, step: 'choose-orientation' };
    case 'choose-design':
      return { ...state, step: 'choose-layout' };
    case 'style-tone':
      return { ...state, step: 'choose-design', fetchError: undefined };
    case 'token-warning':
      return { ...state, step: 'style-tone' };
    case 'generated':
      return { ...state, step: 'style-tone' };
    case 'saved':
      // Result card is still meaningful — return to it.
      return { ...state, step: 'generated', error: undefined };
    case 'error':
      // A save error keeps the artifact; a generation error sends us back to tone.
      return { ...state, step: state.generated ? 'generated' : 'style-tone', error: undefined };
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
        step: 'style-tone',
        design: { rawUrl: event.rawUrl, designMd: event.designMd },
        fetchError: undefined,
      };

    case 'FETCH_FAIL':
      // Tone-only fallback — never proceeds directly to generation.
      if (state.step !== 'fetching-design') return state;
      return { ...state, step: 'style-tone', design: undefined, fetchError: event.error };

    case 'SKIP_DESIGN':
      if (state.step !== 'choose-design') return state;
      return { ...state, step: 'style-tone', design: undefined, fetchError: undefined };

    case 'SUBMIT_TONE': {
      // Valid from style-tone (first run) or generated (regenerate).
      if (state.step !== 'style-tone' && state.step !== 'generated') return state;
      const cfg = {
        purpose: event.purpose ?? state.purpose,
        customPurpose: event.customPurpose ?? state.customPurpose,
        density: event.density ?? state.density,
        readableWidth: event.readableWidth ?? state.readableWidth,
        interactive: event.interactive ?? state.interactive,
      };
      if (event.tokenWarning) {
        return { ...state, ...cfg, step: 'token-warning', tone: event.tone, pendingTone: event.tone };
      }
      return { ...state, ...cfg, step: 'generating', tone: event.tone, pendingTone: undefined };
    }

    case 'CONFIRM_TOKEN_WARNING':
      if (state.step !== 'token-warning') return state;
      return { ...state, step: 'generating', tone: state.pendingTone ?? state.tone, pendingTone: undefined };

    case 'AI_DONE':
      if (state.step !== 'generating') return state;
      return {
        ...state,
        step: 'generated',
        generated: { html: event.html, title: event.title, bytes: event.bytes },
        error: undefined,
      };

    case 'AI_ERROR':
      if (state.step !== 'generating') return state;
      return { ...state, step: 'error', error: event.error };

    case 'DOWNLOAD':
      if (state.step !== 'generated') return state;
      return { ...state, step: 'saving' };

    case 'SAVE_OK':
      if (state.step !== 'saving') return state;
      return { ...state, step: 'saved', savedPath: event.savedPath, error: undefined };

    case 'SAVE_CANCEL':
      // User dismissed the native save dialog — keep the generated artifact.
      if (state.step !== 'saving') return state;
      return { ...state, step: 'generated' };

    case 'SAVE_ERROR':
      if (state.step !== 'saving') return state;
      return { ...state, step: 'error', error: event.error };

    case 'OPEN_SAVED':
      if (state.step !== 'saved') return state;
      return { ...state, step: 'opening-saved', error: undefined };

    case 'OPEN_OK':
      if (state.step !== 'opening-saved') return state;
      return { ...state, step: 'saved', error: undefined };

    case 'OPEN_ERROR':
      // The saved HTML is not lost — return to the saved card with a visible error.
      if (state.step !== 'opening-saved') return state;
      return { ...state, step: 'saved', error: event.error };

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
