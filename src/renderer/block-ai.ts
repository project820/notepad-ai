import { EditorView, ViewUpdate } from '@codemirror/view';
import { StateEffect } from '@codemirror/state';
import MarkdownIt from 'markdown-it';
import { t, getLocale } from './i18n';
import { aiChatErrorMessage } from './ai-error-message';
import { type Quality } from './quality';
import { openMenu } from './dropdown';
import { buildBlockAiInstructions } from './block-ai-prompt-handler';
import { styleDirective, detectLanguage, type Naturalness } from './humanize-engine';
import { isAiProviderId, type AiProviderId, type ModelRef } from '../main/ai/types';
import { modelKey, parseModelKey } from './model-key';
import { formatContextWindow, modelContextWindowTokens } from '../main/ai/output-budget';
import { applyModelDisplayPolicy, isRouteHiddenModel } from '../main/ai/model-display-policy';
import { triggerCliOnboarding } from './settings-modal';

/** Provider labels for the Block AI model menu. */
const BLOCK_PROVIDER_LABELS: Record<string, string> = {
  chatgpt: 'ChatGPT', claude: 'Claude', openrouter: 'OpenRouter', ollama: 'Ollama', lmstudio: 'LM Studio', grok: 'Grok',
};

/** Provider-aware menu label: ChatGPT uses the compact prettyModel naming; other
 *  providers (Claude / OpenRouter / local) show the raw label/id, which is already
 *  meaningful (e.g. "llama3:latest"). */
function modelLabelFor(provider: string | undefined, id: string, label?: string): string {
  if (!provider || provider === 'chatgpt') return prettyModel(id);
  return label ?? id;
}

/** Approx. char budget for the selected fragment to stay under ~1000 tokens. */
const SELECTION_CHAR_CAP = 2500;
const MODEL_MENU_REFRESH_TIMEOUT_MS = 1_500;

/** Compact display: mini models stay bare; others gain a "GPT" or "Codex" tag
 *  so users can tell family at a glance.
 *  - gpt-5.4-mini       → "5.4 mini"     (mini = GPT implicit)
 *  - gpt-5.1-codex-mini → "5.1 mini"     (mini wins)
 *  - gpt-5.5            → "GPT 5.5"
 *  - gpt-5.4            → "GPT 5.4"
 *  - gpt-5.3-codex      → "Codex 5.3"
 *  - gpt-5.3-codex-spark→ "Codex 5.3 spark"
 *  - gpt-5.1-codex-max  → "Codex 5.1 max" */
function prettyModel(id: string): string {
  const rest = id.toLowerCase().replace(/^gpt-/i, '');
  const isMini = /\bmini\b/.test(rest);
  const isCodex = /\bcodex\b/.test(rest);
  const stripped = rest
    .replace(/-?codex-?/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return id;
  if (isMini) return stripped;
  if (isCodex) return `Codex ${stripped}`;
  return `GPT ${stripped}`;
}

/**
 * Block AI (F3) — text-selection-driven rewrite.
 * Works on BOTH surfaces:
 *   - Source editor (CodeMirror) — selection is a doc range.
 *   - Rich preview (contenteditable) — selection is a DOM Range.
 *
 * Flow:
 *   1. User selects text.
 *   2. A small floating "✦ AI" pill appears near the selection.
 *   3. Click pill (or ⌘⇧A) → instruction popup opens.
 *   4. User types what they want changed (or leaves blank for "improve").
 *   5. Codex returns 3 alternatives separated by `---`.
 *   6. User clicks one → it replaces the selection.
 */


export type BlockAiDeps = {
  view: EditorView;
  previewEl: HTMLElement;
  getModel: () => string | undefined;
  /** Structured Block AI model (provider+id). String/undefined fall back to ChatGPT routing. */
  getBlockModel: () => string | { provider: AiProviderId; id: string } | undefined;
  onBlockModelChange: (id: string) => void;
  loadModels: (force?: boolean) => Promise<{ id: string; label?: string; provider?: string; contextWindow?: number }[]>;
  getQuality: () => Quality;
  /** Optional always-on humanize strength (from the unified Style setting). Defaults to 'balanced'. */
  getNaturalness?: () => Naturalness;
  /** Optional — open the AI settings / login modal so the user can re-authenticate
   *  after an `errorKind:'auth'` chat failure (e.g. an expired ChatGPT session). */
  openAiSettings?: () => void;
  /** Capability-gated reasoning tier from the shared preferences. */
  getReasoningEffort?: () => 'none' | 'low' | 'medium' | 'high' | 'xhigh' | undefined;
};

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

type EditorSel = { kind: 'editor'; from: number; to: number; text: string };
type PreviewSel = { kind: 'preview'; range: Range; text: string };
type ActiveSel = EditorSel | PreviewSel;

export function installBlockAi(deps: BlockAiDeps) {
  let active: ActiveSel | null = null;
  let popup: HTMLDivElement | null = null;
  let inflightId: string | null = null;
  let inflightCleanup: (() => void) | null = null;
  let outsideListener: ((ev: MouseEvent) => void) | null = null;
  let cachedModels: Awaited<ReturnType<BlockAiDeps['loadModels']>> = [];
  let lastCompletedInventory: typeof cachedModels | undefined;
  void deps.loadModels().then(
    (models) => {
      cachedModels = models;
      lastCompletedInventory = models;
    },
    () => {},
  );

  // ===== Pill =====
  const pill = document.createElement('button');
  pill.className = 'ba-pill';
  pill.type = 'button';
  pill.setAttribute('aria-label', t('block.ai'));
  pill.innerHTML = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2 L 9.2 6.4 L 13.6 7.6 L 9.2 8.8 L 8 13.2 L 6.8 8.8 L 2.4 7.6 L 6.8 6.4 Z"/></svg><span>${t('block.ai')}</span>`;
  pill.style.display = 'none';
  document.body.appendChild(pill);
  pill.addEventListener('mousedown', (e) => e.preventDefault());
  pill.addEventListener('click', () => openPopup());

  function hidePill() { pill.style.display = 'none'; }

  function positionPill(anchorRect: { right: number; bottom: number }) {
    // Clamp to the active editing surface: hide rather than float over the
    // header / status bar when the selection scrolls out of the visible area.
    const surface = active?.kind === 'preview' ? deps.previewEl : deps.view.scrollDOM;
    const sr = surface?.getBoundingClientRect();
    if (sr && (anchorRect.bottom < sr.top || anchorRect.bottom > sr.bottom)) {
      hidePill();
      return;
    }
    const top = anchorRect.bottom + 6;
    const left = Math.min(window.innerWidth - 120, Math.max(8, anchorRect.right - 60));
    pill.style.top = `${top}px`;
    pill.style.left = `${left}px`;
    pill.style.display = 'inline-flex';
  }

  // ===== Editor selection (CM6) =====
  const updateExt = EditorView.updateListener.of((u: ViewUpdate) => {
    if (popup) return;
    const sel = u.state.selection.main;
    if (sel.from === sel.to) {
      if (active?.kind === 'editor') { active = null; hidePill(); }
      return;
    }
    const text = u.state.doc.sliceString(sel.from, sel.to);
    if (text.trim().length < 2) {
      if (active?.kind === 'editor') { active = null; hidePill(); }
      return;
    }
    active = { kind: 'editor', from: sel.from, to: sel.to, text };
    const coords = deps.view.coordsAtPos(sel.to);
    if (coords) positionPill({ right: coords.right, bottom: coords.bottom });
  });
  deps.view.dispatch({ effects: StateEffect.appendConfig.of([updateExt]) });

  // ===== Preview selection (contenteditable) =====
  function captureFromPreviewSelection() {
    if (popup) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      if (active?.kind === 'preview') { active = null; hidePill(); }
      return;
    }
    const range = sel.getRangeAt(0);
    // Selection must be entirely inside the preview
    if (!deps.previewEl.contains(range.commonAncestorContainer)) {
      if (active?.kind === 'preview') { active = null; hidePill(); }
      return;
    }
    const text = sel.toString();
    if (text.trim().length < 2) {
      if (active?.kind === 'preview') { active = null; hidePill(); }
      return;
    }
    active = { kind: 'preview', range: range.cloneRange(), text };
    const rect = range.getBoundingClientRect();
    positionPill({ right: rect.right, bottom: rect.bottom });
  }
  document.addEventListener('selectionchange', () => {
    // Defer so editor selection / contenteditable events settle first
    setTimeout(captureFromPreviewSelection, 0);
  });

  // ===== Keyboard shortcut: ⌘⇧A =====
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'a' || e.key === 'A')) {
      if (active) {
        e.preventDefault();
        openPopup();
      }
    }
    if (e.key === 'Escape' && popup) closePopup();
  });

  const repositionPill = () => {
    if (!active || popup) return;
    if (pill.style.display === 'none') return;
    if (active.kind === 'editor') {
      const coords = deps.view.coordsAtPos(active.to);
      if (coords) positionPill({ right: coords.right, bottom: coords.bottom });
      else hidePill();
    } else {
      const rect = active.range.getBoundingClientRect();
      if (rect && (rect.width || rect.height)) positionPill({ right: rect.right, bottom: rect.bottom });
      else hidePill();
    }
  };
  window.addEventListener('resize', repositionPill);
  // Keep the pill anchored to the selection while the editor/preview scrolls.
  document.addEventListener('scroll', repositionPill, true);

  // ===== Popup =====

  function openPopup() {
    if (!active) return;
    closePopup();
    hidePill();

    const root = document.createElement('div');
    root.className = 'ba-popup';
    const cmRaw = deps.getBlockModel();
    const cmProvider = typeof cmRaw === 'object' && cmRaw ? cmRaw.provider : 'chatgpt';
    const cmId = (typeof cmRaw === 'string' ? cmRaw : cmRaw?.id) ?? 'gpt-5.4-mini';
    const currentModel = modelLabelFor(cmProvider, cmId);
    root.innerHTML = `
      <div class="ba-popup-head">
        <div class="ba-popup-title">${t('block.title')}</div>
        <div class="ba-popup-head-spacer"></div>
        <button class="ba-model-icon" id="ba-model" type="button" title="${escapeHtml(currentModel)}" aria-label="${t('block.model')}">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2 L 9.2 6.4 L 13.6 7.6 L 9.2 8.8 L 8 13.2 L 6.8 8.8 L 2.4 7.6 L 6.8 6.4 Z"/></svg>
        </button>
        <button class="ba-iconbtn" id="ba-close" aria-label="${t('block.close')}">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><line x1="2.5" y1="2.5" x2="9.5" y2="9.5"/><line x1="9.5" y1="2.5" x2="2.5" y2="9.5"/></svg>
        </button>
      </div>
      <div class="ba-popup-body">
        <div class="ba-selected-preview">${escapeHtml(truncate(active.text, 240))}</div>
        <textarea class="ba-instruction" id="ba-instruction" placeholder="${t('block.placeholder')}" rows="2"></textarea>
        <div class="ba-actions">
          <button class="ba-secondary" id="ba-cancel">${t('block.cancel')}</button>
          <button class="ba-primary" id="ba-generate">${t('block.generate')}</button>
        </div>
        <div class="ba-options" id="ba-options"></div>
      </div>
    `;

    let anchorRect: DOMRect | { top: number; left: number; bottom: number; right: number };
    if (active.kind === 'editor') {
      const coords = deps.view.coordsAtPos(active.to);
      anchorRect = coords ? { top: coords.top, left: coords.left, bottom: coords.bottom, right: coords.right } : { top: 80, left: 80, bottom: 80, right: 80 };
    } else {
      anchorRect = active.range.getBoundingClientRect();
    }
    const POPUP_W = 460;
    // Reserve 24px margin top/bottom — popup height-cap leaves room to scroll.
    const VP_MARGIN = 24;
    const popupMaxH = Math.max(280, window.innerHeight - VP_MARGIN * 2);
    let top = (anchorRect.bottom ?? 80) + 10;
    if (top + popupMaxH > window.innerHeight - VP_MARGIN) {
      // Anchor to the bottom of viewport with VP_MARGIN gap
      top = Math.max(VP_MARGIN, window.innerHeight - popupMaxH - VP_MARGIN);
    }
    const left = Math.min(window.innerWidth - POPUP_W - 12, Math.max(12, (anchorRect.left ?? 80) - 40));
    root.style.top = `${top}px`;
    root.style.left = `${left}px`;
    root.style.maxHeight = `${popupMaxH}px`;

    document.body.appendChild(root);
    popup = root;

    // Model dropdown wiring — round sparkle icon button
    const modelBtn = root.querySelector<HTMLButtonElement>('#ba-model')!;
    modelBtn.addEventListener('click', async () => {
      const refresh = deps.loadModels(true);
      let refreshTimeout: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        refresh.then(
          (models) => ({ models, fresh: true }),
          () => ({ models: cachedModels, fresh: false }),
        ),
        new Promise<{ models: typeof cachedModels; fresh: false }>((resolve) => {
          refreshTimeout = setTimeout(
            () => resolve({ models: cachedModels, fresh: false }),
            MODEL_MENU_REFRESH_TIMEOUT_MS,
          );
        }),
      ]);
      if (refreshTimeout !== undefined) clearTimeout(refreshTimeout);
      if (result.fresh) {
        cachedModels = result.models;
        lastCompletedInventory = result.models;
      }
      else {
        void refresh.then(
          (models) => {
            cachedModels = models;
            lastCompletedInventory = models;
          },
          () => {},
        );
      }
      const models = result.models;
      const curRaw = deps.getBlockModel();
      const curKey =
        typeof curRaw === 'string'
          ? `chatgpt:${curRaw}`
          : curRaw
            ? modelKey(curRaw)
            : 'chatgpt:gpt-5.4-mini';
      const inventoryContainsComposer = lastCompletedInventory?.some(
        (model) => model.provider === 'grok' && model.id === 'grok-composer-2.5-fast',
      ) ?? false;
      const modelsForMenu =
        !result.fresh && !inventoryContainsComposer
          ? (models as ModelRef[]).filter((model) => !isRouteHiddenModel(model))
          : models as ModelRef[];
      const items = applyModelDisplayPolicy(
        modelsForMenu,
        { currentSelection: parseModelKey(curKey) },
      ).map((m) => {
        const provider = m.provider ?? 'chatgpt';
        const key = modelKey({ provider, id: m.id });
        const badge = isAiProviderId(provider)
          ? formatContextWindow(modelContextWindowTokens(provider, m.id, m.contextWindow))
          : '';
        const providerLabel = BLOCK_PROVIDER_LABELS[provider] ?? provider;
        const hint = badge ? `${providerLabel} · ${badge}` : providerLabel;
        return { value: key, label: modelLabelFor(provider, m.id, m.label), hint, selected: key === curKey };
      });
      const hasCurrentSelection = items.some((item) => item.selected);
      if (items.length === 0) items.push({ value: 'chatgpt:gpt-5.4-mini', label: modelLabelFor('chatgpt', 'gpt-5.4-mini'), hint: '', selected: true });
      else if (!hasCurrentSelection) items[0].selected = true;
      const lastCompletedSelectionPresent = lastCompletedInventory?.some((model) =>
        modelKey({ provider: model.provider ?? 'chatgpt', id: model.id }) === curKey,
      ) ?? false;
      if (lastCompletedInventory && !lastCompletedSelectionPresent && !hasCurrentSelection && items[0].value !== curKey) deps.onBlockModelChange(items[0].value);
      openMenu({
        anchor: modelBtn,
        items,
        onSelect: (v) => {
          deps.onBlockModelChange(v);
          const chosen = items.find((it) => it.value === v);
          modelBtn.title = chosen?.label ?? v;
        },
        minWidth: 200,
      });
    });

    const instructionEl = root.querySelector<HTMLTextAreaElement>('#ba-instruction')!;
    const generateBtn = root.querySelector<HTMLButtonElement>('#ba-generate')!;
    const cancelBtn = root.querySelector<HTMLButtonElement>('#ba-cancel')!;
    const closeBtn = root.querySelector<HTMLButtonElement>('#ba-close')!;
    const optionsEl = root.querySelector<HTMLDivElement>('#ba-options')!;

    cancelBtn.addEventListener('click', () => closePopup());
    closeBtn.addEventListener('click', () => closePopup());

    instructionEl.focus();

    const triggerGenerate = () => generate(instructionEl, generateBtn, optionsEl);
    generateBtn.addEventListener('click', triggerGenerate);
    instructionEl.addEventListener('keydown', (e) => {
      if (e.isComposing || (e as any).keyCode === 229) return;
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        triggerGenerate();
      }
    });

    setTimeout(() => {
      const onOutside = (ev: MouseEvent) => {
        if (!popup) return;
        const target = ev.target as HTMLElement | null;
        if (!target) return;
        if (popup.contains(target)) return;
        if (target.closest && target.closest('.pm-menu')) return;
        closePopup();
      };
      outsideListener = onOutside;
      document.addEventListener('mousedown', onOutside, true);
    }, 0);
  }

  function closePopup() {
    if (inflightCleanup) { inflightCleanup(); inflightCleanup = null; }
    if (inflightId) { void window.api.aiCancel(inflightId); inflightId = null; }
    if (outsideListener) {
      document.removeEventListener('mousedown', outsideListener, true);
      outsideListener = null;
    }
    popup?.remove();
    popup = null;
  }

  async function generate(
    instructionEl: HTMLTextAreaElement,
    generateBtn: HTMLButtonElement,
    optionsEl: HTMLDivElement,
  ) {
    if (!active) return;
    const instruction = instructionEl.value.trim() || 'Improve the writing while preserving meaning.';
    generateBtn.disabled = true;
    generateBtn.textContent = t('block.generating');
    const hasAuth = await Promise.resolve()
      .then(() => window.api.aiHasAnyAuth())
      .catch(() => true);
    if (!hasAuth) {
      optionsEl.textContent = t('chat.noProvider');
      generateBtn.disabled = false;
      generateBtn.textContent = t('block.generate');
      if (deps.openAiSettings) triggerCliOnboarding(deps.openAiSettings);
      return;
    }
    optionsEl.innerHTML = `
      <div class="ba-loading">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </div>
    `;

    // Cap the selected fragment so the full prompt stays under ~1000 tokens.
    const fragment =
      active.text.length > SELECTION_CHAR_CAP
        ? active.text.slice(0, SELECTION_CHAR_CAP) + '\n…[truncated]'
        : active.text;
    const userMessage = `Instruction: ${instruction}\n\n=== Selected fragment ===\n${fragment}\n=== End fragment ===`;
    // Always-on style layer: difficulty (former F6) + meaning-preserving humanize.
    const styleStr = styleDirective(
      { difficulty: deps.getQuality(), naturalness: deps.getNaturalness?.() ?? 'balanced' },
      detectLanguage(fragment),
    );

    const instructions = buildBlockAiInstructions({
      qualityDirectiveStr: styleStr,
    });

    const id = 'ba-' + Math.random().toString(36).slice(2);
    inflightId = id;
    let buffer = '';
    const cleanup = window.api.onAiChatEvent(id, (e) => {
      if (e.kind === 'delta' && e.text) {
        buffer += e.text;
      } else if (e.kind === 'done') {
        const final = (e.text || buffer).trim();
        renderOptions(final, optionsEl);
        generateBtn.disabled = false;
        generateBtn.textContent = t('block.regenerate');
        cleanup();
        inflightCleanup = null;
        inflightId = null;
      } else if (e.kind === 'error') {
        const message = e.errorCode ? aiChatErrorMessage(e) : undefined;
        if (message) {
          optionsEl.innerHTML = `<div class="ba-error">${escapeHtml(message)}</div>`;
        } else if (e.errorKind === 'auth') {
          // Classified auth failure (e.g. expired ChatGPT session): show a fixed,
          // DOM-constructed sign-in affordance. Never surface the raw provider body.
          renderAuthAffordance(optionsEl, deps.openAiSettings);
        } else {
          optionsEl.innerHTML = `<div class="ba-error">${escapeHtml(aiChatErrorMessage(e))}</div>`;
        }
        generateBtn.disabled = false;
        generateBtn.textContent = t('block.generate');
        cleanup();
        inflightCleanup = null;
        inflightId = null;
      }
    });
    inflightCleanup = cleanup;

    try {
      // Use the block-AI-specific model (default gpt-5.4-mini), not the global one.
      await window.api.aiChat({
        id,
        instructions,
        history: [],
        userText: userMessage,
        model: deps.getBlockModel(),
        surfaceMode: 'block',
        reasoningEffort: deps.getReasoningEffort?.(),
      });
    } catch (err: any) {
      optionsEl.innerHTML = `<div class="ba-error">${escapeHtml(err?.message ?? String(err))}</div>`;
      generateBtn.disabled = false;
      generateBtn.textContent = t('block.generate');
      cleanup();
    }
  }

  function parseAlternatives(text: string): string[] {
    const parts = text
      .split(/\n\s*-{3,}\s*\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length >= 2) return parts.slice(0, 3);
    const numbered = text.split(/\n(?=\s*[123]\.\s)/).map((s) => s.replace(/^\s*[123]\.\s*/, '').trim()).filter(Boolean);
    if (numbered.length >= 2) return numbered.slice(0, 3);
    return [text];
  }

  function renderOptions(raw: string, optionsEl: HTMLDivElement) {
    const alts = parseAlternatives(raw);
    optionsEl.innerHTML = '';
    alts.forEach((alt, i) => {
      const card = document.createElement('div');
      card.className = 'ba-option';
      card.innerHTML = `
        <div class="ba-option-head">
          <span class="ba-option-num">${i + 1}</span>
          <button class="ba-option-apply" data-tooltip="${t('block.apply')}">${t('block.apply')}</button>
        </div>
        <div class="ba-option-body">${md.render(alt)}</div>
      `;
      const applyBtn = card.querySelector<HTMLButtonElement>('.ba-option-apply')!;
      applyBtn.addEventListener('click', () => applyAlternative(alt));
      optionsEl.appendChild(card);
    });
  }

  function applyAlternative(alt: string) {
    if (!active) return;
    if (active.kind === 'editor') {
      deps.view.dispatch({
        changes: { from: active.from, to: active.to, insert: alt },
        selection: { anchor: active.from, head: active.from + alt.length },
        scrollIntoView: true,
      });
      closePopup();
      deps.view.focus();
    } else {
      // Preview: restore the saved Range, then replace contents with rendered HTML
      const sel = window.getSelection();
      if (!sel) return;
      sel.removeAllRanges();
      sel.addRange(active.range);
      try {
        // Inline-friendly rendering: trim final <p> wrapper for cleaner inline replacement
        let html = md.render(alt).trim();
        // markdown-it wraps single paragraphs in <p>...</p>; if the replacement is a
        // single inline paragraph, strip the outer <p> so we don't break inline contexts.
        const singlePara = html.match(/^<p>([\s\S]*)<\/p>$/);
        if (singlePara && !singlePara[1].includes('<p>')) html = singlePara[1];
        document.execCommand('insertHTML', false, html);
        // Trigger an input event so preview synchronization picks up the change.
        deps.previewEl.dispatchEvent(new Event('input', { bubbles: true }));
      } catch (err) {
        console.error('Block-AI apply (preview) failed:', err);
      }
      closePopup();
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + '…';
}

/** Locale-aware fixed copy for the `errorKind:'auth'` sign-in affordance.
 *  ko/en only; other locales fall back to English (mirrors t()'s en fallback).
 *  Kept in-module because i18n.ts is out of scope for this slice. */
const AUTH_AFFORDANCE_COPY: Record<'ko' | 'en', { message: string; button: string }> = {
  ko: { message: 'ChatGPT 세션이 만료되었습니다. 다시 로그인하세요.', button: '다시 로그인' },
  en: { message: 'Your ChatGPT session expired. Sign in again.', button: 'Sign in again' },
};

/**
 * Render a DOM-constructed sign-in affordance for a classified `errorKind:'auth'`
 * chat error. Built with `textContent` only — the raw provider body is never
 * surfaced (no innerHTML / interpolation), so a hostile error body cannot inject
 * markup. The button routes to the AI settings / login modal via `onSignIn`.
 */
function renderAuthAffordance(optionsEl: HTMLElement, onSignIn?: () => void): void {
  const copy = AUTH_AFFORDANCE_COPY[getLocale() === 'ko' ? 'ko' : 'en'];
  const wrap = document.createElement('div');
  wrap.className = 'ba-error ba-auth-error';
  const msg = document.createElement('div');
  msg.className = 'ba-auth-msg';
  msg.textContent = copy.message;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ba-primary ba-signin';
  btn.textContent = copy.button;
  btn.addEventListener('click', () => onSignIn?.());
  wrap.appendChild(msg);
  wrap.appendChild(btn);
  optionsEl.textContent = '';
  optionsEl.appendChild(wrap);
}
