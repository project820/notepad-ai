/**
 * html-export-wizard.ts — controller for the HTML-export wizard (G004 / ⑤).
 *
 * Owns the DOM for the `.he-*` panel and drives the pure reducer in
 * `html-export-state.ts`. All side effects (design fetch, AI generation, native
 * save, open-in-browser) are injected dependencies so this module is fully
 * DOM-testable with mocks. The generated HTML is held in memory and never
 * inserted into the Markdown editor — it only flows through the save dialog.
 */

import {
  buildHtmlExportPrompt,
  defaultHtmlFileName,
  extractDocumentTitle,
  extractHtmlDocument,
} from './html-export-prompt';
import {
  htmlExportReducer,
  initialHtmlExportState,
  type HtmlExportEvent,
  type HtmlExportState,
} from './html-export-state';

import { formatContextWindow } from '../main/ai/output-budget';
import { modelKey, parseModelKey } from './model-key';

/** A model choice for HTML generation (provider + id, with optional context size). */
export type HtmlModelChoice = { provider: string; id: string; label?: string; contextWindow?: number };

/** A running AI generation: a promise for the full reply plus a cancel hook. */
export type AiGenerateJob = { result: Promise<string>; cancel: () => void };

export type HtmlExportDeps = {
  getMarkdown: () => string;
  getCurrentPath: () => string | null;
  getPendingTitle: () => string | null;
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
  saveHtml: (args: { html: string; defaultName?: string }) => Promise<{ saved: boolean; filePath?: string }>;
  openSavedHtml: (filePath: string) => Promise<{ opened: boolean; error?: string }>;
  /** Generate HTML for `prompt` using `model` (falls back to the main model when omitted). */
  aiGenerate: (prompt: string, model?: HtmlModelChoice) => AiGenerateJob;
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

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function basename(filePath: string): string {
  return filePath.split(/[/\\]/).pop() || filePath;
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
  let currentJob: AiGenerateJob | null = null;
  /** Prompt computed at tone submission, consumed when generation actually starts. */
  let pendingPrompt = '';
  /** Model chosen for this generation (read from the picker at tone submission). */
  let pendingModel: HtmlModelChoice | undefined;
  /** Models for the HTML-only picker, loaded once on mount. */
  let htmlModels: HtmlModelChoice[] = [];

  // Load the model list once; re-render the (style-tone) step when it arrives.
  if (deps.listHtmlModels) {
    deps
      .listHtmlModels()
      .then((ms) => {
        if (disposed) return;
        htmlModels = Array.isArray(ms) ? ms : [];
        if (state.step === 'style-tone') render();
      })
      .catch(() => {
        /* no picker; generation falls back to the default model */
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
    if (!el || !host.contains(el) || el.dataset?.heField !== 'model') return;
    const note = host.querySelector<HTMLElement>('[data-he-note="model"]');
    if (!note) return;
    const small = isSmallContext(htmlModels.find((m) => modelKey(m) === (el as HTMLSelectElement).value));
    note.hidden = !small;
    note.textContent = small ? t('he.smallContext') : '';
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
    if (!input) {
      dispatch({ type: 'SKIP_DESIGN' });
      return;
    }
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

  function submitTone() {
    if (!state.orientation || !state.layout) return;
    // Guard against a double-submit: once we leave the tone step the first
    // submission already started generation; a second must not orphan a job.
    if (state.step !== 'style-tone') return;
    const tone = field<HTMLTextAreaElement>('tone')?.value.trim() ?? '';
    pendingModel = readSelectedModel();
    if (pendingModel) deps.onModelChosen?.(pendingModel);
    const built = buildHtmlExportPrompt({
      markdown: deps.getMarkdown(),
      orientation: state.orientation,
      layout: state.layout,
      designMd: state.design?.designMd,
      tone,
      maxSourceChars: deps.maxSourceCharsForModel?.(pendingModel),
    });
    pendingPrompt = built.promptDoc;
    dispatch({ type: 'SUBMIT_TONE', tone, tokenWarning: built.warning });
    maybeStartGeneration();
  }

  function confirmTokenWarning() {
    dispatch({ type: 'CONFIRM_TOKEN_WARNING' });
    maybeStartGeneration();
  }

  function regenerate() {
    if (!state.orientation || !state.layout) return;
    // Rebuild from stored params; the user already confirmed any token warning.
    const built = buildHtmlExportPrompt({
      markdown: deps.getMarkdown(),
      orientation: state.orientation,
      layout: state.layout,
      designMd: state.design?.designMd,
      tone: state.tone,
      maxSourceChars: deps.maxSourceCharsForModel?.(pendingModel),
    });
    pendingPrompt = built.promptDoc;
    dispatch({ type: 'SUBMIT_TONE', tone: state.tone ?? '', tokenWarning: false });
    maybeStartGeneration();
  }

  function maybeStartGeneration() {
    if (state.step !== 'generating' || !pendingPrompt) return;
    const job = deps.aiGenerate(pendingPrompt, pendingModel);
    currentJob = job;
    job.result.then(
      (text) => {
        if (disposed || currentJob !== job) return;
        currentJob = null;
        const extracted = extractHtmlDocument(text);
        if (!extracted.ok) {
          dispatch({ type: 'AI_ERROR', error: extracted.error });
          return;
        }
        dispatch({
          type: 'AI_DONE',
          html: extracted.html,
          title: extractDocumentTitle(extracted.html),
          bytes: byteLength(extracted.html),
        });
      },
      (err) => {
        if (disposed || currentJob !== job) return;
        currentJob = null;
        dispatch({ type: 'AI_ERROR', error: errMessage(err, t('he.error.generate')) });
      },
    );
  }

  async function download() {
    if (state.step !== 'generated' || !state.generated) return;
    const generated = state.generated;
    const defaultName = defaultHtmlFileName({
      currentPath: deps.getCurrentPath(),
      pendingTitle: deps.getPendingTitle(),
      aiHtml: generated.html,
    });
    dispatch({ type: 'DOWNLOAD' });
    try {
      const res = await deps.saveHtml({ html: generated.html, defaultName });
      if (disposed) return;
      if (res.saved && res.filePath) dispatch({ type: 'SAVE_OK', savedPath: res.filePath });
      else dispatch({ type: 'SAVE_CANCEL' });
    } catch (err) {
      if (disposed) return;
      dispatch({ type: 'SAVE_ERROR', error: errMessage(err, t('he.error.save')) });
    }
  }

  async function openSaved() {
    if (state.step !== 'saved' || !state.savedPath) return;
    const path = state.savedPath;
    dispatch({ type: 'OPEN_SAVED' });
    try {
      const res = await deps.openSavedHtml(path);
      if (disposed) return;
      if (res.opened) dispatch({ type: 'OPEN_OK' });
      else dispatch({ type: 'OPEN_ERROR', error: res.error ?? t('he.error.open') });
    } catch (err) {
      if (disposed) return;
      dispatch({ type: 'OPEN_ERROR', error: errMessage(err, t('he.error.open')) });
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
    if (action === 'design-gallery') event.preventDefault();
    switch (action) {
      case 'orient-vertical':
        return dispatch({ type: 'SELECT_ORIENTATION', orientation: 'vertical' });
      case 'orient-horizontal':
        return dispatch({ type: 'SELECT_ORIENTATION', orientation: 'horizontal' });
      case 'layout-scroll':
        return dispatch({ type: 'SELECT_LAYOUT', layout: 'scroll' });
      case 'layout-slides':
        return dispatch({ type: 'SELECT_LAYOUT', layout: 'slides' });
      case 'design-submit':
        return void submitDesign();
      case 'design-skip':
        return dispatch({ type: 'SKIP_DESIGN' });
      case 'design-gallery':
        return deps.openExternal?.(GALLERY_URL);
      case 'tone-submit':
        return submitTone();
      case 'token-confirm':
        return confirmTokenWarning();
      case 'download':
        return void download();
      case 'regenerate':
        return regenerate();
      case 'open-saved':
        return void openSaved();
      case 'back':
        return dispatch({ type: 'BACK' });
      case 'cancel':
        // Abort any in-flight generation so a slow AI request doesn't keep
        // streaming in the background after the user cancels the wizard.
        currentJob?.cancel();
        currentJob = null;
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

      case 'choose-design':
        return `
          <div class="he-q">${esc(t('he.design.title'))}</div>
          <div class="he-hint">${esc(t('he.design.galleryHint'))}
            <a class="he-link" data-he="design-gallery" href="#" role="button">${esc(t('he.design.galleryLink'))}</a>
          </div>
          <input class="he-input" data-he-field="design" type="text" placeholder="${esc(t('he.design.input'))}" />
          ${footer(
            backBtn() +
              `<button class="he-btn he-ghost" data-he="design-skip" type="button">${esc(t('he.design.skip'))}</button>` +
              `<button class="he-btn he-primary" data-he="design-submit" type="button">${esc(t('he.continue'))}</button>`,
          )}`;

      case 'fetching-design':
        return spinner(t('he.fetching'));

      case 'style-tone':
        return `
          ${state.fetchError ? `<div class="he-error">${esc(t('he.error.fetch'))}</div>` : ''}
          <div class="he-q">${esc(t('he.tone.title'))}</div>
          <textarea class="he-textarea" data-he-field="tone" rows="3" placeholder="${esc(t('he.tone.placeholder'))}"></textarea>
          ${modelPickerHtml()}
          ${footer(
            backBtn() + `<button class="he-btn he-primary" data-he="tone-submit" type="button">${esc(t('he.generate'))}</button>`,
          )}`;

      case 'token-warning':
        return `
          <div class="he-warn">${esc(t('he.tokenWarning'))}</div>
          ${footer(
            backBtn() + `<button class="he-btn he-primary" data-he="token-confirm" type="button">${esc(t('he.continue'))}</button>`,
          )}`;

      case 'generating':
        return spinner(t('he.generating'));

      case 'generated': {
        const g = state.generated;
        const name = (g?.title || '').trim();
        return `
          <div class="he-card">
            <div class="he-card-title">${esc(t('he.result.title'))}</div>
            ${name ? `<div class="he-card-name">${esc(name)}</div>` : ''}
            <div class="he-card-size">${esc(g ? formatBytes(g.bytes) : '')}</div>
          </div>
          ${footer(
            `<button class="he-btn he-ghost" data-he="regenerate" type="button">${esc(t('he.regenerate'))}</button>` +
              `<button class="he-btn he-primary" data-he="download" type="button">${esc(t('he.download'))}</button>`,
          )}`;
      }

      case 'saving':
        return spinner(t('he.download'));

      case 'saved':
        return `
          <div class="he-card">
            <div class="he-card-title">${esc(t('he.saved'))}</div>
            ${state.savedPath ? `<div class="he-card-name">${esc(basename(state.savedPath))}</div>` : ''}
            ${state.error ? `<div class="he-error">${esc(state.error)}</div>` : ''}
          </div>
          ${footer(`<button class="he-btn he-primary" data-he="open-saved" type="button">${esc(t('he.openSaved'))}</button>`)}`;

      case 'opening-saved':
        return spinner(t('he.openSaved'));

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
  render();

  return {
    destroy() {
      disposed = true;
      currentJob?.cancel();
      currentJob = null;
      host.removeEventListener('click', onClick);
      host.removeEventListener('change', onModelChange);
      host.innerHTML = '';
    },
    getState: () => state,
  };
}
