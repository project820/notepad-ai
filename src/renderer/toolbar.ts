import type { FormatAction } from './formatting';
import { openMenu, openPanel } from './dropdown';
import { t, getLocale, setLocale, onLocaleChange, type Locale } from './i18n';
import { modelKey, parseModelKey } from './model-key';
import { stepTypography, type TypographyPref } from './typography';
import { formatContextWindow, modelContextWindowTokens } from '../main/ai/output-budget';
import { applyModelDisplayPolicy } from '../main/ai/model-display-policy';
import { isAiProviderId, type AiProviderId, type ModelRef, type ReasoningEffort } from '../main/ai/types';

export type Theme = 'system' | 'light' | 'dark';
export type FontSize = 'sm' | 'md' | 'lg';

export type ToolbarHandlers = {
  onFormat: (action: FormatAction) => void;
  onInsertTable: (rows: number, cols: number) => void;
  onTogglePreview: () => void;
  onToggleSideChat: () => void;
  onThemeChange: (t: Theme) => void;
  onFontSizeChange: (s: FontSize) => void;
  onModelChange: (modelId: string) => void;
  onLocaleChange: (l: Locale) => void;
  onSignIn: () => void;
  onSignOut: () => void;
  getTheme: () => Theme;
  getFontSize: () => FontSize;
  getModel: () => string | { provider: AiProviderId; id: string } | undefined;
  getLocale: () => Locale;
  getAuth: () => { signedIn: boolean; email?: string; plan?: string };
  loadModels: (force?: boolean) => Promise<{ id: string; label?: string; provider?: string; contextWindow?: number }[]>;
  /** Open the AI providers + style settings modal. */
  onOpenSettings?: () => void;
  /** Toggle the left outline/footnote panel. */
  onToggleOutline?: () => void;
  /** Toggle the preview line-number gutter. */
  onTogglePreviewLines?: () => void;
  /** Current preview line-number state (drives aria-pressed). */
  getPreviewLines?: () => boolean;
  /** Toggle raw line alignment (split-view spacers that line the editor up with the preview). */
  onToggleRawLineAlign?: () => void;
  /** Current raw line-alignment state (drives aria-pressed). */
  getRawLineAlign?: () => boolean;
  /** Typography (letter-spacing / char-width / line-height) for the text-size panel. */
  getTypography?: () => import('./typography').TypographyPref;
  onTypographyChange?: (next: import('./typography').TypographyPref) => void;
  /** Undo / redo the editor (CM6 history). */
  onUndo?: () => void;
  onRedo?: () => void;
  getReasoningEffort?: () => ReasoningEffort | undefined;
  onReasoningEffortChange?: (effort: Exclude<ReasoningEffort, 'max'>) => void;
  loadReasoningCapabilities?: () => Promise<{
    featureEnabled: boolean;
    snapshotGeneration: number;
    models: Array<{ modelId: string; efforts: ReasoningEffort[] }>;
    accountModels: string[];
  }>;
};

// ---- SVG glyphs (no emoji) ----
const ICONS = {
  undo: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8 a5 5 0 1 1 1.6 3.7"/><polyline points="3,4.5 3,8 6.5,8"/></svg>`,
  redo: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8 a5 5 0 1 0 -1.6 3.7"/><polyline points="13,4.5 13,8 9.5,8"/></svg>`,
  bold: 'B',
  italic: 'I',
  strike: 'S',
  code: '&lt;/&gt;',
  highlight: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.2 2.3 L 13.7 5.8 L 8 11.5 L 4.5 8 Z"/><path d="M4.5 8 L 3 13 L 8 11.5"/><line x1="2.5" y1="14.4" x2="9.5" y2="14.4"/></svg>`,
  h1: 'H1',
  h2: 'H2',
  h3: 'H3',
  quote: '"',
  ul: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="3" cy="4" r="0.9" fill="currentColor"/><circle cx="3" cy="8" r="0.9" fill="currentColor"/><circle cx="3" cy="12" r="0.9" fill="currentColor"/><line x1="6.5" y1="4" x2="13.5" y2="4"/><line x1="6.5" y1="8" x2="13.5" y2="8"/><line x1="6.5" y1="12" x2="13.5" y2="12"/></svg>`,
  ol: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><text x="1" y="5.5" font-family="monospace" font-size="3.5" fill="currentColor" stroke="none">1</text><text x="1" y="9.5" font-family="monospace" font-size="3.5" fill="currentColor" stroke="none">2</text><text x="1" y="13.5" font-family="monospace" font-size="3.5" fill="currentColor" stroke="none">3</text><line x1="6.5" y1="4" x2="13.5" y2="4"/><line x1="6.5" y1="8" x2="13.5" y2="8"/><line x1="6.5" y1="12" x2="13.5" y2="12"/></svg>`,
  task: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="2" width="5" height="5" rx="1"/><polyline points="3,4.5 4.2,5.5 6,3.5" stroke-linecap="round" stroke-linejoin="round"/><line x1="9" y1="4.5" x2="14" y2="4.5" stroke-linecap="round"/><rect x="2" y="9" width="5" height="5" rx="1"/><line x1="9" y1="11.5" x2="14" y2="11.5" stroke-linecap="round"/></svg>`,
  link: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M6.5 9.5 L 9.5 6.5"/><path d="M7 4.5 L 9 2.5 a3 3 0 0 1 4 4 L 11 8.5"/><path d="M9 11.5 L 7 13.5 a3 3 0 0 1 -4 -4 L 5 7.5"/></svg>`,
  image: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><circle cx="5" cy="6" r="1.2"/><path d="M2 12 L 6 8 L 10 11 L 14 6.5" stroke-linejoin="round"/></svg>`,
  codeblock: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="5,5 2,8 5,11"/><polyline points="11,5 14,8 11,11"/></svg>`,
  hr: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><line x1="2" y1="8" x2="14" y2="8"/></svg>`,
  table: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1.5" y="2.5" width="13" height="11" rx="1"/><line x1="1.5" y1="6" x2="14.5" y2="6"/><line x1="6" y1="2.5" x2="6" y2="13.5"/></svg>`,
  eye: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8 C 3.5 4, 12.5 4, 14.5 8 C 12.5 12, 3.5 12, 1.5 8 Z"/><circle cx="8" cy="8" r="1.8"/></svg>`,
  sparkle: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2 L 9.2 6.4 L 13.6 7.6 L 9.2 8.8 L 8 13.2 L 6.8 8.8 L 2.4 7.6 L 6.8 6.4 Z"/></svg>`,
  fontSize: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><text x="1" y="11" font-family="-apple-system,sans-serif" font-weight="700" font-size="10" fill="currentColor" stroke="none">A</text><text x="8" y="11" font-family="-apple-system,sans-serif" font-weight="700" font-size="6" fill="currentColor" stroke="none">a</text></svg>`,
  theme: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="3.2"/><path d="M8 1.5 L 8 3"/><path d="M8 13 L 8 14.5"/><path d="M1.5 8 L 3 8"/><path d="M13 8 L 14.5 8"/><path d="M3.4 3.4 L 4.5 4.5"/><path d="M11.5 11.5 L 12.6 12.6"/><path d="M3.4 12.6 L 4.5 11.5"/><path d="M11.5 4.5 L 12.6 3.4"/></svg>`,
  account: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="6" r="2.6"/><path d="M2.6 13.4 C 3.8 10.6, 12.2 10.6, 13.4 13.4"/></svg>`,
  lang: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.2"/><ellipse cx="8" cy="8" rx="3" ry="6.2"/><line x1="1.8" y1="8" x2="14.2" y2="8"/></svg>`,
  consultant: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4.5 a2 2 0 0 1 2 -2 h7 a2 2 0 0 1 2 2 v5 a2 2 0 0 1 -2 2 h-4 l-3 2.2 v-2.2 h-0 a2 2 0 0 1 -2 -2 Z"/><line x1="5.5" y1="6" x2="10.5" y2="6"/><line x1="5.5" y1="8.2" x2="9" y2="8.2"/></svg>`,
  outline: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="12" height="10" rx="2"/><line x1="6" y1="3.5" x2="6" y2="12.5"/></svg>`,
  footnote: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><text x="1.5" y="12" font-family="-apple-system,sans-serif" font-weight="700" font-size="9.5" fill="currentColor">A</text><text x="9" y="6.6" font-family="-apple-system,sans-serif" font-weight="700" font-size="5.5" fill="currentColor">1</text></svg>`,
  lineNumbers: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><text x="0.4" y="5.4" font-family="monospace" font-size="4" fill="currentColor" stroke="none">1</text><text x="0.4" y="9.6" font-family="monospace" font-size="4" fill="currentColor" stroke="none">2</text><text x="0.4" y="13.8" font-family="monospace" font-size="4" fill="currentColor" stroke="none">3</text><line x1="5" y1="2.5" x2="5" y2="13.5"/><line x1="7" y1="4" x2="13.5" y2="4"/><line x1="7" y1="8" x2="13.5" y2="8"/><line x1="7" y1="12" x2="13.5" y2="12"/></svg>`,
  lineAlign: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><line x1="2" y1="3.5" x2="6" y2="3.5"/><line x1="10" y1="3.5" x2="14" y2="3.5"/><line x1="2" y1="8" x2="6" y2="8"/><line x1="10" y1="8" x2="14" y2="8"/><line x1="2" y1="12.5" x2="6" y2="12.5"/><line x1="10" y1="12.5" x2="14" y2="12.5"/><line x1="8" y1="2" x2="8" y2="14" stroke-dasharray="1.6 1.6"/></svg>`,
} as const;

type ButtonSpec =
  | { kind: 'sep' }
  | { kind: 'action'; id: string; html: string; tipKey: string; action: FormatAction; variant?: 'text' };

const BUTTONS: ButtonSpec[] = [
  { kind: 'action', id: 'fmt-bold', html: ICONS.bold, tipKey: 'tip.bold', action: 'bold', variant: 'text' },
  { kind: 'action', id: 'fmt-italic', html: `<em>${ICONS.italic}</em>`, tipKey: 'tip.italic', action: 'italic', variant: 'text' },
  { kind: 'action', id: 'fmt-strike', html: `<s>${ICONS.strike}</s>`, tipKey: 'tip.strike', action: 'strike', variant: 'text' },
  { kind: 'action', id: 'fmt-highlight', html: ICONS.highlight, tipKey: 'tip.highlight', action: 'highlight' },
  { kind: 'action', id: 'fmt-code', html: ICONS.code, tipKey: 'tip.code', action: 'code', variant: 'text' },
  { kind: 'sep' },
  { kind: 'action', id: 'fmt-h1', html: ICONS.h1, tipKey: 'tip.h1', action: 'h1', variant: 'text' },
  { kind: 'action', id: 'fmt-h2', html: ICONS.h2, tipKey: 'tip.h2', action: 'h2', variant: 'text' },
  { kind: 'action', id: 'fmt-h3', html: ICONS.h3, tipKey: 'tip.h3', action: 'h3', variant: 'text' },
  { kind: 'sep' },
  { kind: 'action', id: 'fmt-quote', html: ICONS.quote, tipKey: 'tip.quote', action: 'quote', variant: 'text' },
  { kind: 'action', id: 'fmt-ul', html: ICONS.ul, tipKey: 'tip.ul', action: 'ul' },
  { kind: 'action', id: 'fmt-ol', html: ICONS.ol, tipKey: 'tip.ol', action: 'ol' },
  { kind: 'action', id: 'fmt-task', html: ICONS.task, tipKey: 'tip.task', action: 'task' },
  { kind: 'sep' },
  { kind: 'action', id: 'fmt-link', html: ICONS.link, tipKey: 'tip.link', action: 'link' },
  { kind: 'action', id: 'fmt-footnote', html: ICONS.footnote, tipKey: 'tip.footnote', action: 'footnote' },
  { kind: 'action', id: 'fmt-codeblock', html: ICONS.codeblock, tipKey: 'tip.codeblock', action: 'codeblock' },
  { kind: 'action', id: 'fmt-hr', html: ICONS.hr, tipKey: 'tip.hr', action: 'hr' },
];

const MODEL_MENU_REFRESH_TIMEOUT_MS = 1_500;

let cachedModels: { id: string; label?: string; provider?: string; contextWindow?: number }[] = [];
let hasFreshModelSnapshot = false;

let reasoningCapabilities: {
  featureEnabled: boolean;
  snapshotGeneration: number;
  models: Array<{ modelId: string; efforts: ReasoningEffort[] }>;
} = { featureEnabled: false, snapshotGeneration: 0, models: [] };

export function createToolbar(parent: HTMLElement, h: ToolbarHandlers) {
  function renderToolbar() {
    const formatGroup = BUTTONS.map((b) => {
      if (b.kind === 'sep') return '<div class="tb-sep" aria-hidden="true"></div>';
      const variantClass = b.variant === 'text' ? 'tb-icbtn tb-icbtn-text' : 'tb-icbtn';
      const tip = t(b.tipKey);
      return `<button class="${variantClass}" data-id="${b.id}" data-tooltip="${tip}" aria-label="${tip}">${b.html}</button>`;
    }).join('');

    parent.innerHTML = `
      <div class="tb-row">
        <div class="tb-lead">
          <button class="tb-icbtn" id="tb-toggle-outline" data-tooltip="${t('tip.outline')}" aria-label="${t('tip.outline')}">${ICONS.outline}</button>
          <button class="tb-icbtn" id="tb-undo" data-tooltip="${t('tip.undo')}" aria-label="${t('tip.undo')}">${ICONS.undo}</button>
          <button class="tb-icbtn" id="tb-redo" data-tooltip="${t('tip.redo')}" aria-label="${t('tip.redo')}">${ICONS.redo}</button>
        </div>
        <div class="tb-sep" aria-hidden="true"></div>
        <div class="tb-format">${formatGroup}</div>
        <div class="tb-trail">
          <button class="tb-icbtn" id="tb-insert-table" data-tooltip="${t('tip.table')}" aria-label="${t('tip.table')}">
            ${ICONS.table}
          </button>
          <button class="tb-icbtn" id="tb-preview-lines" data-tooltip="${t('tip.previewLines')}" aria-label="${t('tip.previewLines')}" aria-pressed="${h.getPreviewLines?.() ? 'true' : 'false'}">
            ${ICONS.lineNumbers}
          </button>
          <button class="tb-icbtn" id="tb-raw-line-align" data-tooltip="${t('tip.rawLineAlign')}" aria-label="${t('tip.rawLineAlign')}" aria-pressed="${h.getRawLineAlign?.() ? 'true' : 'false'}">
            ${ICONS.lineAlign}
          </button>
          <button class="tb-icbtn" id="tb-toggle-preview" data-tooltip="${t('tip.view')}" aria-label="${t('tip.view')}">
            ${ICONS.eye}
          </button>
        </div>
      </div>
    `;
    wireToolbar();
  }

  function wireToolbar() {
    parent.querySelectorAll<HTMLButtonElement>('.tb-icbtn[data-id]').forEach((btn) => {
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', () => {
        const id = btn.dataset.id!;
        const spec = BUTTONS.find((b) => b.kind === 'action' && (b as any).id === id) as Extract<ButtonSpec, { kind: 'action' }>;
        if (spec) h.onFormat(spec.action);
      });
    });
    const insertBtn = parent.querySelector<HTMLButtonElement>('#tb-insert-table')!;
    const togglePreviewBtn = parent.querySelector<HTMLButtonElement>('#tb-toggle-preview')!;
    insertBtn.addEventListener('mousedown', (e) => e.preventDefault());
    insertBtn.addEventListener('click', () => openTablePicker(insertBtn, h.onInsertTable));
    togglePreviewBtn.addEventListener('click', () => h.onTogglePreview());
    parent.querySelector<HTMLButtonElement>('#tb-toggle-outline')?.addEventListener('click', () => h.onToggleOutline?.());
    const undoBtn = parent.querySelector<HTMLButtonElement>('#tb-undo');
    undoBtn?.addEventListener('mousedown', (e) => e.preventDefault());
    undoBtn?.addEventListener('click', () => h.onUndo?.());
    const redoBtn = parent.querySelector<HTMLButtonElement>('#tb-redo');
    redoBtn?.addEventListener('mousedown', (e) => e.preventDefault());
    redoBtn?.addEventListener('click', () => h.onRedo?.());
    const previewLinesBtn = parent.querySelector<HTMLButtonElement>('#tb-preview-lines');
    previewLinesBtn?.addEventListener('click', () => {
      h.onTogglePreviewLines?.();
      previewLinesBtn.setAttribute('aria-pressed', h.getPreviewLines?.() ? 'true' : 'false');
    });
    const rawLineAlignBtn = parent.querySelector<HTMLButtonElement>('#tb-raw-line-align');
    rawLineAlignBtn?.addEventListener('click', () => {
      h.onToggleRawLineAlign?.();
      rawLineAlignBtn.setAttribute('aria-pressed', h.getRawLineAlign?.() ? 'true' : 'false');
    });
  }
  renderToolbar();

  // ===== Header right-side icon buttons =====
  function reasoningEffortsForCurrentModel(): Exclude<ReasoningEffort, 'max'>[] {
    const current = h.getModel();
    const provider = typeof current === 'object' ? current.provider : 'chatgpt';
    const modelId = typeof current === 'object' ? current.id : current;
    if (provider !== 'chatgpt' || !modelId || !reasoningCapabilities.featureEnabled) return [];
    return (reasoningCapabilities.models.find((model) => model.modelId === modelId)?.efforts ?? [])
      .filter((effort): effort is Exclude<ReasoningEffort, 'max'> => effort !== 'max');
  }

  async function refreshReasoningCapabilities(): Promise<void> {
    if (!h.loadReasoningCapabilities) return;
    try {
      const next = await h.loadReasoningCapabilities();
      if (next.snapshotGeneration === reasoningCapabilities.snapshotGeneration
        && next.featureEnabled === reasoningCapabilities.featureEnabled
        && JSON.stringify(next.models) === JSON.stringify(reasoningCapabilities.models)) return;
      reasoningCapabilities = next;
      renderControls();
    } catch {
      reasoningCapabilities = { featureEnabled: false, snapshotGeneration: 0, models: [] };
      renderControls();
    }
  }

  const controls = document.getElementById('navbar-controls') as HTMLDivElement;
  function renderControls() {
    const efforts = reasoningEffortsForCurrentModel();
    controls.innerHTML = `
      <button class="hdr-icbtn hdr-ai-consultant" id="hdr-sidechat" data-tooltip="${t('tip.sidechat')}" aria-label="${t('tip.sidechat')}"><span class="hdr-ai-label">Ai</span></button>
      <button class="hdr-icbtn" id="hdr-model" data-tooltip="${t('tip.model')}" aria-label="${t('tip.model')}">${ICONS.sparkle}</button>
      ${efforts.length > 0 ? `<button class="hdr-icbtn" id="hdr-reasoning" data-tooltip="${t('reasoning.effort')}" aria-label="${t('reasoning.effort')}">${t('reasoning.effort')}</button>` : ''}
      <button class="hdr-icbtn" id="hdr-lang" data-tooltip="${t('tip.language')}" aria-label="${t('tip.language')}">${ICONS.lang}</button>
      <button class="hdr-icbtn" id="hdr-font" data-tooltip="${t('tip.font')}" aria-label="${t('tip.font')}">${ICONS.fontSize}</button>
      <button class="hdr-icbtn" id="hdr-theme" data-tooltip="${t('tip.theme')}" aria-label="${t('tip.theme')}">${ICONS.theme}</button>
      <button class="hdr-icbtn hdr-account" id="hdr-account" data-tooltip="${t('tip.account')}" aria-label="${t('tip.account')}">${ICONS.account}</button>
    `;
    wireControls();
  }
  renderControls();
  void refreshReasoningCapabilities();

  function wireControls() {
    const sideChatBtn = controls.querySelector<HTMLButtonElement>('#hdr-sidechat')!;
    sideChatBtn.addEventListener('click', () => h.onToggleSideChat());

    const modelBtn = controls.querySelector<HTMLButtonElement>('#hdr-model')!;
    const fontBtn = controls.querySelector<HTMLButtonElement>('#hdr-font')!;
    const themeBtn = controls.querySelector<HTMLButtonElement>('#hdr-theme')!;
    const accountBtn = controls.querySelector<HTMLButtonElement>('#hdr-account')!;
    const langBtn = controls.querySelector<HTMLButtonElement>('#hdr-lang')!;

    modelBtn.addEventListener('click', async () => {
      const refresh = h.loadModels(true);
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
        hasFreshModelSnapshot = true;
      }
      else {
        void refresh.then(
          (models) => {
            cachedModels = models;
            hasFreshModelSnapshot = true;
          },
          () => {},
        );
      }
      const models = result.models;
      void refreshReasoningCapabilities();
      const PROVIDER_LABELS: Record<string, string> = {
        chatgpt: 'ChatGPT', claude: 'Claude', openrouter: 'OpenRouter', ollama: 'Ollama', lmstudio: 'LM Studio', grok: 'Grok',
      };
      const cur = h.getModel();
      const currentKey =
        cur && typeof cur === 'object'
          ? modelKey({ provider: isAiProviderId(cur.provider) ? cur.provider : 'chatgpt', id: cur.id })
          : modelKey({
              provider:
                (models.find((m) => m.id === ((typeof cur === 'string' ? cur : '') || 'gpt-5.4-mini'))
                  ?.provider as AiProviderId | undefined) ?? 'chatgpt',
              id: (typeof cur === 'string' ? cur : '') || 'gpt-5.4-mini',
            });
      const sorted = applyModelDisplayPolicy(models as ModelRef[], {
        currentSelection: parseModelKey(currentKey),
      }).sort(
        (a, b) =>
          (a.provider ?? '').localeCompare(b.provider ?? '') ||
          (a.label ?? a.id).localeCompare(b.label ?? b.id),
      );
      const items: { value: string; label: string; hint?: string; selected?: boolean }[] = sorted.map((m) => {
        const provider = (m.provider as AiProviderId | undefined) ?? 'chatgpt';
        const key = modelKey({ provider, id: m.id });
        const badge = isAiProviderId(provider)
          ? formatContextWindow(modelContextWindowTokens(provider, m.id, m.contextWindow))
          : '';
        const providerLabel = PROVIDER_LABELS[provider] ?? provider;
        const hint = badge ? `${providerLabel} · ${badge}` : providerLabel;
        return { value: key, label: m.label ?? m.id, hint, selected: key === currentKey };
      });
      const hasCurrentSelection = items.some((item) => item.selected);
      if (items.length === 0) items.push({ value: 'chatgpt:gpt-5.4-mini', label: 'gpt-5.4-mini', hint: 'ChatGPT', selected: true });
      else if (!hasCurrentSelection) items[0].selected = true;
      if (hasFreshModelSnapshot && !hasCurrentSelection && items[0].value !== currentKey) h.onModelChange(items[0].value);
      if (h.onOpenSettings) items.push({ value: '__settings__', label: 'Manage providers & custom model…' });
      openMenu({
        anchor: modelBtn,
        items,
        onSelect: (v) => {
          if (v === '__settings__') h.onOpenSettings?.();
          else {
            h.onModelChange(v);
            void refreshReasoningCapabilities();
          }
        },
        minWidth: 240,
      });
    });
    const reasoningBtn = controls.querySelector<HTMLButtonElement>('#hdr-reasoning');
    reasoningBtn?.addEventListener('click', () => {
      const current = h.getReasoningEffort?.();
      openMenu<Exclude<ReasoningEffort, 'max'>>({
        anchor: reasoningBtn,
        items: reasoningEffortsForCurrentModel().map((effort) => ({
          value: effort,
          label: t(`reasoning.effort.${effort}`),
          selected: effort === current,
        })),
        onSelect: (effort) => h.onReasoningEffortChange?.(effort),
      });
    });

    fontBtn.addEventListener('click', () => {
      // openPanel toggles itself when re-opened from the same anchor.
      openPanel({ anchor: fontBtn, content: buildTextSettingsPanel(h), minWidth: 240 });
    });

    themeBtn.addEventListener('click', () => {
      const cur = h.getTheme();
      openMenu<Theme>({
        anchor: themeBtn,
        items: [
          { value: 'system', label: t('menu.theme.system'), selected: cur === 'system' },
          { value: 'light', label: t('menu.theme.light'), selected: cur === 'light' },
          { value: 'dark', label: t('menu.theme.dark'), selected: cur === 'dark' },
        ],
        onSelect: (v) => h.onThemeChange(v),
        minWidth: 170,
      });
    });

    langBtn.addEventListener('click', () => {
      const cur = h.getLocale();
      openMenu<Locale>({
        anchor: langBtn,
        items: [
          { value: 'en', label: t('menu.lang.en'), selected: cur === 'en' },
          { value: 'ko', label: t('menu.lang.ko'), selected: cur === 'ko' },
          { value: 'zh-Hans', label: t('menu.lang.zhHans'), selected: cur === 'zh-Hans' },
          { value: 'zh-Hant', label: t('menu.lang.zhHant'), selected: cur === 'zh-Hant' },
          { value: 'ja', label: t('menu.lang.ja'), selected: cur === 'ja' },
        ],
        onSelect: (v) => h.onLocaleChange(v),
        minWidth: 170,
      });
    });

    accountBtn.addEventListener('click', () => {
      const a = h.getAuth();
      if (a.signedIn) {
        openMenu({
          anchor: accountBtn,
          items: [
            { value: 'who', label: a.email ?? t('menu.signedIn'), hint: a.plan ?? '' },
            { value: 'settings', label: 'AI providers & settings' },
            { value: 'signout', label: t('menu.signout') },
          ],
          onSelect: (v) => {
            if (v === 'signout') h.onSignOut();
            else if (v === 'settings') h.onOpenSettings?.();
          },
          minWidth: 220,
        });
      } else {
        openMenu({
          anchor: accountBtn,
          items: [
            { value: 'signin', label: t('menu.signin') },
            { value: 'settings', label: 'AI providers & settings' },
          ],
          onSelect: (v) => {
            if (v === 'signin') h.onSignIn();
            else if (v === 'settings') h.onOpenSettings?.();
          },
          minWidth: 220,
        });
      }
    });
  }

  // ===== Model list — load once =====
  void (async () => {
    cachedModels = await h.loadModels();
    if (!h.getModel() && cachedModels[0]) {
      const first = cachedModels[0];
      h.onModelChange(modelKey({ provider: (first.provider as AiProviderId | undefined) ?? 'chatgpt', id: first.id }));
    }
  })();

  // ===== Re-render when locale changes =====
  onLocaleChange(() => {
    renderToolbar();
    renderControls();
    paintAccountState(h.getAuth().signedIn);
  });

  // Suppress unused warnings (the t/getLocale/setLocale imports are used above).
  void setLocale;
  void getLocale;
}

// Repaint account button state (called externally when auth changes)
export function paintAccountState(signedIn: boolean) {
  const btn = document.getElementById('hdr-account');
  if (!btn) return;
  btn.classList.toggle('hdr-account-signed-in', signedIn);
  // The green status dot needs a meaning — surface it on the button tooltip (AC3).
  const tip = signedIn ? t('tip.accountSignedIn') : t('tip.account');
  btn.setAttribute('data-tooltip', tip);
  btn.setAttribute('aria-label', tip);
}

// ============ Excel-style table picker ============
function openTablePicker(anchor: HTMLElement, onPick: (rows: number, cols: number) => void) {
  document.querySelectorAll('.tb-picker').forEach((el) => el.remove());

  const MAX_ROWS = 8;
  const MAX_COLS = 10;
  const picker = document.createElement('div');
  picker.className = 'tb-picker';
  picker.innerHTML = `
    <div class="tb-picker-grid">
      ${Array.from({ length: MAX_ROWS * MAX_COLS }, () => '<div class="tb-cell"></div>').join('')}
    </div>
    <div class="tb-picker-label" id="tb-picker-label">${t('table.pick')}</div>
  `;
  // Pre-measure: append off-screen to get dimensions, then position with viewport clamping.
  picker.style.visibility = 'hidden';
  picker.style.left = '0px';
  picker.style.top = '0px';
  document.body.appendChild(picker);

  const pickerRect = picker.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();
  const vpW = window.innerWidth;
  const vpH = window.innerHeight;
  const GAP = 6;
  const PAD = 8;

  // Prefer anchoring picker's right edge to anchor's right edge — keeps inside the viewport
  // when the button itself is near the right edge.
  let left = anchorRect.right - pickerRect.width;
  if (left + pickerRect.width > vpW - PAD) left = vpW - pickerRect.width - PAD;
  if (left < PAD) left = PAD;
  let top = anchorRect.bottom + GAP;
  if (top + pickerRect.height > vpH - PAD) {
    // flip above
    top = anchorRect.top - pickerRect.height - GAP;
    if (top < PAD) top = PAD;
  }

  picker.style.left = `${left}px`;
  picker.style.top = `${top}px`;
  picker.style.visibility = '';

  const cells = Array.from(picker.querySelectorAll<HTMLDivElement>('.tb-cell'));
  const label = picker.querySelector<HTMLDivElement>('#tb-picker-label')!;
  let hoverRows = 0;
  let hoverCols = 0;

  cells.forEach((cell, idx) => {
    const r = Math.floor(idx / MAX_COLS) + 1;
    const c = (idx % MAX_COLS) + 1;
    cell.addEventListener('mouseenter', () => {
      hoverRows = r;
      hoverCols = c;
      label.textContent = `${r} × ${c}`;
      cells.forEach((other, j) => {
        const or = Math.floor(j / MAX_COLS) + 1;
        const oc = (j % MAX_COLS) + 1;
        other.classList.toggle('active', or <= r && oc <= c);
      });
    });
    cell.addEventListener('click', () => {
      if (hoverRows && hoverCols) onPick(hoverRows, hoverCols);
      picker.remove();
      document.removeEventListener('mousedown', onOutside, true);
    });
  });

  const onOutside = (e: MouseEvent) => {
    if (!picker.contains(e.target as Node) && e.target !== anchor) {
      picker.remove();
      document.removeEventListener('mousedown', onOutside, true);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', onOutside, true), 0);
}

/**
 * Build the text-settings popover content: font-size segmented control plus the
 * letter-spacing / character-width / line-height steppers. Moved out of the
 * Settings modal so display tweaks live next to the text-size (Aa) button.
 */
function buildTextSettingsPanel(h: ToolbarHandlers): HTMLElement {
  const root = document.createElement('div');
  root.className = 'text-settings';
  root.dataset.panel = 'text';

  // ----- font size (segmented) -----
  const sizes: { v: FontSize; label: string }[] = [
    { v: 'sm', label: t('menu.font.sm') },
    { v: 'md', label: t('menu.font.md') },
    { v: 'lg', label: t('menu.font.lg') },
  ];
  const sizeWrap = document.createElement('div');
  sizeWrap.className = 'ts-section';
  const sizeLabel = document.createElement('div');
  sizeLabel.className = 'ts-label';
  sizeLabel.textContent = t('tip.font');
  const seg = document.createElement('div');
  seg.className = 'ts-seg';
  const paintSeg = () => {
    const cur = h.getFontSize();
    seg.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      const on = b.dataset.size === cur;
      b.classList.toggle('ts-seg-on', on);
      b.setAttribute('aria-pressed', String(on));
    });
  };
  for (const s of sizes) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ts-seg-btn';
    b.dataset.size = s.v;
    b.textContent = s.label;
    b.addEventListener('click', () => {
      h.onFontSizeChange(s.v);
      paintSeg();
    });
    seg.appendChild(b);
  }
  sizeWrap.append(sizeLabel, seg);
  root.appendChild(sizeWrap);
  paintSeg();

  // ----- typography steppers (optional; only when wired) -----
  const getTypo = h.getTypography;
  const onTypo = h.onTypographyChange;
  if (getTypo && onTypo) {
    const rows: { key: keyof TypographyPref; label: string; fmt: (v: number) => string }[] = [
      { key: 'letterSpacing', label: t('type.letterSpacing'), fmt: (v) => `${v}px` },
      { key: 'charScaleX', label: t('type.charWidth'), fmt: (v) => `${Math.round(v * 100)}%` },
      { key: 'lineHeight', label: t('type.lineHeight'), fmt: (v) => `${v.toFixed(1)}×` },
    ];
    const typoWrap = document.createElement('div');
    typoWrap.className = 'ts-section';
    const typoLabel = document.createElement('div');
    typoLabel.className = 'ts-label';
    typoLabel.textContent = t('type.title');
    typoWrap.appendChild(typoLabel);
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'ts-row';
      const name = document.createElement('span');
      name.className = 'ts-row-label';
      name.textContent = r.label;
      const stepper = document.createElement('div');
      stepper.className = 'ts-stepper';
      const minus = document.createElement('button');
      minus.type = 'button';
      minus.className = 'ts-step-btn';
      minus.textContent = '−';
      minus.setAttribute('aria-label', `${r.label} −`);
      const val = document.createElement('span');
      val.className = 'ts-step-val';
      const plus = document.createElement('button');
      plus.type = 'button';
      plus.className = 'ts-step-btn';
      plus.textContent = '+';
      plus.setAttribute('aria-label', `${r.label} +`);
      const paintVal = () => {
        val.textContent = r.fmt(getTypo()[r.key]);
      };
      const step = (dir: 1 | -1) => {
        onTypo(stepTypography(getTypo(), r.key, dir));
        paintVal();
      };
      minus.addEventListener('click', () => step(-1));
      plus.addEventListener('click', () => step(1));
      stepper.append(minus, val, plus);
      row.append(name, stepper);
      typoWrap.appendChild(row);
      paintVal();
    }
    root.appendChild(typoWrap);
  }

  return root;
}
