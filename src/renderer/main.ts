import { createEditor } from './editor';
import { createPreview } from './preview';
import { paintAccountState } from './toolbar';
import { t, getLocale, setLocale, onLocaleChange, type Locale } from './i18n';
import { installKeyboardNav } from './keyboard-nav';
import { loadPrefs, savePrefs, applyTheme, applyFontSize, resolvedDark } from './prefs';
import { relabelPreviewTableToolbars, wirePreviewTables } from './preview-table-edit';
import { htmlToMarkdown } from './html-to-md';
import { buildConvertedHtmlFrame } from './sanitize-html';
import { openLoginModal } from './login-modal';
import { applyTypography } from './typography';
import { wirePreviewLinks, installDocumentLinkBackstop } from './preview-links';
import type { AuthSnapshot } from '../shared/auth-protocol';
import { parseModelKey } from './model-key';
import { installBlockAi } from './block-ai';
import { installTooltips } from './tooltips';
import { wireWordmark } from './header-wordmark';
import { installSelectionFormatMenu } from './selection-format-menu';
import type {} from './api-types';
import { createRafThrottle } from './raf-throttle';
import { initPaneSync } from './pane-sync';
import { createAppContext, type PreviewMode } from './app-context';
import { initDocLifecycle } from './doc-lifecycle';
import { createHtmlViewToggle, initPreviewEditing } from './preview-editing';
import { initModelCache } from './model-cache';
import { initToolbarWiring } from './toolbar-wiring';
import { initLayoutChrome, initSplitDrag } from './layout-chrome';
import { initUnifiedChatWiring, type UnifiedChatWiring } from './unified-chat-wiring';
import { folderFromFilePath, initProjectWizardFlow } from './project-wizard-flow';
import { initSessionSnapshot } from './session-snapshot';
import { initUpdateBanner } from './update-banner';

const workspace = document.querySelector('.workspace') as HTMLElement;
const editorHost = document.getElementById('editor-host') as HTMLDivElement;
const previewHost = document.getElementById('preview-host') as HTMLDivElement;
const toolbarHost = document.getElementById('toolbar') as HTMLDivElement;
const titleEl = document.getElementById('title') as HTMLInputElement;
const dirtyEl = document.getElementById('dirty') as HTMLDivElement;
const statusEl = document.getElementById('status') as HTMLSpanElement;
const wordCountEl = document.getElementById('word-count') as HTMLSpanElement;
const splitterEl = document.querySelector('.splitter') as HTMLElement;
const ctx = createAppContext(statusEl);
const prefs = loadPrefs();

// CRITICAL: locale must be set BEFORE any UI is rendered, otherwise the
// first preview.setDoc / createToolbar / mountSideChat will use the default
// 'en' dictionary and the user sees a flash of English before switching.
setLocale((prefs.locale as Locale) ?? 'en');
applyTheme(prefs.theme);
applyFontSize(prefs.fontSize);

applyTypography(prefs.typography ?? { letterSpacing: 0, charScaleX: 1, lineHeight: 1 });

if (prefs.splitRatio != null) {
  workspace.style.setProperty('--split-left', `${prefs.splitRatio}fr`);
  workspace.style.setProperty('--split-right', `${1 - prefs.splitRatio}fr`);
}

function updateWordCount(doc: string) {
  const chars = doc.length;
  const words = doc.trim() === '' ? 0 : doc.trim().split(/\s+/).length;
  wordCountEl.textContent = `${words.toLocaleString()} words · ${chars.toLocaleString()} chars`;
}

let layoutChrome: {
  syncWorkspaceRootToCurrent: () => void;
  toggleLeftPanel: () => void;
  setWorkspaceRoot: (path: string | null) => void;
};
let sessionSnapshot: ReturnType<typeof initSessionSnapshot>;
let unifiedChatWiring: UnifiedChatWiring;
let updateHtmlViewToggle = () => {};

function syncWorkspaceRootToCurrent(): void {
  layoutChrome.syncWorkspaceRootToCurrent();
}
function scheduleSessionSnapshot() {
  sessionSnapshot.scheduleSessionSnapshot();
}
async function requestLocaleRestart(locale: Locale) {
  await sessionSnapshot.requestLocaleRestart(locale);
}
function toggleUnifiedChat() {
  unifiedChatWiring.toggleUnifiedChat();
}
function openSettings() {
  unifiedChatWiring.openSettings();
}
function paintAuthPill(auth: AuthSnapshot) {
  unifiedChatWiring.paintAuthPill(auth);
}

const docLifecycle = initDocLifecycle(ctx, {
  api: window.api,
  titleEl,
  dirtyEl,
  t,
  htmlToMarkdown,
  buildConvertedHtmlFrame,
  updateWordCount,
  scheduleSessionSnapshot,
  syncWorkspaceRootToCurrent,
  updateHtmlViewToggle: () => updateHtmlViewToggle(),
  createRafThrottle,
});

function applyPreviewMode() {
  workspace.classList.remove('mode-split', 'mode-editor-only', 'mode-preview-only');
  workspace.classList.add(`mode-${ctx.previewMode}`);
}

function cyclePreviewMode() {
  ctx.previewMode =
    ctx.previewMode === 'split' ? 'preview-only' : ctx.previewMode === 'preview-only' ? 'editor-only' : 'split';
  applyPreviewMode();
  const labels: Record<PreviewMode, string> = {
    split: t('status.view.split'),
    'preview-only': t('status.view.preview'),
    'editor-only': t('status.view.raw'),
  };
  ctx.setStatus(t('status.view').replace('{mode}', labels[ctx.previewMode]));
  if (ctx.previewMode === 'preview-only') ctx.activeSurface = 'preview';
  if (ctx.previewMode === 'editor-only') ctx.activeSurface = 'editor';
  if (ctx.previewMode !== 'split') selectionSync.clearAll();
  scheduleLineAlign();
}

const initialDoc = '';
const editor = createEditor(editorHost, { initialDoc, onChange: docLifecycle.onDocChange });
const preview = createPreview(previewHost);
ctx.setHandles(editor, preview);
ctx.preview.onAfterRender(() => {
  wirePreviewTables(ctx.preview.el, () => ctx.editor.getDoc(), (newDoc) => {
    ctx.suppressEditorChange = true;
    ctx.editor.setDoc(newDoc);
    ctx.suppressEditorChange = false;
    docLifecycle.onSuppressedEditorChange(newDoc, true);
  });
});
wirePreviewLinks(ctx.preview.el, {
  openExternal: (url) => void window.api.openExternal(url),
  backLabel: t('footnote.back'),
  scroller: previewHost,
});

installDocumentLinkBackstop(ctx.preview.el, (url) => void window.api.openExternal(url));

const leftPanelHost = document.getElementById('left-panel') as HTMLDivElement;
layoutChrome = initLayoutChrome(ctx, {
  workspace,
  leftPanelHost,
  prefs,
  savePrefs,
  folderFromFilePath,
  saveIfDirtyBeforeReplace: docLifecycle.saveIfDirtyBeforeReplace,
});
const { toggleLeftPanel } = layoutChrome;
ctx.preview.setDoc(initialDoc);
ctx.preview.setLineNumbers(prefs.previewLineNumbers ?? false);
updateWordCount(initialDoc);
applyPreviewMode();
ctx.editor.applyTheme(resolvedDark(prefs.theme));

const { selectionSync, scheduleLineAlign } = initPaneSync(ctx, { prefs, editorHost, createRafThrottle });
const { flushPreviewToSource, syncPreviewToSource } = initPreviewEditing(ctx, {
  htmlToMarkdown,
  t,
  onSuppressedEditorChange: docLifecycle.onSuppressedEditorChange,
});
updateHtmlViewToggle = createHtmlViewToggle(ctx, { selectionSync, scheduleLineAlign });

editorHost.addEventListener('focusin', () => {
  ctx.activeSurface = 'editor';
  ctx.setStatus(t('status.editingRaw'));
});

let cachedAuth: AuthSnapshot = { signedIn: false };
const { loadModelsCached, invalidateModels } = initModelCache(window.api);
const { dispatchFormat } = initToolbarWiring(ctx, {
  toolbarHost,
  prefs,
  t,
  getLocale,
  loadModelsCached,
  getAuth: () => cachedAuth,
  setAuth: (auth) => { cachedAuth = auth; },
  paintAuthPill,
  requestLocaleRestart,
  toggleUnifiedChat,
  toggleLeftPanel,
  openSettings,
  applyTypography,
  scheduleLineAlign,
  cyclePreviewMode,
  flushPreviewToSource,
  syncPreviewToSource,
});

docLifecycle.wireTitle();
initSplitDrag({ workspace, splitterEl, prefs, savePrefs, scheduleLineAlign });
docLifecycle.wireFileOpened();


docLifecycle.wireMenuActions(cyclePreviewMode);
window.api.onCloseQueryState((requestId) => {
  window.api.sendCloseState(requestId, {
    dirty: ctx.dirty,
    hasPath: ctx.currentPath !== null,
    docEmpty: ctx.editor.getDoc().length === 0,
    locale: getLocale(),
  });
});
window.api.onCloseSave((requestId) => {
  void (async () => {
    await docLifecycle.save();
    if (!ctx.dirty && sessionSnapshot) await sessionSnapshot.flushSessionSnapshot();
    window.api.sendCloseSaveResult(requestId, !ctx.dirty);
  })().catch(() => {
    window.api.sendCloseSaveResult(requestId, false);
  });
});
window.api.windowReady();
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 't' && !e.shiftKey) {
    e.preventDefault();
    (document.getElementById('tb-insert-table') as HTMLButtonElement | null)?.click();
  }
  if ((e.metaKey || e.ctrlKey) && (e.key === 'j' || e.key === 'J' || e.key === ';')) {
    e.preventDefault();
    toggleUnifiedChat();
  }
  if (e.key === 'Escape') unifiedChatWiring.cancelInflight();
});

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  if (prefs.theme === 'system') ctx.editor.applyTheme(e.matches);
});
window.addEventListener('beforeunload', () => {
  if (ctx.dirty) void docLifecycle.save();
  scheduleSessionSnapshot();
});

docLifecycle.setTitle();
ctx.editor.focus();
installKeyboardNav();
installTooltips();

const wordmarkEl = document.getElementById('wordmark');
if (wordmarkEl) {
  const wordmark = wireWordmark(wordmarkEl, {
    openExternal: (url) => void window.api.openExternal(url),
    getVersion: () => window.api.appVersion(),
  });
  onLocaleChange(() => wordmark.relabel());
}

installBlockAi({
  view: ctx.editor.view,
  previewEl: ctx.preview.el,
  getModel: () => prefs.model,
  getBlockModel: () => prefs.blockSelectedModel ?? prefs.blockModel ?? 'gpt-5.4-mini',
  onBlockModelChange: (key) => {
    const { provider, id } = parseModelKey(key);
    prefs.blockSelectedModel = { provider, id };
    if (provider === 'chatgpt') prefs.blockModel = id;
    savePrefs(prefs);
  },
  loadModels: (force) => loadModelsCached(force),
  getQuality: () => unifiedChatWiring.currentStyle().difficulty,
  getNaturalness: () => unifiedChatWiring.currentStyle().naturalness,
  openAiSettings: openSettings,
});

installSelectionFormatMenu({
  editorEl: editorHost,
  previewEl: ctx.preview.el,
  hasEditorSelection: () => !ctx.editor.view.state.selection.main.empty,
  dispatchFormat: (action, surface) => {
    ctx.activeSurface = surface;
    dispatchFormat(action);
  },
});


onLocaleChange(() => {
  ctx.preview.el.querySelectorAll('table[data-wired="1"]').forEach((table) => table.removeAttribute('data-wired'));
  ctx.preview.setDoc(ctx.editor.getDoc());
  relabelPreviewTableToolbars(ctx.preview.el);
});

let projectWizard: ReturnType<typeof initProjectWizardFlow>;
unifiedChatWiring = initUnifiedChatWiring(ctx, {
  prefs,
  loadModelsCached,
  invalidateModels,
  getAuth: () => cachedAuth,
  setAuth: (auth) => { cachedAuth = auth; },
  paintAccountState,
  scheduleSessionSnapshot,
  onSuppressedEditorChange: docLifecycle.onSuppressedEditorChange,
  onProjectSetup: (guard) => void projectWizard.startProjectWizard(guard),
});
projectWizard = initProjectWizardFlow(ctx, {
  prefs,
  t,
  unifiedChat: unifiedChatWiring.unifiedChat,
  setUnifiedChatOpen: unifiedChatWiring.setUnifiedChatOpen,
  setWorkspaceRoot: layoutChrome.setWorkspaceRoot,
});

sessionSnapshot = initSessionSnapshot(ctx, {
  prefs,
  unifiedChat: unifiedChatWiring.unifiedChat,
  getUnifiedChatHistory: unifiedChatWiring.getHistory,
  setUnifiedChatHistory: unifiedChatWiring.setHistory,
  setUnifiedChatOpen: unifiedChatWiring.setUnifiedChatOpen,
  applyPreviewMode,
  setTitle: docLifecycle.setTitle,
  updateWordCount,
});

void (async () => {
  const auth = await window.api.authStatus();
  paintAuthPill(auth);
  const NUDGE_KEY = 'notepad-ai:login-nudge-shown:v1';
  if (!auth.signedIn && !localStorage.getItem(NUDGE_KEY)) {
    localStorage.setItem(NUDGE_KEY, '1');
    setTimeout(() => openLoginModal({ onAfterLogin: paintAuthPill }), 600);
  }
})();

initUpdateBanner();
