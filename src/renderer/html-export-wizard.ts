/**
 * html-export-wizard.ts — controller for the HTML-export wizard (G002).
 *
 * The user makes four core selections — orientation, layout, a design.md, and
 * summary/chart strength (A/B/C/D) — plus one free-text requirement. "Generate"
 * composes ALL of them into the SINGLE direct-authoring prompt
 * (`buildDirectHtmlPrompt`) and calls the main-owned generator, which streams the
 * model, drives the sanitize→resolve→quarantine→finalize pipeline, and returns an
 * opaque FinalizedArtifactId. The model authors the HTML/CSS directly; the renderer
 * never touches bytes. "Save" submits only the opaque IDs to the main atomic writer.
 * Purpose/density/width/interactive are demoted to an optional, collapsed
 * "advanced options" panel.
 */

import {
  htmlExportReducer,
  initialHtmlExportState,

  type HtmlExportEvent,
  type HtmlExportState,
  type HtmlPurpose,
  type Density,
  type ReadableWidth,
} from './html-export-state';

import {
  resolveSummaryChartPolicy,
  SUMMARY_CHART_MODES,
  type SummaryChartMode,
} from './html-export-model';
import {
  resolveDirectExportConfig,
  type DirectExportDensity,
  type DirectExportPurpose,
} from '../shared/html-export-direct-config';
import { buildDirectHtmlPrompt } from './html-export-direct-prompt';
import type { GenerationAttemptResult } from '../main/html-export-generation-orchestrator';
import type { FinalizedArtifactId, HtmlExportAttemptId } from '../shared/html-export-pipeline';

import { formatContextWindow } from '../main/ai/output-budget';
import { isAiProviderId, type AiProviderId } from '../main/ai/types';
import { modelKey, parseModelKey } from './model-key';
import { defaultHtmlFileName } from './html-export-prompt';

/** A model choice for HTML generation (provider + id, with optional context size). */
type HtmlModelChoice = { provider: string; id: string; label?: string; contextWindow?: number };


export type HtmlExportDeps = {
  getMarkdown: () => string;
  /** Current document path — seeds the default save filename. */
  getCurrentPath?: () => string | null;
  /** Pending (unsaved) document title — seeds the default save filename. */
  getPendingTitle?: () => string | null;
  /** Max source-markdown chars for the chosen model (sized to its context window).
   *  Omitted → the prompt builder's generous default. */
  maxSourceCharsForModel?: (model: HtmlModelChoice | undefined) => number;
  /** Models offered in the HTML-only model picker. Omitted/empty → no picker shown. */
  listHtmlModels?: () => Promise<HtmlModelChoice[]>;
  /** Default model to preselect (last HTML model, else the main model). */
  getDefaultModel?: () => HtmlModelChoice | string | undefined;
  /** Persist the user's HTML-model choice. */
  onModelChosen?: (model: HtmlModelChoice) => void;
  fetchDesignMd: (input: string) => Promise<{ ok: boolean; designMd?: string; rawUrl?: string; error?: string }>;
  /** List available getdesign designs (the catalog index). Omitted → text input only. */
  listDesigns?: () => Promise<{ ok: boolean; designs?: { slug: string; name: string; pageUrl: string }[]; error?: string }>;
  /** Save the main-held finalized artifact as a single .html via the native save dialog. */
  saveHtmlFinalized: (args: { attemptId: HtmlExportAttemptId; finalizedArtifactId: FinalizedArtifactId; defaultName?: string }) => Promise<{ saved: boolean; filePath?: string; error?: string }>;
  /** Open a previously saved .html in the user's browser. */
  openSavedHtml?: (filePath: string) => Promise<{ opened: boolean; error?: string }>;
  /** Main-owned generation: streams the model, drives the pipeline, and finalizes. */
  generateHtmlExport: (request: { prompt: string; model: { provider: AiProviderId; id: string }; instructions?: string }) => Promise<GenerationAttemptResult>;
  /** Cancel the in-flight main-owned generation for this window. */
  cancelHtmlGeneration?: () => void;
  /** Open an external URL (the getdesign.md gallery). */
  openExternal?: (url: string) => void;
  /** Called when the user cancels the wizard. */
  onCancel?: () => void;
  t: (key: string) => string;
};

export type HtmlExportWizardHandle = {
  destroy: () => void;
  getState: () => HtmlExportState;
};

const GALLERY_URL = 'https://getdesign.md/';

/** A model whose context window is at/below this (tokens) is "small" for HTML
 *  export — full documents may be weakened or truncated. Effectively flags local
 *  models; cloud models all report far larger windows. */
const HTML_SMALL_CONTEXT_TOKENS = 32_768;

/** Default summary/chart strength when the user has not picked one (balanced digest). */
const DEFAULT_SUMMARY_MODE: SummaryChartMode = 'B';

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function errMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return fallback;
}

export function mountHtmlExportWizard(host: HTMLElement, deps: HtmlExportDeps): HtmlExportWizardHandle {
  const t = deps.t;
  let state = htmlExportReducer(initialHtmlExportState, { type: 'START' });
  let disposed = false;
  /** True while a main-owned generation is streaming for this window. */
  let generating = false;
  /** Monotonic generation token so a stale result never lands after a newer start/cancel. */
  let generationToken = 0;
  /** Direct-export prompt computed at requirement submission, consumed when generation starts. */
  let pendingPrompt = '';
  /** Model chosen for this generation (read from the picker at requirement submission). */
  let pendingModel: HtmlModelChoice | undefined;
  /** Models for the HTML-only picker, loaded once on mount. */
  let htmlModels: HtmlModelChoice[] = [];
  /** Save flow (the `generated` step): the deterministic engine owns layout. */
  let saving = false;
  let saveError: string | null = null;
  let savedPath: string | null = null;

  // Load the model list once; re-render the (summary-requirement) step when it arrives.
  if (deps.listHtmlModels) {
    deps
      .listHtmlModels()
      .then((ms) => {
        if (disposed) return;
        // The list is already HTML-allowlist-filtered by the caller
        // (filterHtmlExportModels). Do NOT re-apply the general chat display
        // policy here — it drops allowlisted local providers (e.g. LM Studio)
        // that are not the current selection, hiding them from the HTML picker
        // even though they are valid HTML-export targets (#29 review).
        htmlModels = (Array.isArray(ms) ? ms : []) as HtmlModelChoice[];
        if (state.step === 'summary-requirement') render();
      })
      .catch(() => {
        /* no picker; generation falls back to the default model */
      });
  }

  /** getdesign catalog entries, loaded once on mount (empty until/if they arrive). */
  let designList: { slug: string; name: string; pageUrl: string }[] = [];
  if (deps.listDesigns) {
    deps
      .listDesigns()
      .then((res) => {
        if (disposed) return;
        designList = res?.ok && Array.isArray(res.designs) ? res.designs : [];
        if (state.step === 'choose-design') render();
      })
      .catch(() => {
        /* text input still works without the catalog */
      });
  }

  function defaultModelKey(): string | undefined {
    const d = deps.getDefaultModel?.();
    if (!d) return undefined;
    return typeof d === 'string' ? `chatgpt:${d}` : modelKey(d);
  }
  /** The model the user picked (or the default when no picker is shown). */
  function readSelectedModel(): HtmlModelChoice | undefined {
    const v = field<HTMLSelectElement>('model')?.value;
    if (v) return parseModelKey(v);
    const d = deps.getDefaultModel?.();
    if (!d) return undefined;
    return typeof d === 'string' ? { provider: 'chatgpt', id: d } : d;
  }
  function isSmallContext(m: HtmlModelChoice | undefined): boolean {
    return !!m && typeof m.contextWindow === 'number' && m.contextWindow > 0 && m.contextWindow <= HTML_SMALL_CONTEXT_TOKENS;
  }
  function modelNoteHtml(selectedKey: string | undefined): string {
    const small = isSmallContext(htmlModels.find((m) => modelKey(m) === selectedKey));
    return `<div class="he-model-note" data-he-note="model"${small ? '' : ' hidden'}>${small ? esc(t('he.smallContext')) : ''}</div>`;
  }
  function modelPickerHtml(): string {
    if (!htmlModels.length) return '';
    const sel = defaultModelKey();
    const opts = htmlModels
      .map((m) => {
        const k = modelKey(m);
        const badge = m.contextWindow ? formatContextWindow(m.contextWindow) : '';
        const text = badge ? `${m.label || m.id} · ${badge}` : m.label || m.id;
        return `<option value="${esc(k)}"${k === sel ? ' selected' : ''}>${esc(text)}</option>`;
      })
      .join('');
    // The note reflects the option the browser shows selected: the default when
    // it matches a listed model, otherwise the first option.
    const effectiveSel = htmlModels.some((m) => modelKey(m) === sel) ? sel : modelKey(htmlModels[0]);
    return `<label class="he-model-label" for="he-model">${esc(t('he.model'))}</label>
          <select class="he-select" id="he-model" data-he-field="model">${opts}</select>
          ${modelNoteHtml(effectiveSel)}`;
  }
  /** Toggle the small-context advisory when the model selection changes. */
  function onModelChange(event: Event) {
    const el = event.target as HTMLElement | null;
    if (!el || !host.contains(el)) return;
    // Purpose select toggles the free-text custom-purpose input inline (no re-render).
    if (el.dataset?.heField === 'purpose') {
      const custom = host.querySelector<HTMLInputElement>('[data-he-field="custom-purpose"]');
      if (custom) custom.hidden = (el as HTMLSelectElement).value !== 'custom';
      return;
    }
    if (el.dataset?.heField !== 'model') return;
    const note = host.querySelector<HTMLElement>('[data-he-note="model"]');
    if (!note) return;
    const small = isSmallContext(htmlModels.find((m) => modelKey(m) === (el as HTMLSelectElement).value));
    note.hidden = !small;
    note.textContent = small ? t('he.smallContext') : '';
  }
  /** Keep the free-requirement text in state so re-renders (A/B/C/D, mode toggle) don't wipe it. */
  function onInput(event: Event) {
    const el = event.target as HTMLElement | null;
    if (!el || !host.contains(el)) return;
    if (el.dataset?.heField === 'free-requirement') {
      state = { ...state, freeRequirement: (el as HTMLTextAreaElement).value };
    }
  }

  function dispatch(event: HtmlExportEvent) {
    if (disposed) return;
    state = htmlExportReducer(state, event);
    render();
  }

  // ---- side-effect drivers (explicit; not render-driven) ----

  async function submitDesign() {
    // Guard against a double-submit (e.g. rapid double-click before re-render):
    // only act while we are still on the design step.
    if (state.step !== 'choose-design') return;
    const input = field<HTMLInputElement>('design')?.value.trim() ?? '';
    // design.md is mandatory: an empty input is a no-op (use "default design" to skip a fetch).
    if (!input) return;
    dispatch({ type: 'SUBMIT_DESIGN', input });
    try {
      const res = await deps.fetchDesignMd(input);
      if (disposed) return;
      if (res.ok && res.designMd && res.rawUrl) {
        dispatch({ type: 'FETCH_OK', rawUrl: res.rawUrl, designMd: res.designMd });
      } else {
        dispatch({ type: 'FETCH_FAIL', error: res.error ?? t('he.error.fetch') });
      }
    } catch (err) {
      if (disposed) return;
      dispatch({ type: 'FETCH_FAIL', error: errMessage(err, t('he.error.fetch')) });
    }
  }

  function mapPurpose(p?: HtmlPurpose): DirectExportPurpose {
    switch (p) {
      case 'presentation': return 'presentation';
      case 'report': return 'report';
      case 'landing': return 'landing';
      default: return 'document';
    }
  }
  function mapDensity(d?: Density): DirectExportDensity | undefined {
    switch (d) {
      case 'compact': return 'minimal';
      case 'normal': return 'balanced';
      case 'roomy': return 'full';
      default: return undefined;
    }
  }

  /** Build the direct HTML-authoring prompt from the current selections + document. */
  function buildDirectPrompt(): { prompt: string; withinSinglePass: boolean } {
    // Advanced knobs only apply in the DETAIL advanced mode; in AUTO they must not
    // leak a prior detail selection into the prompt. custom-purpose only applies
    // when the chosen purpose is actually 'custom'. summary/chart mode is a core
    // control and always applies.
    const detail = state.mode === 'detail';
    const config = resolveDirectExportConfig({
      purpose: mapPurpose(state.purpose),
      orientation: state.orientation === 'horizontal' ? 'landscape' : 'portrait',
      mode: state.layout === 'slides' ? 'slide' : 'scroll',
      density: detail ? mapDensity(state.density) : undefined,
      designMd: state.design?.designMd,
      userRequest: state.freeRequirement,
      model: pendingModel ? modelKey(pendingModel) : undefined,
      summaryChartMode: state.summaryChartMode,
      readableWidth: detail ? state.readableWidth : undefined,
      interactive: detail ? state.interactive : undefined,
      customPurpose: state.purpose === 'custom' ? state.customPurpose : undefined,
    });
    const { prompt, coverage } = buildDirectHtmlPrompt(config, deps.getMarkdown());
    return { prompt, withinSinglePass: coverage.withinSinglePass };
  }

  function submitRequirement() {
    if (!state.orientation || !state.layout) return;
    // Guard against a double-submit: once we leave the step the first submission
    // already started generation; a second must not orphan a run.
    if (state.step !== 'summary-requirement') return;
    const freeRequirement = field<HTMLTextAreaElement>('free-requirement')?.value.trim() ?? '';
    const summaryChartMode = state.summaryChartMode ?? DEFAULT_SUMMARY_MODE;
    // Advanced (optional) knobs — read only if the advanced panel rendered them.
    const purpose = ((field<HTMLSelectElement>('purpose')?.value as HtmlPurpose) || state.purpose) ?? undefined;
    // Distinguish an absent control (advanced panel not rendered → keep prior state)
    // from a present-but-cleared input (user emptied it → clear it, no stale fallback).
    const customPurposeField = field<HTMLInputElement>('custom-purpose');
    const customPurpose = customPurposeField ? customPurposeField.value.trim() : state.customPurpose;
    const density = ((field<HTMLSelectElement>('density')?.value as Density) || state.density) ?? undefined;
    const readableWidth =
      ((field<HTMLSelectElement>('readable-width')?.value as ReadableWidth) || state.readableWidth) ?? undefined;
    const interactive = field<HTMLInputElement>('interactive')?.checked ?? state.interactive;
    pendingModel = readSelectedModel();
    if (pendingModel) deps.onModelChosen?.(pendingModel);
    dispatch({
      type: 'SUBMIT_REQUIREMENT',
      freeRequirement,
      summaryChartMode,
      tokenWarning: false,
      purpose,
      customPurpose,
      density,
      readableWidth,
      interactive,
    });
    const built = buildDirectPrompt();
    if (!built.withinSinglePass) {
      // Fail-fast: single-pass export cannot host >30k source (outline/batch is deferred).
      pendingPrompt = '';
      dispatch({ type: 'AI_ERROR', error: t('he.error.tooLongSinglePass') });
      return;
    }
    pendingPrompt = built.prompt;
    maybeStartGeneration();
  }

  function confirmTokenWarning() {
    dispatch({ type: 'CONFIRM_TOKEN_WARNING' });
    maybeStartGeneration();
  }

  function regenerate() {
    if (!state.orientation || !state.layout) return;
    const summaryChartMode = state.summaryChartMode ?? DEFAULT_SUMMARY_MODE;
    const freeRequirement = state.freeRequirement ?? '';
    dispatch({ type: 'SUBMIT_REQUIREMENT', freeRequirement, summaryChartMode, tokenWarning: false });
    const built = buildDirectPrompt();
    if (!built.withinSinglePass) {
      pendingPrompt = '';
      dispatch({ type: 'AI_ERROR', error: t('he.error.tooLongSinglePass') });
      return;
    }
    pendingPrompt = built.prompt;
    maybeStartGeneration();
  }

  /** Kick off one main-owned generation attempt: main streams the model, drives the
   *  pipeline (sanitize→resolve→quarantine→finalize), and returns opaque IDs. */
  function maybeStartGeneration() {
    if (state.step !== 'generating' || !pendingPrompt || generating) return;
    const model = pendingModel;
    if (!model || !isAiProviderId(model.provider)) {
      dispatch({ type: 'AI_ERROR', error: t('he.error.generate') });
      return;
    }
    const provider = model.provider;
    generating = true;
    const token = ++generationToken;
    deps
      .generateHtmlExport({ prompt: pendingPrompt, model: { provider, id: model.id } })
      .then((result) => {
        if (disposed || token !== generationToken) return;
        generating = false;
        if (result.state === 'final') {
          dispatch({
            type: 'AI_DONE',
            finalized: { attemptId: result.attemptId, finalizedArtifactId: result.finalizedArtifactId },
          });
        } else {
          // partial / failed / cancelled → no finalized artifact to save; surface as retryable.
          dispatch({ type: 'AI_ERROR', error: t('he.error.generate') });
        }
      })
      .catch(() => {
        if (disposed || token !== generationToken) return;
        generating = false;
        dispatch({ type: 'AI_ERROR', error: t('he.error.generate') });
      });
  }

  /** Save the main-held finalized artifact as a single self-contained .html.
   *  The renderer submits only the opaque IDs; main atomic-writes the gate-passed
   *  bytes and reports the saved path (or a renderer-safe error). */
  async function saveHtmlDocument() {
    const finalized = state.finalized;
    if (saving || !finalized) return;
    saving = true;
    saveError = null;
    savedPath = null;
    render();
    try {
      const defaultName = defaultHtmlFileName({
        currentPath: deps.getCurrentPath?.() ?? null,
        pendingTitle: deps.getPendingTitle?.() ?? null,
        aiHtml: '',
      });
      const result = await deps.saveHtmlFinalized({
        attemptId: finalized.attemptId,
        finalizedArtifactId: finalized.finalizedArtifactId,
        defaultName,
      });
      if (disposed) return;
      saving = false;
      if (result.saved) savedPath = result.filePath ?? null;
      else if (result.error) saveError = t('he.error.save');
      render();
    } catch (err) {
      if (disposed) return;
      saving = false;
      saveError = errMessage(err, t('he.error.save'));
      render();
    }
  }

  // ---- DOM helpers ----

  function field<T extends HTMLElement>(name: string): T | null {
    return host.querySelector<T>(`[data-he-field="${name}"]`);
  }

  function onClick(event: Event) {
    const el = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-he]');
    if (!el || !host.contains(el)) return;
    const action = el.dataset.he;
    if (action === 'design-gallery' || action === 'design-page') event.preventDefault();
    // A/B/C/D summary/chart selection.
    if (action && action.startsWith('summary-')) {
      const mode = action.slice('summary-'.length) as SummaryChartMode;
      if (SUMMARY_CHART_MODES.includes(mode)) dispatch({ type: 'SELECT_SUMMARY_CHART', mode });
      return;
    }
    switch (action) {
      case 'orient-vertical':
        return dispatch({ type: 'SELECT_ORIENTATION', orientation: 'vertical' });
      case 'orient-horizontal':
        return dispatch({ type: 'SELECT_ORIENTATION', orientation: 'horizontal' });
      case 'layout-scroll':
        return dispatch({ type: 'SELECT_LAYOUT', layout: 'scroll' });
      case 'layout-slides':
        return dispatch({ type: 'SELECT_LAYOUT', layout: 'slides' });
      case 'mode-auto':
        return dispatch({ type: 'SET_MODE', mode: 'auto' });
      case 'mode-detail':
        return dispatch({ type: 'SET_MODE', mode: 'detail' });
      case 'design-pick': {
        const input = field<HTMLInputElement>('design');
        if (input) input.value = el.dataset.slug ?? '';
        return;
      }
      case 'design-page':
        return deps.openExternal?.(el.dataset.url ?? '');
      case 'design-submit':
        return void submitDesign();
      case 'design-default':
        return dispatch({ type: 'USE_DEFAULT_DESIGN' });
      case 'design-gallery':
        return deps.openExternal?.(GALLERY_URL);
      case 'generate-submit':
        return submitRequirement();
      case 'token-confirm':
        return confirmTokenWarning();
      case 'regenerate':
        return regenerate();
      case 'save-html':
        return void saveHtmlDocument();
      case 'open-saved':
        if (savedPath) deps.openSavedHtml?.(savedPath);
        return;
      case 'back':
        return dispatch({ type: 'BACK' });
      case 'cancel':
        // Abort any in-flight generation so a slow AI request doesn't keep
        // streaming in the background after the user cancels the wizard.
        generationToken++;
        generating = false;
        deps.cancelHtmlGeneration?.();
        dispatch({ type: 'CANCEL' });
        deps.onCancel?.();
        return;
      default:
        return;
    }
  }

  // ---- rendering ----

  function footer(buttons: string): string {
    return `<div class="he-foot">${buttons}</div>`;
  }
  const backBtn = () => `<button class="he-btn he-ghost" data-he="back" type="button">${esc(t('he.back'))}</button>`;
  const cancelBtn = () => `<button class="he-btn he-ghost" data-he="cancel" type="button">${esc(t('he.cancel'))}</button>`;
  const spinner = (label: string) =>
    `<div class="he-status"><span class="he-spinner" aria-hidden="true"></span><span>${esc(label)}</span></div>`;

  function renderStep(): string {
    switch (state.step) {
      case 'choose-orientation':
        return `
          <div class="he-q">${esc(t('he.orientation.title'))}</div>
          <div class="he-options">
            <button class="he-opt" data-he="orient-vertical" type="button">${esc(t('he.orientation.vertical'))}</button>
            <button class="he-opt" data-he="orient-horizontal" type="button">${esc(t('he.orientation.horizontal'))}</button>
          </div>
          ${footer(cancelBtn())}`;

      case 'choose-layout':
        return `
          <div class="he-q">${esc(t('he.layout.title'))}</div>
          <div class="he-options">
            <button class="he-opt" data-he="layout-scroll" type="button">${esc(t('he.layout.scroll'))}</button>
            <button class="he-opt" data-he="layout-slides" type="button">${esc(t('he.layout.slides'))}</button>
          </div>
          ${footer(backBtn() + cancelBtn())}`;

      case 'choose-design': {
        const rows = designList.length
          ? `<div class="he-design-list" role="listbox">${designList
              .map(
                (d) =>
                  `<div class="he-design-row" title="${esc(d.name)}">` +
                  `<span class="he-design-icon" aria-hidden="true">${esc(d.name.slice(0, 1).toUpperCase())}</span>` +
                  `<button class="he-design-pick" data-he="design-pick" data-slug="${esc(d.slug)}" type="button">${esc(d.name)}</button>` +
                  `<a class="he-link he-design-page" data-he="design-page" data-url="${esc(d.pageUrl)}" href="#" role="button">${esc(t('he.design.galleryLink'))}</a>` +
                  `</div>`,
              )
              .join('')}</div>`
          : '';
        return `
          ${state.fetchError ? `<div class="he-error">${esc(state.fetchError)}</div>` : ''}
          <div class="he-q">${esc(t('he.design.title'))}</div>
          <div class="he-hint">${esc(t('he.design.galleryHint'))}
            <a class="he-link" data-he="design-gallery" href="#" role="button">${esc(t('he.design.galleryLink'))}</a>
          </div>
          ${rows}
          <input class="he-input" data-he-field="design" type="text" placeholder="${esc(t('he.design.input'))}" />
          ${footer(
            backBtn() +
              `<button class="he-btn he-ghost" data-he="design-default" type="button">${esc(t('he.design.useDefault'))}</button>` +
              `<button class="he-btn he-primary" data-he="design-submit" type="button">${esc(t('he.continue'))}</button>`,
          )}`;
      }

      case 'fetching-design':
        return spinner(t('he.fetching'));

      case 'summary-requirement': {
        const mode = state.mode ?? 'auto';
        const chartMode = state.summaryChartMode ?? DEFAULT_SUMMARY_MODE;
        const curPurpose = state.purpose ?? 'report';
        const purposeOpts = (['presentation', 'report', 'landing', 'blog', 'portfolio', 'proposal', 'custom'] as const)
          .map((p) => `<option value="${p}"${p === curPurpose ? ' selected' : ''}>${esc(t(`he.purpose.${p}`))}</option>`)
          .join('');
        const sel = (fieldName: string, opts: ReadonlyArray<readonly [string, string]>, cur?: string) =>
          `<select class="he-select" data-he-field="${fieldName}">` +
          opts.map(([v, label]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`).join('') +
          `</select>`;
        const detail =
          mode === 'detail'
            ? `
          <label class="he-row"><span>${esc(t('he.detail.density'))}</span>${sel('density', [['compact', 'compact'], ['normal', 'normal'], ['roomy', 'roomy']], state.density)}</label>
          <label class="he-row"><span>${esc(t('he.detail.width'))}</span>${sel('readable-width', [['narrow', 'narrow'], ['normal', 'normal'], ['wide', 'wide']], state.readableWidth)}</label>
          <label class="he-row he-check"><input type="checkbox" data-he-field="interactive"${state.interactive ? ' checked' : ''}/> <span>${esc(t('he.detail.interactive'))}</span></label>`
            : '';
        // Core selection: A/B/C/D summary/chart strength.
        const summaryButtons = SUMMARY_CHART_MODES.map(
          (m) =>
            `<button class="he-mode${m === chartMode ? ' he-mode-on' : ''}" data-he="summary-${m}" type="button" title="${esc(resolveSummaryChartPolicy(m).label)}">${esc(t(`he.summary.${m}`))}</button>`,
        ).join('');
        return `
          <div class="he-q">${esc(t('he.summary.title'))}</div>
          <div class="he-modes he-summary-modes" role="group">${summaryButtons}</div>
          <div class="he-q">${esc(t('he.freeReq.title'))}</div>
          <textarea class="he-textarea" data-he-field="free-requirement" rows="3" placeholder="${esc(t('he.freeReq.placeholder'))}">${esc(state.freeRequirement ?? '')}</textarea>
          <details class="he-advanced">
            <summary>${esc(t('he.advanced.title'))}</summary>
            <div class="he-modes">
              <button class="he-mode${mode === 'auto' ? ' he-mode-on' : ''}" data-he="mode-auto" type="button">${esc(t('he.mode.auto'))}</button>
              <button class="he-mode${mode === 'detail' ? ' he-mode-on' : ''}" data-he="mode-detail" type="button">${esc(t('he.mode.detail'))}</button>
            </div>
            <div class="he-q">${esc(t('he.purpose.title'))}</div>
            <select class="he-select" data-he-field="purpose">${purposeOpts}</select>
            <input class="he-input he-custom-purpose" data-he-field="custom-purpose" type="text" value="${esc(state.customPurpose ?? '')}" placeholder="${esc(t('he.purpose.custom'))}"${curPurpose === 'custom' ? '' : ' hidden'}/>
            ${detail}
          </details>
          ${modelPickerHtml()}
          ${footer(
            backBtn() + `<button class="he-btn he-primary" data-he="generate-submit" type="button">${esc(t('he.generate'))}</button>`,
          )}`;
      }

      case 'token-warning':
        return `
          <div class="he-warn">${esc(t('he.tokenWarning'))}</div>
          ${footer(
            backBtn() + `<button class="he-btn he-primary" data-he="token-confirm" type="button">${esc(t('he.continue'))}</button>`,
          )}`;

      case 'generating':
        return spinner(t('he.generating'));

      case 'generated': {
        if (saving) return spinner(t('he.saving'));
        const savedRow = savedPath ? `<div class="he-card-saved">${esc(t('he.result.saved'))}</div>` : '';
        const errRow = saveError ? `<div class="he-error">${esc(saveError)}</div>` : '';
        const openBtn = savedPath
          ? `<button class="he-btn he-ghost" data-he="open-saved" type="button">${esc(t('he.result.open'))}</button>`
          : '';
        return `
          <div class="he-card">
            <div class="he-card-title">${esc(t('he.result.modelReady'))}</div>
            <div class="he-hint">${esc(t('he.result.readyToSave'))}</div>
          </div>
          ${savedRow}${errRow}
          ${footer(
            backBtn() +
              `<button class="he-btn he-ghost" data-he="regenerate" type="button">${esc(t('he.regenerate'))}</button>` +
              openBtn +
              `<button class="he-btn he-primary" data-he="save-html" type="button">${esc(t('he.result.save'))}</button>`,
          )}`;
      }

      case 'error':
        return `
          <div class="he-error">${esc(state.error || t('he.error.generate'))}</div>
          ${footer(cancelBtn() + `<button class="he-btn he-primary" data-he="back" type="button">${esc(t('he.back'))}</button>`)}`;

      default:
        return '';
    }
  }

  function render() {
    host.innerHTML = `<div class="he-wizard" data-he-step="${state.step}">
      <div class="he-head">${esc(t('he.button'))}</div>
      ${renderStep()}
    </div>`;
  }

  host.addEventListener('click', onClick);
  host.addEventListener('change', onModelChange);
  host.addEventListener('input', onInput);
  render();

  return {
    destroy() {
      disposed = true;
      generationToken++;
      generating = false;
      deps.cancelHtmlGeneration?.();
      host.removeEventListener('click', onClick);
      host.removeEventListener('change', onModelChange);
      host.removeEventListener('input', onInput);
      host.innerHTML = '';
    },
    getState: () => state,
  };
}
