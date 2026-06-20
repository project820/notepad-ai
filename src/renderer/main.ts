import { createEditor, type EditorHandle } from './editor';
import { createPreview, type PreviewHandle } from './preview';
import { createSelectionSync, clearPreviewHighlight } from './selection-sync';
import { collectPreviewBlocks } from './source-preview-map';
import { setLineSpacers, clearLineSpacers, computeBidirectionalAlignment, MAX_SPACER_PX, type LineAlignmentBlock, type PreviewSpacer } from './cm-line-alignment';
import { createToolbar, paintAccountState, type Theme, type FontSize } from './toolbar';
import { t, getLocale, setLocale, onLocaleChange, type Locale } from './i18n';
import { installKeyboardNav } from './keyboard-nav';
import { loadPrefs, savePrefs, applyTheme, applyFontSize, resolvedDark } from './prefs';
import { wirePreviewTables } from './preview-table-edit';
import { applyToEditor, applyToPreview, type FormatAction } from './formatting';
import { htmlToMarkdown } from './html-to-md';
import { openLoginModal } from './login-modal';
import { mountUnifiedChat, type ChatMode } from './unified-chat';
import { clampChatWidth } from './chat-layout';
import { openSettingsModal } from './settings-modal';
import { restoreUnifiedThread, threadToTurns, type UnifiedChatItem } from './unified-chat-history';
import { buildUnifiedChatInstructions } from './unified-chat-prompt-handler';
import { styleDirective, detectLanguage, type Naturalness } from './humanize-engine';
import { guardVerdict } from './humanize-guards';
import type { Quality } from './quality';
import { typographyCssVars, clampTypography, type TypographyPref } from './typography';
import { wirePreviewLinks } from './preview-links';
import { mountLeftPanel } from './left-panel';
import type { AiProviderId, ModelRef, ProviderAuthStatus } from '../main/ai/types';
import {
  renderEditableDraft,
  renderManualExplanationPrompt,
  renderProjectWizardConsent,
  type ManualExplanationQuestion,
} from './project-wizard-panel';
import { installBlockAi } from './block-ai';
import { installTooltips } from './tooltips';
import { wireWordmark } from './header-wordmark';
import { installSelectionFormatMenu } from './selection-format-menu';
import { mountHtmlExportWizard, type HtmlExportWizardHandle } from './html-export-wizard';
import { EditorSelection } from '@codemirror/state';

type AuthSnapshot = {
  signedIn: boolean;
  email?: string;
  plan?: string;
  persisted?: boolean;
  warning?: string;
  expiresAt?: number;
};

type LoginUpdate =
  | { kind: 'usercode'; userCode: string; verificationUri: string }
  | { kind: 'success'; auth: AuthSnapshot }
  | { kind: 'error'; message: string };

type ProjectWizardSaveApprovedDraftInput = {
  projectFolder: string;
  body: string;
  frontmatter: Record<string, unknown>;
  inherits: boolean;
  lastScanned: string | null;
};

type ProjectWizardStateResult = {
  projectFolder: string;
  overviewPath: string;
  stage:
    | 'idle'
    | 'consent'
    | 'scan_scope'
    | 'analysis_profile'
    | 'manual_questions'
    | 'scanned'
    | 'drafted'
    | 'approved'
    | 'canceled'
    | 'blocked';
  stageStatements: Array<{ at: string; stage: string; message: string; data?: Record<string, unknown> }>;
};

type ProjectWizardSaveApprovedDraftResult = {
  status: 'not_ready' | 'partially_ready' | 'ready';
  overviewPath: string;
  markdown: string;
};

type Api = {
  onFileOpened: (cb: (file: { filePath: string; content: string }) => void) => void;
  onMenuNew: (cb: () => void) => void;
  onMenuSave: (cb: () => void) => void;
  onMenuSaveAs: (cb: () => void) => void;
  onTogglePreview: (cb: () => void) => void;
  windowReady: () => void;
  saveFile: (filePath: string | null, content: string) => Promise<{ saved: boolean; filePath?: string; error?: string; ownerWindowId?: number }>;
  authStatus: () => Promise<AuthSnapshot>;
  authLogin: () => Promise<void>;
  authCancelLogin: () => Promise<void>;
  authLogout: () => Promise<void>;
  onAuthLoginUpdate: (cb: (u: LoginUpdate) => void) => void;
  aiChat: (id: string, instructions: string, history: { role: 'user' | 'assistant'; text: string }[], userText: string, model?: string | { provider: AiProviderId; id: string }) => Promise<void>;
  aiCancel: (id: string) => Promise<void>;
  onAiChatEvent: (id: string, cb: (e: { kind: 'delta' | 'done' | 'error'; text?: string; message?: string; errorKind?: string }) => void) => () => void;
  aiModels: (force?: boolean) => Promise<ModelRef[]>;
  aiProvidersStatus: () => Promise<ProviderAuthStatus[]>;
  aiHasAnyAuth: () => Promise<boolean>;
  aiSetApiKey: (provider: AiProviderId, key: string) => Promise<{ persisted: boolean }>;
  aiDeleteProviderKey: (provider: AiProviderId) => Promise<void>;
  getPromptAssemblyContext: () => Promise<{ enabled: boolean; systemlawContent: string; ownerContent: string }>;
  projectWizardStart: (projectFolder: string) => Promise<ProjectWizardStateResult>;
  projectWizardSaveApprovedDraft: (input: ProjectWizardSaveApprovedDraftInput) => Promise<ProjectWizardSaveApprovedDraftResult>;
  sessionGet: () => Promise<any>;
  sessionWrite: (snap: any) => Promise<void>;
  sessionClear: () => Promise<void>;
  checkForUpdate: () => Promise<{ updateAvailable: boolean; currentVersion: string; latestVersion: string; url: string } | null>;
  openExternal: (url: string) => Promise<void>;
  appVersion: () => Promise<string>;
  fetchDesignMd: (input: string) => Promise<{ ok: boolean; designMd?: string; rawUrl?: string; error?: string }>;
  saveHtml: (args: { html: string; defaultName?: string }) => Promise<{ saved: boolean; filePath?: string }>;
  openSavedHtml: (filePath: string) => Promise<{ opened: boolean; error?: string }>;
  mdHandlerStatus: () => Promise<{ supported: boolean; registered?: boolean }>;
  registerMdHandler: () => Promise<{ ok: boolean; registered?: boolean; error?: string }>;
};

declare global {
  interface Window {
    api: Api;
  }
}

const workspace = document.querySelector('.workspace') as HTMLElement;
const editorHost = document.getElementById('editor-host') as HTMLDivElement;
const previewHost = document.getElementById('preview-host') as HTMLDivElement;
const toolbarHost = document.getElementById('toolbar') as HTMLDivElement;
const titleEl = document.getElementById('title') as HTMLInputElement;
const dirtyEl = document.getElementById('dirty') as HTMLDivElement;
const statusEl = document.getElementById('status') as HTMLSpanElement;
const wordCountEl = document.getElementById('word-count') as HTMLSpanElement;
const splitterEl = document.querySelector('.splitter') as HTMLElement;

let currentPath: string | null = null;
let pendingTitle: string | null = null;
let dirty = false;
let autosaveTimer: ReturnType<typeof setTimeout> | null = null;

type PreviewMode = 'split' | 'editor-only' | 'preview-only';
let previewMode: PreviewMode = 'split';

// Set when an imported (HWP/DOCX/PDF/XLSX) file's rich HTML is available.
// User can toggle the preview pane to show this verbatim instead of the
// markdown-it rendering of the (turndown-derived) MD source.
let convertedHtml: string | null = null;
let showingConvertedHtml = false;

// Which surface should toolbar buttons act on? Tracks last-focused editing surface.
type ActiveSurface = 'editor' | 'preview';
let activeSurface: ActiveSurface = 'editor';

const prefs = loadPrefs();
// CRITICAL: locale must be set BEFORE any UI is rendered, otherwise the
// first preview.setDoc / createToolbar / mountSideChat will use the default
// 'en' dictionary and the user sees a flash of English before switching.
setLocale((prefs.locale as Locale) ?? 'en');
applyTheme(prefs.theme);
applyFontSize(prefs.fontSize);

function applyTypography(p: TypographyPref) {
  const vars = typographyCssVars(p);
  for (const [k, v] of Object.entries(vars)) document.documentElement.style.setProperty(k, v);
}
applyTypography(prefs.typography ?? { letterSpacing: 0, charScaleX: 1, lineHeight: 1 });

if (prefs.splitRatio != null) {
  workspace.style.setProperty('--split-left', `${prefs.splitRatio}fr`);
  workspace.style.setProperty('--split-right', `${1 - prefs.splitRatio}fr`);
}

function displayTitle(): string {
  if (currentPath) return currentPath.split('/').pop() ?? 'Untitled';
  return pendingTitle ?? 'Untitled';
}

function setTitle() {
  if (document.activeElement !== titleEl) {
    titleEl.value = displayTitle();
  }
  dirtyEl.classList.toggle('dirty', dirty);
}

function updateWordCount(doc: string) {
  const chars = doc.length;
  const words = doc.trim() === '' ? 0 : doc.trim().split(/\s+/).length;
  wordCountEl.textContent = `${words.toLocaleString()} words · ${chars.toLocaleString()} chars`;
}

let editor: EditorHandle;
let preview: PreviewHandle;
let suppressEditorChange = false;
let editingInPreview = false; // true while user is actively typing in the preview pane
let previewSyncTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleAutosave() {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    if (currentPath) void save();
  }, 3000);
}

function onDocChange(doc: string) {
  if (suppressEditorChange) return;
  if (!dirty) {
    dirty = true;
    setTitle();
  }
  // Avoid clobbering the preview while the user is typing there.
  if (!editingInPreview) preview.setDoc(doc);
  updateWordCount(doc);
  scheduleAutosave();
}

async function save() {
  const result = await window.api.saveFile(currentPath, editor.getDoc());
  if (result.saved && result.filePath) {
    currentPath = result.filePath;
    pendingTitle = null;
    dirty = false;
    setTitle();
    statusEl.textContent = `Saved • ${result.filePath}`;
  } else if (result.error === 'already-open') {
    // Another window owns this path; main focused it. Keep dirty + path so the
    // user never silently loses their edit (no last-writer-wins).
    statusEl.textContent = '⚠ 이 파일은 다른 창에서 열려 있어 저장하지 않았습니다.';
  }
}

async function saveAs() {
  const result = await window.api.saveFile(null, editor.getDoc());
  if (result.saved && result.filePath) {
    currentPath = result.filePath;
    pendingTitle = null;
    dirty = false;
    setTitle();
    statusEl.textContent = `Saved • ${result.filePath}`;
  } else if (result.error === 'already-open') {
    statusEl.textContent = '⚠ 이 파일은 다른 창에서 열려 있어 저장하지 않았습니다.';
  }
}

function newDoc() {
  currentPath = null;
  pendingTitle = null;
  editor.setDoc('');
  preview.setDoc('');
  dirty = false;
  setTitle();
  updateWordCount('');
  statusEl.textContent = 'New document';
  editor.focus();
}

function applyPreviewMode() {
  workspace.classList.remove('mode-split', 'mode-editor-only', 'mode-preview-only');
  workspace.classList.add(`mode-${previewMode}`);
}

function cyclePreviewMode() {
  previewMode =
    previewMode === 'split' ? 'preview-only' : previewMode === 'preview-only' ? 'editor-only' : 'split';
  applyPreviewMode();
  const labels: Record<PreviewMode, string> = {
    split: 'split',
    'preview-only': 'rich preview',
    'editor-only': 'raw markdown',
  };
  statusEl.textContent = `View • ${labels[previewMode]}`;
  // When switching into preview-only or split, the preview is the natural surface to format.
  if (previewMode === 'preview-only') activeSurface = 'preview';
  if (previewMode === 'editor-only') activeSurface = 'editor';
  // Cross-pane selection highlight is split-only; drop it when leaving split.
  if (previewMode !== 'split') selectionSync.clearAll();
  scheduleLineAlign();
}

const initialDoc = '';

editor = createEditor(editorHost, {
  initialDoc,
  onChange: onDocChange,
});

preview = createPreview(previewHost);
preview.onAfterRender(() => {
  wirePreviewTables(preview.el, () => editor.getDoc(), (newDoc) => {
    suppressEditorChange = true;
    editor.setDoc(newDoc);
    suppressEditorChange = false;
    if (!dirty) {
      dirty = true;
      setTitle();
    }
    preview.setDoc(newDoc);
    updateWordCount(newDoc);
    scheduleAutosave();
  });
});
wirePreviewLinks(preview.el, {
  openExternal: (url) => void window.api.openExternal(url),
  backLabel: t('footnote.back'),
  scroller: previewHost,
});

// ----- Left panel: outline + footnotes (#7) -----
const leftPanelHost = document.getElementById('left-panel') as HTMLDivElement;
const leftPanel = mountLeftPanel(leftPanelHost, {
  getPreviewRoot: () => preview.el,
  onJump: (el) => el.scrollIntoView({ block: 'center' }),
});
preview.onAfterRender(() => leftPanel.refresh());
let leftPanelOpen = true;
function setLeftPanelOpen(open: boolean) {
  leftPanelOpen = open;
  document.querySelector('.content-row')?.classList.toggle('left-open', open);
  if (open) leftPanel.refresh();
}
function toggleLeftPanel() {
  setLeftPanelOpen(!leftPanelOpen);
}
setLeftPanelOpen(true);
preview.setDoc(initialDoc);
preview.setLineNumbers(prefs.previewLineNumbers ?? false);
updateWordCount(initialDoc);
applyPreviewMode();
editor.applyTheme(resolvedDark(prefs.theme));

// ----- Selection sync (G004): cross-pane highlight, split-view only -----
// Coalesce bursts of selection events into a single per-frame update.
function createRafThrottle(): (cb: () => void) => void {
  let scheduled = false;
  let latest: (() => void) | null = null;
  return (cb) => {
    latest = cb;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const fn = latest;
      latest = null;
      fn?.();
    });
  };
}

const selectionSync = createSelectionSync({
  getPreviewRoot: () => preview.el,
  editor: {
    setHighlightedLines: (lines) => editor.setHighlightedLines(lines),
    clearHighlight: () => editor.clearHighlight(),
  },
  isActive: () => previewMode === 'split' && !showingConvertedHtml,
  getSelection: () => window.getSelection(),
});

const editorToPreviewSync = createRafThrottle();
editor.onSelectionChange((span) => editorToPreviewSync(() => selectionSync.syncEditorToPreview(span)));

const previewToEditorSync = createRafThrottle();
document.addEventListener('selectionchange', () => previewToEditorSync(() => selectionSync.syncPreviewToEditor()));

// A preview re-render (setDoc) rebuilds the source map → existing highlights are
// stale, so clear both directions and let the next selection recompute.
preview.onAfterRender(() => selectionSync.clearAll());

// Blur: when the editor truly loses focus, drop the preview blocks it was driving.
editorHost.addEventListener('focusout', () => {
  requestAnimationFrame(() => {
    if (!editorHost.contains(document.activeElement)) clearPreviewHighlight(preview.el);
  });
});

// ----- Raw line alignment (G005): split-view spacers, display-only -----
// Insert vertical spacers before source lines so the raw editor's blocks line up
// with the rendered preview blocks (built on the same G003 map A consumes). The
// spacers are CM block widgets — never document text — so they never touch the
// saved markdown or the undo history.
const MAX_ALIGN_SPACERS = 400; // long-document guard: cap spacers measured per pass

function lineAlignActive(): boolean {
  return (
    (prefs.rawLineAlign ?? false) &&
    previewMode === 'split' &&
    !showingConvertedHtml &&
    !editingInPreview
  );
}

const PREVIEW_SHIFT_ATTR = 'data-line-align-shift';

/** Remove every preview-side alignment offset. We shift each block via its OWN
 *  inline margin-top (no extra nodes), so Turndown is unaffected (it ignores
 *  style / data-*) and clearing is just resetting that inline margin. */
function clearPreviewOffsets(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>(`[${PREVIEW_SHIFT_ATTR}]`).forEach((el) => {
    el.style.marginTop = '';
    el.removeAttribute(PREVIEW_SHIFT_ATTR);
  });
}

/** Push mapped top-level preview blocks DOWN so the preview side of a
 *  bidirectional alignment grows to meet the editor. Each shifted block keeps its
 *  natural collapsed top gap plus the wanted offset (`naturalGap + heightPx`);
 *  because that new margin is ≥ the neighbour it would collapse with, it wins
 *  outright and the block moves by EXACTLY `heightPx` — margin-collapse can't eat
 *  into it (verified live). Shifts cascade through normal flow, so later blocks
 *  inherit earlier offsets, matching the cumulative geometry that
 *  computeBidirectionalAlignment produced. */
function setPreviewOffsets(root: HTMLElement, spacers: readonly PreviewSpacer[]): void {
  clearPreviewOffsets(root);
  if (spacers.length === 0) return;
  // mapId -> direct-child block element (top-level only; never nested dupes).
  const elByMapId = new Map<number, HTMLElement>();
  for (const child of Array.from(root.children)) {
    const id = child.getAttribute('data-map-id');
    if (id != null) elByMapId.set(Number(id), child as HTMLElement);
  }
  for (const s of spacers) {
    let h = Number.isFinite(s.heightPx) ? s.heightPx : 0;
    if (h <= 0) continue;
    if (h > MAX_SPACER_PX) h = MAX_SPACER_PX;
    const block = elByMapId.get(s.mapId);
    if (!block) continue;
    const curMT = parseFloat(getComputedStyle(block).marginTop) || 0;
    const prev = block.previousElementSibling;
    const prevMB = prev ? parseFloat(getComputedStyle(prev).marginBottom) || 0 : 0;
    const naturalGap = Math.max(prevMB, curMT);
    block.style.marginTop = `${naturalGap + h}px`;
    block.setAttribute(PREVIEW_SHIFT_ATTR, '1');
  }
}

/** Measure every mapped block's natural top in BOTH panes in ONE shared frame:
 *  the block's actual viewport Y plus its pane's own scrollTop (scroll-invariant).
 *  The preview block uses its real getBoundingClientRect; the editor line uses the
 *  CM6 height map (lineBlockAt) so off-screen lines are measurable too. lineBlockAt
 *  is in CM's internal document coordinates, which are offset from real viewport Y
 *  by a constant — we calibrate that constant ONCE from the first on-screen line
 *  (coordsAtPos gives its true viewport top) so editor and preview share the exact
 *  same frame and there is no uniform vertical offset between the panes.
 *  Both panes MUST be spacer-free when this runs (applyLineAlign clears first). */
function measureLineAlignBlocks(): LineAlignmentBlock[] {
  if (preview.getSourceMap().length === 0) return [];
  const view = editor.view;
  const docLines = view.state.doc.lines;
  // Measure both panes relative to their OWN scroller's border-box top, in content
  // space (scroll-invariant). The two scrollers sit side by side at the same
  // viewport Y, so aligning these values aligns the panes visually. For the editor,
  // use the line's real viewport top (coordsAtPos) when it's rendered; fall back to
  // the height map (contentDOM top + lineBlockAt) for off-screen lines.
  const cmTop = view.scrollDOM.getBoundingClientRect().top;
  const cmScrollTop = view.scrollDOM.scrollTop;
  const contentTop = view.contentDOM.getBoundingClientRect().top;
  const pRect = preview.el.getBoundingClientRect();
  const pScrollTop = preview.el.scrollTop;
  const out: LineAlignmentBlock[] = [];
  for (const block of collectPreviewBlocks(preview.el)) {
    if (block.startLine < 1 || block.startLine > docLines) continue;
    const pos = view.state.doc.line(block.startLine).from;
    const coords = view.coordsAtPos(pos);
    const lineViewportTop = coords ? coords.top : contentTop + view.lineBlockAt(pos).top;
    const editorTop = lineViewportTop - cmTop + cmScrollTop;
    const previewTop = (block.el as HTMLElement).getBoundingClientRect().top - pRect.top + pScrollTop;
    out.push({ line: block.startLine, mapId: block.mapId, previewTop, editorTop });
    if (out.length >= MAX_ALIGN_SPACERS) break;
  }
  return out;
}

function applyLineAlign(): void {
  if (!lineAlignActive()) {
    clearLineSpacers(editor.view);
    clearPreviewOffsets(preview.el);
    return;
  }
  // Clear BOTH panes first so the measurement reads natural (offset-free)
  // positions. CM updates the DOM synchronously on dispatch and clearPreviewOffsets
  // resets the inline margins synchronously, so the layout reads below reflect the
  // cleared state — and the whole pass runs inside one RAF callback, so the browser
  // never paints the intermediate (cleared) frame.
  clearLineSpacers(editor.view);
  clearPreviewOffsets(preview.el);
  const blocks = measureLineAlignBlocks();
  if (blocks.length === 0) return;
  const { editorSpacers, previewSpacers } = computeBidirectionalAlignment(blocks, MAX_SPACER_PX);
  setLineSpacers(editor.view, editorSpacers);
  setPreviewOffsets(preview.el, previewSpacers);
}

const lineAlignThrottle = createRafThrottle();
function scheduleLineAlign(): void {
  lineAlignThrottle(applyLineAlign);
}

// A preview re-render rebuilds the map → spacers are stale; recompute. Other
// triggers (split entry, toggle, splitter drag, font/typography, resize) call
// scheduleLineAlign() directly.
preview.onAfterRender(() => scheduleLineAlign());
window.addEventListener('resize', () => scheduleLineAlign());

// Scroll sync: while line-align is on, mirror scroll between the two panes 1:1.
// Bidirectional alignment gives both panes equal per-block tops, so a direct
// scrollTop mirror keeps the aligned blocks aligned as the user scrolls (and
// covers content past the rendered editor viewport). The lock suppresses the
// echoed scroll event the programmatic assignment fires.
let scrollSyncLock = false;
function mirrorScroll(from: 'editor' | 'preview'): void {
  if (!lineAlignActive() || scrollSyncLock) return;
  scrollSyncLock = true;
  const cm = editor.view.scrollDOM;
  if (from === 'editor') preview.el.scrollTop = cm.scrollTop;
  else cm.scrollTop = preview.el.scrollTop;
  requestAnimationFrame(() => {
    scrollSyncLock = false;
  });
}
editor.view.scrollDOM.addEventListener('scroll', () => mirrorScroll('editor'), { passive: true });
preview.el.addEventListener('scroll', () => mirrorScroll('preview'), { passive: true });

// ----- Preview live-editing: sync HTML -> MD on input (debounced) -----
function flushPreviewToSource(): boolean {
  // innerHTML serializes ATTRIBUTES not properties — checkbox toggles change
  // the .checked property but the attribute is stale. Sync them so turndown
  // sees the correct state.
  preview.el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((el) => {
    el.toggleAttribute('checked', el.checked);
  });
  const md = htmlToMarkdown(preview.el.innerHTML);
  if (md.trim() === editor.getDoc().trim()) return false;
  suppressEditorChange = true;
  editor.setDoc(md);
  suppressEditorChange = false;
  if (!dirty) {
    dirty = true;
    setTitle();
  }
  updateWordCount(md);
  scheduleAutosave();
  return true;
}

function syncPreviewToSource() {
  if (previewSyncTimer) clearTimeout(previewSyncTimer);
  previewSyncTimer = setTimeout(() => {
    if (!editingInPreview) return;
    flushPreviewToSource();
  }, 350);
}

preview.el.addEventListener('input', () => {
  editingInPreview = true;
  syncPreviewToSource();
});
// Checkbox toggles inside the contenteditable preview fire `change` but
// not always `input`. Treat them as edits.
preview.el.addEventListener('change', (e) => {
  const t = e.target as HTMLInputElement | null;
  if (t && t.type === 'checkbox') {
    editingInPreview = true;
    syncPreviewToSource();
  }
});
preview.el.addEventListener('focusin', () => {
  activeSurface = 'preview';
  statusEl.textContent = 'Editing • rich preview';
});
preview.el.addEventListener('focusout', () => {
  // Slight delay so toolbar clicks (which blur the preview briefly) still target it.
  setTimeout(() => {
    if (!preview.el.contains(document.activeElement)) {
      editingInPreview = false;
      // final sync + re-render preview from canonical source for stable formatting
      if (previewSyncTimer) clearTimeout(previewSyncTimer);
      preview.el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((el) => {
        el.toggleAttribute('checked', el.checked);
      });
      const md = htmlToMarkdown(preview.el.innerHTML);
      if (md.trim() !== editor.getDoc().trim()) {
        suppressEditorChange = true;
        editor.setDoc(md);
        suppressEditorChange = false;
        updateWordCount(md);
        scheduleAutosave();
      }
      preview.setDoc(editor.getDoc());
    }
  }, 100);
});

// Track when the editor (CM6) is the active surface
editorHost.addEventListener('focusin', () => {
  activeSurface = 'editor';
  statusEl.textContent = 'Editing • raw markdown';
});

// ----- Toolbar -----
function dispatchFormat(action: FormatAction) {
  if (previewMode === 'preview-only') activeSurface = 'preview';
  if (previewMode === 'editor-only') activeSurface = 'editor';
  // Footnotes are a MD-source construct (inline [^n] reference + an end-of-doc
  // [^n] definition). Insert them into the editor doc on BOTH surfaces — never
  // via raw DOM — then re-render the preview from the canonical source.
  if (action === 'footnote') {
    if (activeSurface === 'preview' && editingInPreview) flushPreviewToSource();
    applyToEditor(editor.view, 'footnote');
    if (activeSurface === 'preview') {
      editingInPreview = false;
      preview.setDoc(editor.getDoc());
    }
    return;
  }
  if (activeSurface === 'preview') {
    // A format inside a table cell must keep the cell's selection (focusing the
    // preview root would collapse it) and must NOT trigger the global Turndown
    // re-sync — the table's own cell-blur handler persists it via table-md (#4).
    const inTableCell = !!(document.activeElement as HTMLElement | null)?.closest('.preview-table-wrap');
    if (!preview.el.contains(document.activeElement)) preview.el.focus({ preventScroll: true });
    applyToPreview(action);
    if (!inTableCell) {
      editingInPreview = true;
      syncPreviewToSource();
    }
  } else {
    applyToEditor(editor.view, action);
  }
}

let cachedAuth: AuthSnapshot = { signedIn: false };

// Shared in-renderer cache for the model list so toolbar AND block-AI both
// return synchronously instead of doing an IPC roundtrip on every dropdown
// open. Fired off once at startup so the first click is also instant.
let rendererModels: { id: string; label?: string; provider?: string }[] | null = null;
let rendererModelsPromise: Promise<{ id: string; label?: string; provider?: string }[]> | null = null;
async function loadModelsCached(): Promise<{ id: string; label?: string; provider?: string }[]> {
  if (rendererModels) return rendererModels;
  if (!rendererModelsPromise) {
    rendererModelsPromise = window.api.aiModels(false).then((m) => {
      rendererModels = m;
      return m;
    });
  }
  return rendererModelsPromise;
}
// Warm the cache eagerly.
void loadModelsCached();

createToolbar(toolbarHost, {
  getTheme: () => prefs.theme,
  getFontSize: () => prefs.fontSize,
  getModel: () => prefs.model ?? 'gpt-5.4-mini',
  getLocale: () => getLocale(),
  getAuth: () => cachedAuth,
  loadModels: () => loadModelsCached(),
  onModelChange: (id) => {
    prefs.model = id;
    savePrefs(prefs);
    statusEl.textContent = `Model · ${id}`;
  },
  onLocaleChange: (l) => {
    prefs.locale = l;
    savePrefs(prefs);
    setLocale(l);
  },
  onToggleSideChat: () => toggleUnifiedChat(),
  onToggleOutline: () => toggleLeftPanel(),
  onTogglePreviewLines: () => {
    const next = !(prefs.previewLineNumbers ?? false);
    prefs.previewLineNumbers = next;
    savePrefs(prefs);
    preview.setLineNumbers(next);
  },
  getPreviewLines: () => prefs.previewLineNumbers ?? false,
  onToggleRawLineAlign: () => {
    const next = !(prefs.rawLineAlign ?? false);
    prefs.rawLineAlign = next;
    savePrefs(prefs);
    scheduleLineAlign();
  },
  getRawLineAlign: () => prefs.rawLineAlign ?? false,
  onOpenSettings: () => openSettings(),
  onSignIn: () => openLoginModal({ onAfterLogin: (a) => { cachedAuth = a; paintAuthPill(a); } }),
  onSignOut: async () => {
    await window.api.authLogout();
    cachedAuth = { signedIn: false };
    paintAuthPill(cachedAuth);
    statusEl.textContent = t('status.signedOut');
  },
  onFormat: dispatchFormat,
  onInsertTable: (rows, cols) => {
    // Single insertion path: always write the Markdown table into the source
    // (MD is the source of truth). The preview re-renders from the updated doc.
    editor.insertTable(rows, cols);
    statusEl.textContent = `Inserted ${rows} × ${cols} table`;
  },
  onTogglePreview: cyclePreviewMode,
  onThemeChange: (t: Theme) => {
    prefs.theme = t;
    savePrefs(prefs);
    applyTheme(t);
    editor.applyTheme(resolvedDark(t));
  },
  onFontSizeChange: (s: FontSize) => {
    prefs.fontSize = s;
    savePrefs(prefs);
    applyFontSize(s);
    scheduleLineAlign();
  },
});

// ----- Title rename -----
titleEl.addEventListener('focus', () => titleEl.select());
titleEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    titleEl.blur();
  }
  if (e.key === 'Escape') {
    titleEl.value = displayTitle();
    titleEl.blur();
  }
});
titleEl.addEventListener('blur', () => {
  const raw = titleEl.value.trim();
  if (!raw || raw === displayTitle()) {
    titleEl.value = displayTitle();
    return;
  }
  const withExt = /\.\w+$/.test(raw) ? raw : `${raw}.md`;
  if (currentPath) {
    const dir = currentPath.replace(/\/[^/]+$/, '');
    const newPath = `${dir}/${withExt}`;
    void (async () => {
      const result = await window.api.saveFile(newPath, editor.getDoc());
      if (result.saved && result.filePath) {
        currentPath = result.filePath;
        pendingTitle = null;
        dirty = false;
        statusEl.textContent = `Renamed • ${result.filePath}`;
        setTitle();
      }
    })();
  } else {
    pendingTitle = withExt;
    titleEl.value = withExt;
    statusEl.textContent = `Title set • will save as "${withExt}"`;
  }
});

// ----- Splitter drag -----
let dragging = false;
splitterEl.addEventListener('mousedown', (e) => {
  e.preventDefault();
  dragging = true;
  splitterEl.classList.add('dragging');
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
});
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const rect = workspace.getBoundingClientRect();
  const ratio = Math.max(0.1, Math.min(0.9, (e.clientX - rect.left) / rect.width));
  workspace.style.setProperty('--split-left', `${ratio}fr`);
  workspace.style.setProperty('--split-right', `${1 - ratio}fr`);
});
window.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  splitterEl.classList.remove('dragging');
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  const cs = getComputedStyle(workspace);
  const cols = cs.gridTemplateColumns.split(' ');
  if (cols.length >= 3) {
    const l = parseFloat(cols[0]);
    const r = parseFloat(cols[2]);
    if (Number.isFinite(l) && Number.isFinite(r) && l + r > 0) {
      prefs.splitRatio = l / (l + r);
      savePrefs(prefs);
    }
  }
  scheduleLineAlign();
});

// ----- Scroll sync (suppressed while preview is being typed in) -----
let syncing = false;
const editorScroller = editorHost.querySelector('.cm-scroller') as HTMLElement | null;
if (editorScroller) {
  editorScroller.addEventListener('scroll', () => {
    if (syncing || editingInPreview) return;
    const ratio = editorScroller.scrollTop / Math.max(1, editorScroller.scrollHeight - editorScroller.clientHeight);
    syncing = true;
    preview.el.scrollTop = ratio * Math.max(0, preview.el.scrollHeight - preview.el.clientHeight);
    requestAnimationFrame(() => (syncing = false));
  });
}
preview.el.addEventListener('scroll', () => {
  if (syncing || !editorScroller || editingInPreview) return;
  const ratio = preview.el.scrollTop / Math.max(1, preview.el.scrollHeight - preview.el.clientHeight);
  syncing = true;
  editorScroller.scrollTop = ratio * Math.max(0, editorScroller.scrollHeight - editorScroller.clientHeight);
  requestAnimationFrame(() => (syncing = false));
});

window.api.onFileOpened((payload: any) => {
  const { filePath, content, html, converted, error } = payload as {
    filePath: string | null;
    content: string;
    html?: string;
    converted?: { from: string; originalPath: string };
    error?: string;
  };
  if (error) {
    statusEl.textContent = `⚠ ${error}`;
    return;
  }
  currentPath = filePath ?? null;
  pendingTitle = null;
  let docMd = content;
  if (html && converted) {
    try {
      const md = htmlToMarkdown(html);
      if (md && md.trim().length > 0) docMd = md;
    } catch (e) {
      console.warn('turndown of kordoc HTML failed; using raw markdown:', e);
    }
    convertedHtml = html;
  } else {
    convertedHtml = null;
    showingConvertedHtml = false;
  }
  editor.setDoc(docMd);
  if (showingConvertedHtml && convertedHtml) {
    preview.el.innerHTML = convertedHtml;
  } else {
    preview.setDoc(docMd);
  }
  dirty = !!converted;
  setTitle();
  updateWordCount(docMd);
  updateHtmlViewToggle();
  if (converted) {
    statusEl.textContent = `Converted from ${converted.from} • will save as ${filePath}`;
  } else {
    statusEl.textContent = `Opened • ${filePath}`;
  }
});

// ----- HTML-view toggle (only meaningful when a converted file is loaded) -----
function updateHtmlViewToggle() {
  let btn = document.getElementById('view-html-toggle') as HTMLButtonElement | null;
  if (!convertedHtml) {
    btn?.remove();
    return;
  }
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'view-html-toggle';
    btn.className = 'view-html-toggle';
    btn.addEventListener('click', () => {
      showingConvertedHtml = !showingConvertedHtml;
      // Switching the preview source (rich HTML ↔ markdown) invalidates the map.
      selectionSync.clearAll();
      if (showingConvertedHtml && convertedHtml) {
        preview.el.innerHTML = convertedHtml;
      } else {
        preview.setDoc(editor.getDoc());
      }
      updateHtmlViewToggle();
      scheduleLineAlign();
    });
    // Insert just before the word-count span in the status bar
    const sb = document.querySelector('.statusbar');
    sb?.insertBefore(btn, document.getElementById('word-count'));
  }
  btn.textContent = showingConvertedHtml ? 'View MD' : 'View HTML';
  btn.title = showingConvertedHtml
    ? 'Switch back to the markdown-rendered preview'
    : 'Show kordoc\'s rich HTML rendering';
}

window.api.onMenuNew(newDoc);
window.api.onMenuSave(() => void save());
window.api.onMenuSaveAs(() => void saveAs());
window.api.onTogglePreview(cyclePreviewMode);

// This window can now safely receive `file:opened`: the file + menu listeners are
// installed, so tell main to flush any open payload queued during window creation.
window.api.windowReady();

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 't' && !e.shiftKey) {
    e.preventDefault();
    const btn = document.getElementById('tb-insert-table') as HTMLButtonElement | null;
    btn?.click();
  }
  if ((e.metaKey || e.ctrlKey) && (e.key === 'j' || e.key === 'J' || e.key === ';')) {
    e.preventDefault();
    toggleUnifiedChat();
  }
  if (e.key === 'Escape' && ucInflight) {
    void window.api.aiCancel(ucInflight.id);
  }
});

const themeMql = window.matchMedia('(prefers-color-scheme: dark)');
themeMql.addEventListener('change', (e) => {
  if (prefs.theme === 'system') editor.applyTheme(e.matches);
});

window.addEventListener('beforeunload', () => {
  // Best-effort flush on quit. We must NOT call preventDefault()/returnValue here:
  // in Electron that silently cancels the quit (no dialog), so the app would only
  // close via force-quit. Autosave + the session snapshot already preserve work.
  if (dirty) void save();
  scheduleSessionSnapshot();
});

setTitle();
editor.focus();
installKeyboardNav();

installTooltips();

// ----- Brand wordmark: version tooltip + GitHub star link (AC2) -----
const wordmarkEl = document.getElementById('wordmark');
if (wordmarkEl) {
  const wordmark = wireWordmark(wordmarkEl, {
    openExternal: (url) => void window.api.openExternal(url),
    getVersion: () => window.api.appVersion(),
  });
  onLocaleChange(() => wordmark.relabel());
}

// ---------------- Block AI (F3) -----------------
installBlockAi({
  view: editor.view,
  previewEl: preview.el,
  getModel: () => prefs.model,
  getBlockModel: () => prefs.blockModel ?? 'gpt-5.4-mini',
  onBlockModelChange: (id) => { prefs.blockModel = id; savePrefs(prefs); },
  loadModels: () => loadModelsCached(),
  getQuality: () => currentStyle().difficulty,
  getNaturalness: () => currentStyle().naturalness,
  // v1.1 Phase 1: fetch toggle state + userData file contents from main process.
  // When toggle is off the IPC returns empty strings so the handler falls back
  // to the v1.0 legacy path — byte-identical to pre-v1.1 behaviour.
  getPromptAssemblyContext: () => window.api.getPromptAssemblyContext(),
});

// ---------------- Selection right-click format menu (#5) -----------------
installSelectionFormatMenu({
  editorEl: editorHost,
  previewEl: preview.el,
  hasEditorSelection: () => !editor.view.state.selection.main.empty,
  dispatchFormat: (action, surface) => {
    activeSurface = surface;
    dispatchFormat(action);
  },
});

// Re-render preview (and its embedded table toolbar buttons) on locale change
function relabelTableToolbarsInPlace() {
  const labelMap: Record<string, [string, string]> = {
    'row+': ['table.addRow', 'table.addRowTitle'],
    'col+': ['table.addCol', 'table.addColTitle'],
    'row-': ['table.delRow', 'table.delRowTitle'],
    'col-': ['table.delCol', 'table.delColTitle'],
  };
  preview.el
    .querySelectorAll<HTMLButtonElement>('.preview-table-wrap .table-toolbar button[data-act]')
    .forEach((btn) => {
      const pair = labelMap[btn.dataset.act ?? ''];
      if (!pair) return;
      btn.textContent = t(pair[0]);
      btn.setAttribute('data-tooltip', t(pair[1]));
    });
}

onLocaleChange(() => {
  preview.el.querySelectorAll('table[data-wired="1"]').forEach((t) => t.removeAttribute('data-wired'));
  preview.setDoc(editor.getDoc());
  relabelTableToolbarsInPlace();
});

// ---------------- Codex OAuth (F7) -----------------
function paintAuthPill(auth: AuthSnapshot) {
  cachedAuth = auth;
  paintAccountState(auth.signedIn);
}

// ---------------- Unified AI Chat (⌘J / ⌘;) -----------------
const unifiedChatHost = document.getElementById('unified-chat') as HTMLDivElement;
const contentRow = document.querySelector('.content-row') as HTMLElement;
const ucResizer = document.querySelector('.uc-resizer') as HTMLDivElement;
const aiFab = document.getElementById('ai-fab') as HTMLButtonElement;
aiFab.addEventListener('click', () => toggleUnifiedChat());
function applyAiOutput(action: 'replace' | 'insert', md: string) {
  if (action === 'replace') {
    suppressEditorChange = true;
    editor.setDoc(md);
    suppressEditorChange = false;
    preview.setDoc(md);
    if (!dirty) { dirty = true; setTitle(); }
    updateWordCount(md);
    scheduleAutosave();
  } else {
    const { state } = editor.view;
    const pos = state.selection.main.from;
    editor.view.dispatch({
      changes: { from: pos, insert: md },
      selection: EditorSelection.cursor(pos + md.length),
      scrollIntoView: true,
    });
  }
}

let unifiedChatHistory: UnifiedChatItem[] = [];
let ucOpen = false;
let ucInflight: { id: string; cleanup: () => void } | null = null;
const wizardQuestions: ManualExplanationQuestion[] = ['purpose', 'folder_scope', 'constraints'];

function ucId(): string {
  return 'uc-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function setUnifiedChatOpen(open: boolean) {
  ucOpen = open;
  contentRow.classList.toggle('uc-open', open);
  unifiedChatHost.hidden = !open;
  ucResizer.hidden = !open;
  aiFab.classList.toggle('hidden', open);
  if (open) setTimeout(() => unifiedChatHost.querySelector<HTMLTextAreaElement>('.uc-input')?.focus(), 60);
}

function toggleUnifiedChat() {
  setUnifiedChatOpen(!ucOpen);
}

function currentStyle(): { difficulty: Quality; naturalness: Naturalness } {
  return prefs.style ?? { difficulty: prefs.quality ?? 'college', naturalness: 'balanced' };
}

function currentModelArg(): string | { provider: AiProviderId; id: string } | undefined {
  return prefs.selectedModel ?? prefs.model;
}

/** Source-markdown char budget for HTML export, sized to the selected model's
 *  context window (provider-level). Generous so normal documents are never
 *  truncated; bounded so a pathological multi-MB paste can't overflow the smallest
 *  context. */
function htmlExportSourceCharBudget(model: string | { provider: AiProviderId; id: string } | undefined): number {
  const provider: AiProviderId = typeof model === 'object' && model ? model.provider : 'chatgpt';
  switch (provider) {
    case 'claude':
      return 320_000; // ~200K-token context
    case 'openrouter':
      return 260_000; // smallest curated context (~128K tokens)
    default:
      return 420_000; // chatgpt codex backend (large context)
  }
}

function applyStyle(next: { difficulty: Quality; naturalness: Naturalness }) {
  prefs.style = next;
  prefs.quality = next.difficulty; // keep legacy difficulty in sync (Block AI etc.)
  savePrefs(prefs);
  statusEl.textContent = `Style · ${next.difficulty} · ${next.naturalness}`;
}

function openSettings() {
  openSettingsModal({
    getStyle: () => currentStyle(),
    onStyleChange: (s) => applyStyle(s),
    onAfterAuthChange: () => {
      rendererModels = null;
      rendererModelsPromise = null;
      void loadModelsCached();
      void (async () => {
        cachedAuth = await window.api.authStatus();
        paintAuthPill(cachedAuth);
      })();
    },
    onSetCustomModel: (provider, modelId) => {
      prefs.selectedModel = { provider, id: modelId };
      if (provider === 'chatgpt') prefs.model = modelId;
      savePrefs(prefs);
      statusEl.textContent = `Model · ${provider} · ${modelId}`;
    },
    getTypography: () => clampTypography(prefs.typography),
    onTypographyChange: (next) => {
      prefs.typography = clampTypography(next);
      savePrefs(prefs);
      applyTypography(prefs.typography);
      scheduleLineAlign();
    },
  });
}

async function sendUnified(text: string, mode: ChatMode) {
  const hasAuth = await window.api.aiHasAnyAuth().catch(() => true);
  if (!hasAuth) {
    unifiedChat.addMessage('user', text);
    unifiedChatHistory.push({ type: 'message', role: 'user', text });
    unifiedChat.addMessage(
      'assistant',
      'No AI provider is connected. Open Settings to sign in with ChatGPT or add a Claude / OpenRouter API key.',
    );
    statusEl.textContent = 'Connect an AI provider to use AI.';
    openSettings();
    return;
  }
  // Snapshot prior history BEFORE appending the new user turn.
  const priorTurns = threadToTurns(unifiedChatHistory);
  unifiedChat.addMessage('user', text);
  unifiedChatHistory.push({ type: 'message', role: 'user', text });

  const stream = unifiedChat.beginAssistant();
  const id = ucId();
  const lang = detectLanguage(text + ' ' + editor.getDoc().slice(0, 400));
  // Always-on humanize for Write; Advise answers conversationally (no rewrite).
  const styleStr =
    mode === 'advise'
      ? styleDirective({ ...currentStyle(), naturalness: 'off' }, lang)
      : styleDirective(currentStyle(), lang);

  let ctx = { enabled: false, systemlawContent: '', ownerContent: '' };
  try {
    ctx = await window.api.getPromptAssemblyContext();
  } catch {
    /* legacy path */
  }

  const instructions = buildUnifiedChatInstructions({
    toggleEnabled: ctx.enabled,
    systemlawContent: ctx.systemlawContent,
    ownerContent: ctx.ownerContent,
    styleDirectiveStr: styleStr,
    documentText: editor.getDoc().slice(0, 12000),
  });

  const cleanup = window.api.onAiChatEvent(id, (e) => {
    if (e.kind === 'delta' && e.text) {
      stream.pushDelta(e.text);
    } else if (e.kind === 'done') {
      const final = stream.finalize(e.text);
      unifiedChatHistory.push({ type: 'message', role: 'assistant', text: final });
      scheduleSessionSnapshot();
      cleanup();
      ucInflight = null;
    } else if (e.kind === 'error') {
      stream.fail(e.message ?? 'AI error');
      statusEl.textContent = e.message ?? 'AI error';
      cleanup();
      ucInflight = null;
    }
  });
  ucInflight = { id, cleanup };

  try {
    await window.api.aiChat(id, instructions, priorTurns, text, currentModelArg());
  } catch (err: any) {
    stream.fail(err?.message ?? String(err));
    cleanup();
    ucInflight = null;
  }
}

const unifiedChat = mountUnifiedChat(unifiedChatHost, {
  onSend: (text, mode) => {
    if (mode === 'project') return; // 'project' is driven by onProjectSetup
    void sendUnified(text, mode);
  },
  onInsert: (md) => applyAiOutput('insert', '\n' + md.trim() + '\n'),
  onReplace: (md) => {
    const next = md.trim();
    // AC14: meaning-preservation guard on the live output path. A full-document
    // replace that drops protected spans (numbers / code / quotes) prompts for
    // confirmation rather than silently losing facts.
    const verdict = guardVerdict(editor.getDoc(), next);
    if (verdict.blockApply) {
      const lost = [
        ...verdict.comparison.missingNumbers,
        ...verdict.comparison.missingInlineCode,
        ...verdict.comparison.missingCode,
        ...verdict.comparison.missingQuotes,
      ]
        .slice(0, 6)
        .join(', ');
      const ok = window.confirm(
        `This replacement drops protected content${lost ? ` (${lost})` : ''}. Replace anyway?`,
      );
      if (!ok) {
        statusEl.textContent = 'Replace canceled — meaning guard.';
        return;
      }
    } else if (verdict.overHumanized) {
      statusEl.textContent = 'Applied — heavy rewrite, review for meaning drift.';
    }
    applyAiOutput('replace', next);
  },
  onCopy: (md) => void navigator.clipboard.writeText(md),
  onProjectSetup: () => void startProjectWizard(),
  onHtmlExport: () => void startHtmlExportWizard(),
});

let htmlExportWizard: HtmlExportWizardHandle | null = null;

const HTML_EXPORT_INSTRUCTIONS =
  'You are an expert front-end engineer. You output a single, complete, self-contained HTML5 document with inline CSS and no remote or raster assets. Output only the HTML document — no Markdown and no code fences.';

/** Run one HTML generation over the streaming aiChat IPC, resolving with the full reply. */
function runHtmlGeneration(prompt: string): { result: Promise<string>; cancel: () => void } {
  let cancelled = false;
  let activeCancel = () => {};
  // undici/codex streams sometimes drop mid-generation ("terminated") on long
  // outputs or flaky networks. Retry once before surfacing the error.
  const isTransient = (m: string) => /terminated|network|stream error|econnreset|socket hang/i.test(m);

  const attempt = (): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      const id = ucId();
      let buffer = '';
      const cleanup = window.api.onAiChatEvent(id, (e) => {
        if (e.kind === 'delta' && e.text) {
          buffer += e.text;
        } else if (e.kind === 'done') {
          cleanup();
          resolve(e.text ?? buffer);
        } else if (e.kind === 'error') {
          cleanup();
          reject(new Error(e.message ?? 'AI error'));
        }
      });
      activeCancel = () => {
        void window.api.aiCancel(id);
        cleanup();
      };
      window.api.aiChat(id, HTML_EXPORT_INSTRUCTIONS, [], prompt, currentModelArg()).catch((err) => {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });

  const result = (async () => {
    try {
      return await attempt();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!cancelled && isTransient(msg)) return await attempt(); // one retry on a transient stream drop
      throw err;
    }
  })();

  return {
    result,
    cancel: () => {
      cancelled = true;
      activeCancel();
    },
  };
}

/** Open the HTML-export wizard inside the unified chat panel (⑤). */
async function startHtmlExportWizard() {
  const hasAuth = await window.api.aiHasAnyAuth().catch(() => true);
  if (!hasAuth) {
    setUnifiedChatOpen(true);
    unifiedChat.addMessage(
      'assistant',
      'No AI provider is connected. Open Settings to sign in with ChatGPT or add a Claude / OpenRouter API key.',
    );
    statusEl.textContent = 'Connect an AI provider to use AI.';
    openSettings();
    return;
  }
  setUnifiedChatOpen(true);
  unifiedChat.showPanel('<div class="he-host"></div>');
  const host = unifiedChatHost.querySelector<HTMLElement>('.he-host');
  if (!host) return;
  htmlExportWizard?.destroy();
  htmlExportWizard = mountHtmlExportWizard(host, {
    getMarkdown: () => editor.getDoc(),
    getMaxSourceChars: () => htmlExportSourceCharBudget(currentModelArg()),
    getCurrentPath: () => currentPath,
    getPendingTitle: () => pendingTitle,
    fetchDesignMd: (input) => window.api.fetchDesignMd(input),
    saveHtml: (args) => window.api.saveHtml(args),
    openSavedHtml: (filePath) => window.api.openSavedHtml(filePath),
    aiGenerate: (prompt) => runHtmlGeneration(prompt),
    openExternal: (url) => void window.api.openExternal(url),
    onCancel: () => {
      statusEl.textContent = 'HTML export canceled.';
    },
    t,
  });
}

// ----- Unified chat resize (AC8: freely resizable, capped at 50% window) -----
let ucResizing = false;
ucResizer.addEventListener('mousedown', (e) => {
  if (!ucOpen) return;
  ucResizing = true;
  e.preventDefault();
  document.body.style.userSelect = 'none';
  document.body.style.cursor = 'col-resize';
});
window.addEventListener('mousemove', (e) => {
  if (!ucResizing) return;
  const requested = window.innerWidth - e.clientX;
  const width = clampChatWidth(requested, window.innerWidth);
  contentRow.style.setProperty('--uc-width', `${width}px`);
});
window.addEventListener('mouseup', () => {
  if (!ucResizing) return;
  ucResizing = false;
  document.body.style.userSelect = '';
  document.body.style.cursor = '';
});
async function startProjectWizard() {
  const folder = currentPath ? folderFromFilePath(currentPath) : '';
  if (!folder) {
    statusEl.textContent = 'Save or open a project file before setup.';
    return;
  }
  try {
    await window.api.projectWizardStart(folder);
    setUnifiedChatOpen(true);
    showProjectWizardConsent(folder);
    statusEl.textContent = 'Project Wizard started.';
  } catch (error) {
    console.error('Project Wizard failed', error);
    statusEl.textContent = 'Project Wizard failed.';
  }
}

function folderFromFilePath(filePath: string): string {
  const slash = filePath.lastIndexOf('/');
  if (slash < 0) return '';
  return slash === 0 ? '/' : filePath.slice(0, slash);
}

function showProjectWizardConsent(folder: string) {
  unifiedChat.showPanel(renderProjectWizardConsent(folder), (action) => {
    if (action === 'start') {
      showProjectWizardQuestion(folder, 0, {});
      return;
    }
    if (action === 'later') {
      statusEl.textContent = 'Project Wizard saved for later.';
      return;
    }
    if (action === 'never') {
      statusEl.textContent = 'Project Wizard disabled for this folder.';
    }
  });
}

function showProjectWizardQuestion(
  folder: string,
  index: number,
  answers: Partial<Record<ManualExplanationQuestion, string>>,
) {
  const question = wizardQuestions[index];
  unifiedChat.showPanel(renderManualExplanationPrompt(question), (action, panel) => {
    if (action === 'cancel-draft') {
      statusEl.textContent = 'Project Wizard draft saved for later.';
      return;
    }
    if (action !== 'manual-next') return;

    const answer = (panel.querySelector('[data-pw-field="manual-answer"]') as HTMLTextAreaElement | null)?.value.trim() ?? '';
    if (!answer) {
      statusEl.textContent = 'Answer this question before continuing.';
      return;
    }
    const nextAnswers = { ...answers, [question]: answer };
    const nextIndex = index + 1;
    if (nextIndex < wizardQuestions.length) {
      showProjectWizardQuestion(folder, nextIndex, nextAnswers);
      return;
    }

    showProjectWizardDraft(folder, buildProjectWizardDraft(nextAnswers));
  });
}

function showProjectWizardDraft(folder: string, body: string) {
  unifiedChat.showPanel(renderEditableDraft(body), (action, panel) => {
    if (action === 'cancel-draft') {
      statusEl.textContent = 'Project Wizard draft saved for later.';
      return;
    }
    if (action !== 'approve-draft') return;

    const draftBody = (panel.querySelector('.pw-draft') as HTMLTextAreaElement | null)?.value ?? body;
    void window.api
      .projectWizardSaveApprovedDraft({
        projectFolder: folder,
        body: draftBody,
        frontmatter: {},
        inherits: true,
        lastScanned: null,
      })
      .then((result) => {
        statusEl.textContent = `Project Wizard saved · ${result.status.replace('_', ' ')}`;
      })
      .catch((error) => {
        console.error('Project Wizard save failed', error);
        statusEl.textContent = 'Project Wizard save failed.';
      });
  });
}

function buildProjectWizardDraft(answers: Partial<Record<ManualExplanationQuestion, string>>): string {
  const purpose = answers.purpose?.trim() || 'Describe this project.';
  const scope = answers.folder_scope?.trim() || 'Describe the folder scope.';
  const constraints = answers.constraints?.trim() || 'List constraints, risks, or things AI should not assume.';
  return [
    '## Purpose',
    purpose,
    '',
    '## Background',
    '',
    '## Current Goals',
    '',
    '## Writing Rules',
    constraints,
    '',
    '## Key Entities',
    '',
    '## Source Map',
    '| File | Role | Notes |',
    '|---|---|---|',
    `| ${folderLabelFromScope(scope)} | Project scope | ${scope} |`,
    '',
    '## Open Questions',
    '',
    '## Context Inbox Notes',
    '',
    '## Do Not Assume',
    constraints,
    '',
  ].join('\n');
}

function folderLabelFromScope(scope: string): string {
  return scope.replace(/\|/g, '/').replace(/\n+/g, ' ').slice(0, 80) || 'Project folder';
}

// ---------------- Session snapshot + crash recovery -----------------
let sessionSnapshotTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSessionSnapshot() {
  if (sessionSnapshotTimer) clearTimeout(sessionSnapshotTimer);
  sessionSnapshotTimer = setTimeout(() => {
    const snap = {
      savedAt: Date.now(),
      path: currentPath,
      title: pendingTitle,
      doc: editor.getDoc(),
      view: previewMode,
      unifiedChatHistory,
      model: prefs.model,
      dirty,
    };
    void window.api.sessionWrite(snap);
  }, 1500);
}

const origOnDocChange = onDocChange;
// Replace editor onChange wrapper to also snapshot
(editor as any).__hookedSnapshot = true;
function snapshottingDocChange(doc: string) {
  origOnDocChange(doc);
  scheduleSessionSnapshot();
}
// Re-wire — recreate the update listener via setDoc won't help; just install a periodic ticker
setInterval(() => {
  if (dirty) scheduleSessionSnapshot();
}, 5000);
void snapshottingDocChange; // referenced to satisfy linter

function showRestoreBanner(snap: any) {
  const root = document.createElement('div');
  root.className = 'restore-banner';
  const docPreview = (snap.doc as string).slice(0, 80).replace(/\n+/g, ' • ').trim();
  root.innerHTML = `
    <div class="restore-banner-text">
      <strong>${t('restore.title')}</strong>
      <span>${docPreview || '(empty)'} · ${new Date(snap.savedAt).toLocaleString()}</span>
    </div>
    <div class="restore-banner-actions">
      <button class="restore-yes">${t('restore.yes')}</button>
      <button class="restore-no">${t('restore.no')}</button>
    </div>
  `;
  document.body.appendChild(root);
  root.querySelector('.restore-yes')?.addEventListener('click', () => {
    suppressEditorChange = true;
    editor.setDoc(snap.doc ?? '');
    suppressEditorChange = false;
    if (!editingInPreview) preview.setDoc(snap.doc ?? '');
    if (snap.path) currentPath = snap.path;
    if (snap.title) pendingTitle = snap.title;
    if (snap.view) { previewMode = snap.view; applyPreviewMode(); }
    if (snap) {
      unifiedChatHistory = restoreUnifiedThread(snap);
      unifiedChat.restore(snap);
      if (unifiedChatHistory.length > 0) setUnifiedChatOpen(true);
    }
    setTitle();
    updateWordCount(snap.doc ?? '');
    statusEl.textContent = '복구됨 — 이전 세션이 로드되었습니다.';
    root.remove();
  });
  root.querySelector('.restore-no')?.addEventListener('click', () => {
    void window.api.sessionClear();
    root.remove();
  });
}

void (async () => {
  // Main returns this window's restore snapshot only on an unclean previous exit.
  const res = await window.api.sessionGet();
  const snap = res?.snapshot;
  if (snap && ((snap.doc?.length ?? 0) > 0 || (snap.unifiedChatHistory?.length ?? 0) > 0)) {
    setTimeout(() => showRestoreBanner(snap), 400);
  }
})();

void (async () => {
  const auth = await window.api.authStatus();
  paintAuthPill(auth);
  // First-run nudge: if not signed in and no prefs flag yet, show modal once.
  const NUDGE_KEY = 'notepad-ai:login-nudge-shown:v1';
  if (!auth.signedIn && !localStorage.getItem(NUDGE_KEY)) {
    localStorage.setItem(NUDGE_KEY, '1');
    setTimeout(() => openLoginModal({ onAfterLogin: (a) => paintAuthPill(a) }), 600);
  }
})();

// ---------------- App update check (unsigned → notify + manual download) -----------------
function showUpdateBanner(latestVersion: string, url: string) {
  if (document.querySelector('.update-banner')) return;
  const root = document.createElement('div');
  root.className = 'update-banner';
  const title = document.createElement('div');
  title.className = 'update-banner-text';
  const strong = document.createElement('strong');
  strong.textContent = t('update.title');
  const span = document.createElement('span');
  span.textContent = `v${latestVersion}`;
  title.append(strong, span);
  const actions = document.createElement('div');
  actions.className = 'update-banner-actions';
  const dl = document.createElement('button');
  dl.className = 'update-download';
  dl.textContent = t('update.download');
  dl.addEventListener('click', () => {
    void window.api.openExternal(url);
    root.remove();
  });
  const later = document.createElement('button');
  later.className = 'update-dismiss';
  later.textContent = t('update.dismiss');
  later.addEventListener('click', () => root.remove());
  actions.append(dl, later);
  root.append(title, actions);
  document.body.appendChild(root);
}

void (async () => {
  try {
    const info = await window.api.checkForUpdate();
    if (info?.updateAvailable) {
      setTimeout(() => showUpdateBanner(info.latestVersion, info.url), 1200);
    }
  } catch {
    /* offline / unavailable — silently skip */
  }
})();
