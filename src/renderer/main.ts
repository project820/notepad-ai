import { createEditor, type EditorHandle } from './editor';
import { createPreview, type PreviewHandle } from './preview';
import { createSelectionSync, clearPreviewHighlight } from './selection-sync';
import { collectPreviewBlocks } from './source-preview-map';
import { setLineSpacers, clearLineSpacers, computeBidirectionalAlignment, MAX_SPACER_PX, type LineAlignmentBlock, type PreviewSpacer } from './cm-line-alignment';
import { interpolateScroll, normalizeAnchors, type ScrollAnchor } from './scroll-sync';
import { createToolbar, paintAccountState, type Theme, type FontSize } from './toolbar';
import { t, getLocale, setLocale, onLocaleChange, type Locale } from './i18n';
import { installKeyboardNav } from './keyboard-nav';
import { loadPrefs, savePrefs, applyTheme, applyFontSize, resolvedDark } from './prefs';
import { wirePreviewTables } from './preview-table-edit';
import { applyToEditor, applyToPreview, type FormatAction } from './formatting';
import { htmlToMarkdown } from './html-to-md';
import { buildConvertedHtmlFrame } from './sanitize-html';
import { buildRestoreBanner } from './restore-banner';
import { classifyLinkHref } from './link-policy';
import { openLoginModal } from './login-modal';
import { mountUnifiedChat, type ChatMode, type ChatAttachment, type ChatTextAttachment } from './unified-chat';
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
import type { FileTreeEntry } from '../shared/file-types';
import type { AiProviderId, ModelRef, ProviderAuthStatus } from '../main/ai/types';
import { isAiProviderId } from '../main/ai/types';
import { modelContextWindowTokens } from '../main/ai/output-budget';
import { parseModelKey } from './model-key';
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
import { HTML_EXPORT_CONTENT_INSTRUCTIONS } from './html-export-content-prompt';
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
  openFolder: () => Promise<string | null>;
  listDir: (rootPath: string, dirPath: string) => Promise<{ ok: boolean; entries: FileTreeEntry[]; error?: string }>;
  openFileInCurrent: (filePath: string) => Promise<{ opened: boolean; focusedOwner?: boolean; ownerWindowId?: number; error?: string }>;
  openPath: (filePath: string) => Promise<{ ok: boolean; error?: string }>;
  authStatus: () => Promise<AuthSnapshot>;
  authLogin: () => Promise<void>;
  authCancelLogin: () => Promise<void>;
  authLogout: () => Promise<void>;
  onAuthLoginUpdate: (cb: (u: LoginUpdate) => void) => () => void;
  aiChat: (id: string, instructions: string, history: { role: 'user' | 'assistant'; text: string }[], userText: string, model?: string | { provider: AiProviderId; id: string }, surfaceMode?: 'write' | 'advise' | 'html' | 'block', images?: { mime: string; base64: string; bytes: number; name?: string }[]) => Promise<void>;
  aiCancel: (id: string) => Promise<void>;
  onAiChatEvent: (id: string, cb: (e: { kind: 'delta' | 'done' | 'error'; text?: string; message?: string; errorKind?: string }) => void) => () => void;
  aiModels: (force?: boolean) => Promise<ModelRef[]>;
  aiProvidersStatus: () => Promise<ProviderAuthStatus[]>;
  aiHasAnyAuth: () => Promise<boolean>;
  aiSetApiKey: (provider: AiProviderId, key: string) => Promise<{ persisted: boolean }>;
  aiDeleteProviderKey: (provider: AiProviderId) => Promise<void>;
  localAiGetConfig: () => Promise<{ ollama: string; lmstudio: string }>;
  localAiSetConfig: (partial: { ollama?: string; lmstudio?: string }) => Promise<{ ollama: string; lmstudio: string }>;
  getPromptAssemblyContext: () => Promise<{ enabled: boolean; systemlawContent: string; ownerContent: string }>;
  projectWizardStart: (projectFolder: string) => Promise<ProjectWizardStateResult>;
  projectWizardSaveApprovedDraft: (input: ProjectWizardSaveApprovedDraftInput) => Promise<ProjectWizardSaveApprovedDraftResult>;
  sessionGet: () => Promise<any>;
  sessionWrite: (snap: any) => Promise<void>;
  sessionClear: () => Promise<void>;
  checkForUpdate: () => Promise<{ updateAvailable: boolean; currentVersion: string; latestVersion: string; url: string } | null>;
  openExternal: (url: string) => Promise<void>;
  appVersion: () => Promise<string>;
  relaunchApp: () => Promise<void>;
  convertAttachment: (base64: string, ext: string) => Promise<{ ok: boolean; markdown?: string; error?: string }>;
  fetchDesignMd: (input: string) => Promise<{ ok: boolean; designMd?: string; rawUrl?: string; error?: string }>;
  listDesigns: () => Promise<{ ok: boolean; designs?: { slug: string; name: string; pageUrl: string }[]; error?: string }>;
  saveHtml: (args: { html: string; defaultName?: string }) => Promise<{ saved: boolean; filePath?: string }>;
  openSavedHtml: (filePath: string) => Promise<{ opened: boolean; error?: string }>;
  mdHandlerStatus: () => Promise<{ supported: boolean; registered?: boolean }>;
  registerMdHandler: () => Promise<{ ok: boolean; registered?: boolean; defaultSet?: boolean; error?: string }>;
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

// Coalesce preview re-renders into one per animation frame. Each keystroke used
// to synchronously re-parse the whole markdown and rebuild the preview DOM +
// source map; on a large document (or a fast paste burst) that janks typing.
// RAF-coalescing renders only the latest document state, at most one frame
// behind — word count and autosave stay synchronous (they're cheap).
const previewRenderThrottle = createRafThrottle();
function onDocChange(doc: string) {
  if (suppressEditorChange) return;
  if (!dirty) {
    dirty = true;
    setTitle();
  }
  // Avoid clobbering the preview while the user is typing there (re-checked in
  // the throttled callback in case focus moves into the preview within the frame).
  if (!editingInPreview) {
    previewRenderThrottle(() => {
      if (!editingInPreview) preview.setDoc(doc);
    });
  }
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
// Document-level fail-closed backstop (Phase 1 security gate). Forms never submit
// (no app feature posts a form; converted-doc forms are stripped by the sanitizer
// anyway). Anchor clicks outside the preview (which wirePreviewLinks owns) are
// classified: only normalized http/https open in the OS browser via IPC, every
// other scheme/relative/malformed href is denied. Capture phase so it runs before
// any native navigation.
document.addEventListener('submit', (e) => e.preventDefault(), true);
document.addEventListener(
  'click',
  (e) => {
    const anchor = (e.target as Element | null)?.closest?.('a');
    if (!anchor) return;
    if (preview.el.contains(anchor)) return; // handled by wirePreviewLinks
    const decision = classifyLinkHref(anchor.getAttribute('href'));
    if (decision.action === 'external') {
      e.preventDefault();
      void window.api.openExternal(decision.url);
    } else if (decision.action === 'deny') {
      e.preventDefault();
    }
  },
  true,
);

// ----- Left panel: tabs (Outline + footnotes / Files) (#7, v0.4) -----
const leftPanelHost = document.getElementById('left-panel') as HTMLDivElement;

/** Prompt to save the current doc if dirty before another file replaces it.
 *  Returns true to proceed with opening, false to abort (user cancelled, or the
 *  save was blocked because another window owns the path). */
async function saveIfDirtyBeforeReplace(): Promise<boolean> {
  if (!dirty) return true;
  if (!window.confirm(t('panel.files.savePrompt'))) return false;
  await save();
  // save() clears `dirty` on success; if it stayed dirty the save was blocked.
  return !dirty;
}

/** True when `p` is `r` itself or nested under it (workspace containment). */
function isWithinRoot(p: string, r: string): boolean {
  if (p === r) return true;
  return p.startsWith(r.endsWith('/') ? r : r + '/');
}

const leftPanel = mountLeftPanel(leftPanelHost, {
  getPreviewRoot: () => preview.el,
  onJump: (el) => el.scrollIntoView({ block: 'center' }),
  files: {
    getCurrentPath: () => currentPath,
    getWorkspaceRoot: () => prefs.workspaceRoot ?? null,
    onWorkspaceRootChange: (root) => {
      if (root) prefs.workspaceRoot = root;
      else delete prefs.workspaceRoot;
      savePrefs(prefs);
    },
    listDir: (rootPath, dirPath) => window.api.listDir(rootPath, dirPath),
    openFolder: () => window.api.openFolder(),
    openFileInCurrent: (filePath) => window.api.openFileInCurrent(filePath),
    openExternalPath: (filePath) => window.api.openPath(filePath),
    saveIfDirtyBeforeReplace,
  },
});

/** Keep the file-tree root aligned with the open document: adopt the file's
 *  parent folder as root unless the file already lives under the current root. */
function syncWorkspaceRootToCurrent(): void {
  if (!currentPath) return;
  const parent = folderFromFilePath(currentPath);
  if (!parent) return;
  const existing = prefs.workspaceRoot ?? null;
  const desired = existing && isWithinRoot(currentPath, existing) ? existing : parent;
  if (desired !== existing) {
    prefs.workspaceRoot = desired;
    savePrefs(prefs);
  }
  leftPanel.setWorkspaceRoot(desired);
}
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
const MAX_ALIGN_SPACERS = 400; // long-document guard: cap how many spacer widgets we APPLY
const MAX_MEASURE_BLOCKS = 3000; // generous guard so scroll anchors can map (nearly) the whole doc

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
 *  When computing NEW alignment spacers the caller clears both panes first so it
 *  reads natural (offset-free) positions; the scroll-sync anchor builder, by
 *  contrast, intentionally measures WITH the current spacers in place so its
 *  anchors reflect the true on-screen geometry. Both uses are valid. */
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
    if (out.length >= MAX_MEASURE_BLOCKS) break;
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
  // Apply at most MAX_ALIGN_SPACERS widgets to bound CM/DOM work on huge documents.
  // Spacers are cumulative from the top, so the applied prefix stays correctly
  // aligned; only blocks past the cap go unpadded (scroll-sync anchors still cover
  // the whole doc because measureLineAlignBlocks is uncapped up to MAX_MEASURE_BLOCKS).
  setLineSpacers(editor.view, editorSpacers.slice(0, MAX_ALIGN_SPACERS));
  setPreviewOffsets(preview.el, previewSpacers.slice(0, MAX_ALIGN_SPACERS));
}

const lineAlignThrottle = createRafThrottle();
function scheduleLineAlign(): void {
  lineAlignThrottle(applyLineAlign);
}

// A preview re-render rebuilds the map → spacers are stale; recompute. Other
// triggers (split entry, toggle, splitter drag, font/typography, resize) call
// scheduleLineAlign() directly.
preview.onAfterRender(() => {
  invalidateScrollAnchors();
  scheduleLineAlign();
});
window.addEventListener('resize', () => {
  invalidateScrollAnchors();
  scheduleLineAlign();
});

// ----- Scroll sync: piecewise-linear anchor interpolation -----
// One controller for both line-align ON and OFF. Anchors are each mapped block's
// content-space top in the two panes (measureLineAlignBlocks); we interpolate the
// destination position between the two anchors that bracket the source scroll.
// This is exact at every block boundary and window-size invariant — replacing the
// old dual mechanism (a 1:1 mirror fighting a whole-height ratio sync) that
// jittered and drifted as the window resized. Anchors rebuild lazily whenever
// either pane's scrollHeight changes (edits, font/typography, image loads, resize,
// alignment spacers), so the mapping self-heals without hunting every trigger.
let scrollAnchors: ScrollAnchor[] = [];
let anchorsDirty = true;
let lastEdScrollH = -1;
let lastPvScrollH = -1;
function invalidateScrollAnchors(): void {
  anchorsDirty = true;
}
function rebuildScrollAnchors(): void {
  anchorsDirty = false;
  scrollAnchors =
    previewMode === 'split'
      ? normalizeAnchors(
          measureLineAlignBlocks().map((b) => ({ ed: b.editorTop, pv: b.previewTop })),
        )
      : [];
}
// Echo suppression without a timing race: when we programmatically set a pane's
// scrollTop we remember that value; the `scroll` event it fires back is swallowed
// once (it matches the expected value), so the panes never ping-pong. A genuine
// user scroll never matches the stale expectation and clears it. This replaces a
// requestAnimationFrame-released lock that could clear before the echoed event
// arrived (the jitter the previous design exhibited).
let expectedEdTop = -1;
let expectedPvTop = -1;
function syncScroll(from: 'ed' | 'pv'): void {
  if (editingInPreview || previewMode !== 'split') return;
  const cm = editor.view.scrollDOM;
  const srcEl = from === 'ed' ? cm : preview.el;
  const expected = from === 'ed' ? expectedEdTop : expectedPvTop;
  if (expected >= 0 && Math.abs(srcEl.scrollTop - expected) <= 1) {
    // This is the echo of our own programmatic scroll — consume it and stop.
    if (from === 'ed') expectedEdTop = -1;
    else expectedPvTop = -1;
    return;
  }
  // Genuine user scroll on this pane — drop any stale expectation for it.
  if (from === 'ed') expectedEdTop = -1;
  else expectedPvTop = -1;

  const edMax = cm.scrollHeight - cm.clientHeight;
  const pvMax = preview.el.scrollHeight - preview.el.clientHeight;
  if (cm.scrollHeight !== lastEdScrollH || preview.el.scrollHeight !== lastPvScrollH) {
    anchorsDirty = true;
  }
  if (anchorsDirty) {
    rebuildScrollAnchors();
    lastEdScrollH = cm.scrollHeight;
    lastPvScrollH = preview.el.scrollHeight;
  }
  const srcMax = from === 'ed' ? edMax : pvMax;
  const dstMax = from === 'ed' ? pvMax : edMax;
  const target = interpolateScroll(scrollAnchors, srcEl.scrollTop, from, srcMax, dstMax);
  const clamped = Math.max(0, Math.min(dstMax, target));
  // Record the value we are about to set so its echoed scroll event is ignored.
  if (from === 'ed') {
    expectedPvTop = clamped;
    preview.el.scrollTop = clamped;
  } else {
    expectedEdTop = clamped;
    cm.scrollTop = clamped;
  }
}
editor.view.scrollDOM.addEventListener('scroll', () => syncScroll('ed'), { passive: true });
preview.el.addEventListener('scroll', () => syncScroll('pv'), { passive: true });

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
type RendererModel = { id: string; label?: string; provider?: string; contextWindow?: number };
let rendererModels: RendererModel[] | null = null;
let rendererModelsPromise: Promise<RendererModel[]> | null = null;
async function loadModelsCached(force = false): Promise<RendererModel[]> {
  if (force) {
    // Kick a background local-cache refresh in main and adopt the returned
    // snapshot. Non-blocking by design: the registry returns the current cache
    // snapshot immediately, so a slow/offline local server never freezes the UI.
    rendererModelsPromise = window.api.aiModels(true).then((m) => {
      rendererModels = m;
      return m;
    });
    return rendererModelsPromise;
  }
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
  getModel: () => prefs.selectedModel ?? prefs.model ?? 'gpt-5.4-mini',
  getLocale: () => getLocale(),
  getAuth: () => cachedAuth,
  loadModels: (force) => loadModelsCached(force),
  onModelChange: (key) => {
    const { provider, id } = parseModelKey(key);
    prefs.selectedModel = { provider, id };
    if (provider === 'chatgpt') prefs.model = id;
    savePrefs(prefs);
    statusEl.textContent = `Model · ${id}`;
  },
  onLocaleChange: (l) => {
    if (l === getLocale()) return;
    prefs.locale = l;
    savePrefs(prefs);
    void requestLocaleRestart(l);
  },
  onToggleSideChat: () => toggleUnifiedChat(),
  onToggleOutline: () => toggleLeftPanel(),
  onUndo: () => {
    if (activeSurface === 'preview' && editingInPreview) flushPreviewToSource();
    editor.undo();
    preview.setDoc(editor.getDoc());
  },
  onRedo: () => {
    if (activeSurface === 'preview' && editingInPreview) flushPreviewToSource();
    editor.redo();
    preview.setDoc(editor.getDoc());
  },
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
  getTypography: () => clampTypography(prefs.typography),
  onTypographyChange: (next) => {
    prefs.typography = clampTypography(next);
    savePrefs(prefs);
    applyTypography(prefs.typography);
    scheduleLineAlign();
  },
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

// (Scroll sync is handled by the unified anchor-interpolation controller above.)

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
  syncWorkspaceRootToCurrent();
  pendingTitle = null;
  let docMd = content;
  // Every open/new resets the HTML-view toggle so a converted doc never inherits
  // the previous document's rich-HTML view state.
  showingConvertedHtml = false;
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
  }
  editor.setDoc(docMd);
  if (showingConvertedHtml && convertedHtml) {
    // Converted HTML is sanitized into an inert fragment (never raw innerHTML).
    preview.el.replaceChildren(buildConvertedHtmlFrame(convertedHtml));
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
        preview.el.replaceChildren(buildConvertedHtmlFrame(convertedHtml));
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
  getBlockModel: () => prefs.blockSelectedModel ?? prefs.blockModel ?? 'gpt-5.4-mini',
  onBlockModelChange: (key) => {
    const { provider, id } = parseModelKey(key);
    prefs.blockSelectedModel = { provider, id };
    if (provider === 'chatgpt') prefs.blockModel = id;
    savePrefs(prefs);
  },
  loadModels: (force) => loadModelsCached(force),
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

/** Source-markdown char budget for HTML export, sized to the selected model's actual
 *  context window. ~3 chars/token, reserving ~40% of the window for the output +
 *  instructions + design so a big-context model (e.g. GPT-5.x at 1M) accepts far more
 *  source than a 128K one, and normal documents are never truncated. */
function htmlExportSourceCharBudget(model: string | { provider: string; id: string } | undefined): number {
  const provider = typeof model === 'object' && model ? model.provider : 'chatgpt';
  const id = typeof model === 'string' ? model : typeof model === 'object' && model ? model.id : 'gpt-5.4-mini';
  const ctxTokens = isAiProviderId(provider) ? modelContextWindowTokens(provider, id) : 400_000;
  return Math.floor(ctxTokens * 3 * 0.6);
}

function applyStyle(next: { difficulty: Quality; naturalness: Naturalness }) {
  prefs.style = next;
  prefs.quality = next.difficulty; // keep legacy difficulty in sync (Block AI etc.)
  savePrefs(prefs);
  statusEl.textContent = `Style · ${next.difficulty} · ${next.naturalness}`;
}

function openSettings() {
  openSettingsModal({
    onAfterAuthChange: () => {
      rendererModels = null;
      rendererModelsPromise = null;
      void loadModelsCached(true);
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
  });
}

async function sendUnified(
  text: string,
  mode: ChatMode,
  attachments?: ChatAttachment[],
  textFiles?: ChatTextAttachment[],
) {
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
  // Fold attached text/document files into the message SENT to the AI, but keep
  // the visible bubble + persisted history clean (chip labels only, no blob).
  const fileContext = (textFiles ?? [])
    .map((f) => `[Attached file: ${f.name}]\n"""\n${f.text}\n"""`)
    .join('\n\n');
  const aiText = fileContext ? `${text ? text + '\n\n' : ''}${fileContext}` : text;
  const attachLabels = [
    ...(attachments?.length ? [`${attachments.length} image(s)`] : []),
    ...(textFiles ?? []).map((f) => f.name),
  ];
  const userDisplay = text || (attachLabels.length ? `📎 ${attachLabels.join(', ')}` : '');
  unifiedChat.addMessage('user', userDisplay);
  // Image bytes / file blobs are never persisted in session history (text only).
  unifiedChatHistory.push({ type: 'message', role: 'user', text: userDisplay });

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
    documentText: (mode === 'advise' && adviceSnapshot ? adviceSnapshot : editor.getDoc()).slice(0, 12000),
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
    await window.api.aiChat(id, instructions, priorTurns, aiText, currentModelArg(), mode === 'write' ? 'write' : 'advise', attachments);
  } catch (err: any) {
    stream.fail(err?.message ?? String(err));
    cleanup();
    ucInflight = null;
  }
}

let adviceSnapshot = '';
/** Capture the live document for Advise context and refresh the sync badge. */
function syncAdviceSnapshot() {
  adviceSnapshot = editor.getDoc();
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  unifiedChat.setAdviceSync(`${t('uc.advise.synced')} · ${time}`);
}

const unifiedChat = mountUnifiedChat(unifiedChatHost, {
  onSend: (text, mode, attachments, textFiles) => {
    if (mode === 'project' || mode === 'html') return; // driven by their own tabs
    void sendUnified(text, mode, attachments, textFiles);
  },
  convertFile: (base64, ext) => window.api.convertAttachment(base64, ext),
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
  onModeChange: (mode) => {
    if (mode === 'advise') syncAdviceSnapshot();
  },
  onAdviceResync: () => syncAdviceSnapshot(),
  style: { get: () => currentStyle(), onChange: (s) => applyStyle(s) },
});

let htmlExportWizard: HtmlExportWizardHandle | null = null;


/** Run one HTML generation over the streaming aiChat IPC, resolving with the full
 *  reply. `model` overrides the main model selection (HTML-only model picker). */
function runHtmlGeneration(
  prompt: string,
  model?: { provider: AiProviderId; id: string },
): { result: Promise<string>; cancel: () => void } {
  const modelArg = model ?? currentModelArg();
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
      window.api.aiChat(id, HTML_EXPORT_CONTENT_INSTRUCTIONS, [], prompt, modelArg).catch((err) => {
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
  unifiedChat.showPanel('<div class="he-host"></div>', undefined, () => {
    htmlExportWizard?.destroy();
    htmlExportWizard = null;
  });
  const host = unifiedChatHost.querySelector<HTMLElement>('.he-host');
  if (!host) return;
  htmlExportWizard?.destroy();
  htmlExportWizard = mountHtmlExportWizard(host, {
    getMarkdown: () => editor.getDoc(),
    maxSourceCharsForModel: (m) => htmlExportSourceCharBudget(m ?? currentModelArg()),
    listHtmlModels: async () => {
      const ms = await loadModelsCached(true);
      return ms.map((m) => {
        const provider = m.provider ?? 'chatgpt';
        return {
          provider,
          id: m.id,
          label: m.label,
          contextWindow: isAiProviderId(provider) ? modelContextWindowTokens(provider, m.id, m.contextWindow) : undefined,
        };
      });
    },
    getDefaultModel: () => prefs.htmlModel ?? currentModelArg(),
    onModelChosen: (m) => {
      if (isAiProviderId(m.provider)) {
        prefs.htmlModel = { provider: m.provider, id: m.id };
        savePrefs(prefs);
      }
    },
    getCurrentPath: () => currentPath,
    getPendingTitle: () => pendingTitle,
    fetchDesignMd: (input) => window.api.fetchDesignMd(input),
    listDesigns: () => window.api.listDesigns(),
    saveHtml: (args) => window.api.saveHtml(args),
    openSavedHtml: (filePath) => window.api.openSavedHtml(filePath),
    aiGenerate: (prompt, model) =>
      runHtmlGeneration(prompt, model && isAiProviderId(model.provider) ? { provider: model.provider, id: model.id } : undefined),
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
    // AC5: project tab always reacts — show an in-panel notice instead of a
    // silent statusbar-only message when there is no saved project file.
    setUnifiedChatOpen(true);
    unifiedChat.showPanel(`<div class="uc-notice">${t('uc.project.noFile')}</div>`);
    statusEl.textContent = t('uc.project.noFile');
    return;
  }
  try {
    await window.api.projectWizardStart(folder);
    setUnifiedChatOpen(true);
    showProjectWizardConsent(folder);
    statusEl.textContent = t('pw.status.started');
  } catch (error) {
    console.error('Project Wizard failed', error);
    statusEl.textContent = t('pw.status.failed');
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
      statusEl.textContent = t('pw.status.savedLater');
      return;
    }
    if (action === 'never') {
      statusEl.textContent = t('pw.status.disabled');
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
      statusEl.textContent = t('pw.status.draftSaved');
      return;
    }
    if (action !== 'manual-next') return;

    const answer = (panel.querySelector('[data-pw-field="manual-answer"]') as HTMLTextAreaElement | null)?.value.trim() ?? '';
    if (!answer) {
      statusEl.textContent = t('pw.status.answerRequired');
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
      statusEl.textContent = t('pw.status.draftSaved');
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
        statusEl.textContent = t('pw.status.saved').replace('{status}', result.status.replace('_', ' '));
      })
      .catch((error) => {
        console.error('Project Wizard save failed', error);
        statusEl.textContent = t('pw.status.saveFailed');
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
function buildSessionSnapshot() {
  return {
    savedAt: Date.now(),
    path: currentPath,
    title: pendingTitle,
    doc: editor.getDoc(),
    view: previewMode,
    unifiedChatHistory,
    model: prefs.model,
    dirty,
  };
}
function scheduleSessionSnapshot() {
  if (sessionSnapshotTimer) clearTimeout(sessionSnapshotTimer);
  sessionSnapshotTimer = setTimeout(() => {
    void window.api.sessionWrite(buildSessionSnapshot());
  }, 1500);
}
/** Cancel any pending debounce and write the snapshot immediately (await before app relaunch). */
async function flushSessionSnapshot() {
  if (sessionSnapshotTimer) {
    clearTimeout(sessionSnapshotTimer);
    sessionSnapshotTimer = null;
  }
  await window.api.sessionWrite(buildSessionSnapshot());
}

/**
 * Apply a language change. The UI is icon-driven and many surfaces only relabel
 * on a full rebuild, so we restart the app to guarantee every surface renders in
 * the chosen language. We switch the live locale first (so the confirm prompt
 * shows in the newly-selected language), then offer a restart. On confirm we
 * flush the session snapshot before relaunching so open/unsaved docs survive.
 */
async function requestLocaleRestart(l: Locale) {
  setLocale(l);
  if (!window.confirm(t('lang.restartPrompt'))) return;
  await flushSessionSnapshot();
  await window.api.relaunchApp();
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
  // Built with createElement + textContent (never innerHTML): the persisted doc
  // preview is attacker-influenceable and must never become active DOM.
  const root = buildRestoreBanner(
    { doc: snap.doc, savedAt: snap.savedAt },
    { title: t('restore.title'), yes: t('restore.yes'), no: t('restore.no') },
  );
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
