import { app, BrowserWindow, Menu, dialog, shell } from 'electron';
import { existsSync, promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import https from 'node:https';
import { startLogin, cancelLogin, getStatus, logout, type LoginUpdate } from './codex-auth';
import type { ChatTurn } from './codex-client';
import { getRegistry } from './ai/provider-registry';
import { prewarmCliSpawnPath } from './ai/cli-runner';
import { htmlExportMaxTokens, isHtmlExportInstructions } from './ai/output-budget';
import { isAiProviderId, validateImageAttachments, validateChatTextPayload, type AiProviderId } from './ai/types';
import { resolveOcrAssetPaths, configureOcr } from './ai/ocr';
import {
  MAX_CONVERT_BYTES,
  checkBase64SizePrecap,
  checkMagicBytes,
  withWallClockTimeout,
} from './converter-bounds';
import { isTrustedAppUrl, SECURITY_REASON } from './security';
import { handleTrusted, onTrusted } from './ipc-guard';
import { FileGrants } from './file-grants';
import { KeyedMutex } from './keyed-mutex';
import { canonicalNewTarget, isRealpathWithinRoot, type IdentityFs } from './path-identity';
import { ConverterHost, type WorkerTransport } from './converter-host';
import {
  getSessionAggregate,
  mutateSessionAggregate,
  markCleanExitQueued,
  resetSessionAggregate,
} from './session-store';

import {
  upsertWindowSnapshot,
  removeWindowSnapshot,
  type SessionWindowSnapshot,
} from './session-schema';
import {
  createWindowRegistry,
  flushPendingOutbound,
  sendWhenReady,
  type OutboundSink,
  type WindowRecord,
} from './window-registry';
import {
  createContextStackLoader,
  createWizardService,
  isProjectWizardSaveApprovedDraftInput,
  isSafeAbsoluteProjectFolderPath,
} from './project-wizard/service';
import { nowInSeoulIso } from './project-wizard/time';
import {
  isAllowedExternalUrl,
  isAllowedDesignFetchUrl,
  isAllowedDesignListFetchUrl,
  designListContentsUrl,
  parseDesignListFromContents,
  isOpenableSavedPath,
  normalizeDesignMdUrl,
} from './safe-external';
import { checkForUpdate } from './update-check';
import { mdHandlerStatus, buildLsRegisterTarget, bundlePathFromExecPath, buildApplyDefaultHandlerCommand } from './md-handler';
import { OPENABLE_DOCUMENT_EXTS, CONVERTIBLE_EXTS as CONVERTIBLE_EXT_LIST } from '../shared/file-types';
import {
  listDirectory,
  openFileInCurrentWindow,
  isSafeLocalAbsolutePath,
  type FileTreeEntry,
} from './file-tree';

const APP_DISPLAY_NAME = 'Notepad AI';
const APP_STORAGE_NAME = 'notepad-ai';
const isDev = process.env.NODE_ENV === 'development';

/** Wall-clock deadline for a single kordoc document conversion (Phase 0 bound). */
const CONVERT_TIMEOUT_MS = 30_000;

// ---------- Single-instance lock (consolidate to ONE app) ----------
// Without this, launching a second copy — the installed .app plus a dev/`electron .`
// instance, or a double launch — spawns an independent process, so macOS shows two
// Notepad AI apps in the Dock. The first instance keeps the lock; any later launch
// forwards its file argument to the running app and quits, so only ONE ever runs.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    // Windows/Linux pass document paths as CLI args (macOS uses `open-file`).
    const fileArg = argv.slice(1).find((a) => typeof a === 'string' && !a.startsWith('-') && existsSync(a));
    if (fileArg && appIsReady) {
      void openFileInWindow(fileArg, { reuseBlank: true });
    } else {
      focusExistingWindow();
    }
  });
}

// ---------- Multi-window runtime (G002) ----------
// `main` owns the registry of live windows, IPC routing, file-path ownership,
// and the session aggregate; each window's renderer owns its own document state.
const registry = createWindowRegistry();
/** Per-window filesystem capability grants (renderer paths are not authority). */
const fileGrants = new FileGrants();
/** Serializes save reserve→write→commit per canonical file identity (TOCTOU guard). */
const saveMutex = new KeyedMutex();
/** node:fs-backed identity surface for realpath/dev:ino canonicalization. */
const nodeIdentityFs: IdentityFs = {
  realpath: (p) => fs.realpath(p),
  stat: async (p) => {
    const s = await fs.stat(p);
    return { dev: s.dev, ino: s.ino };
  },
};

/** Run kordoc conversion in an isolated utilityProcess (Phase 3 fault isolation). */
const converterHost = new ConverterHost((): WorkerTransport => {
  const { utilityProcess } = require('electron') as typeof import('electron');
  const child = utilityProcess.fork(path.join(__dirname, 'converter-worker.js'));
  return {
    post: (msg) => child.postMessage(msg),
    onMessage: (cb) => child.on('message', (m) => cb(m)),
    onExit: (cb) => child.on('exit', () => cb()),
    kill: () => {
      child.kill();
    },
  };
}, { timeoutMs: CONVERT_TIMEOUT_MS });

/**
 * Convert a document to markdown/html. Primary path is the isolated worker; if the
 * worker is unavailable/crashes/times out, fall back to a bounded in-main parse so
 * the feature never hard-breaks. Callers apply the Phase 0 size/precap first.
 */
async function convertDocument(
  ext: string,
  buf: Buffer,
): Promise<{ ok: boolean; markdown?: string; html?: string; error?: string }> {
  try {
    const r = await converterHost.runConvert(ext, buf);
    return r.ok ? { ok: true, markdown: r.markdown, html: r.html } : { ok: false, error: r.error };
  } catch (workerErr) {
    console.warn('[converter] isolated worker failed; falling back to in-main parse:', workerErr);
    try {
      const nativeImport: (s: string) => Promise<any> = new Function('s', 'return import(s)') as any;
      const kordoc = await nativeImport('kordoc');
      const parseFn = kordoc.parse ?? kordoc.default?.parse;
      const renderHtml = kordoc.renderHtml ?? kordoc.default?.renderHtml;
      if (typeof parseFn !== 'function') return { ok: false, error: 'Document converter unavailable.' };
      const r = await withWallClockTimeout<any>(() => parseFn(buf, { removeHeaderFooter: true }), CONVERT_TIMEOUT_MS);
      if (r?.success && typeof r.markdown === 'string') {
        let html: string | undefined;
        if (typeof renderHtml === 'function') {
          try {
            html = renderHtml(r.markdown, { preset: 'gov-formal' });
          } catch {
            /* raw markdown fallback */
          }
        }
        return { ok: true, markdown: r.markdown, html };
      }
      const msg = ('error' in (r ?? {}) && (r as any).error?.message) || 'unknown error';
      return { ok: false, error: `Could not convert ${ext.toUpperCase()}: ${msg}` };
    } catch (e: any) {
      return { ok: false, error: `Failed to convert ${ext.toUpperCase()}: ${e?.message ?? e}` };
    }
  }
}
let appIsReady = false;
/** The blank window created on a normal launch; the first macOS open-file may reuse it. */
let launchWindowId: number | null = null;

/** Resolve a live `BrowserWindow` from a registry record (null when gone/destroyed). */
function windowFromRecord(rec: WindowRecord | null): BrowserWindow | null {
  if (!rec) return null;
  const win = BrowserWindow.fromId(rec.windowId);
  return win && !win.isDestroyed() ? win : null;
}

/** Build a sink that delivers main→renderer messages to a specific live window. */
function sinkFor(win: BrowserWindow): OutboundSink {
  return (channel, payload) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  };
}

/** The focused / last-focused live window's webContents, for menu-driven actions. */
function focusedWebContents(): Electron.WebContents | null {
  const win = windowFromRecord(registry.focusedOrLast());
  return win ? win.webContents : null;
}

/** Route a menu action to the focused / last-focused live window. */
function sendToFocused(channel: string): void {
  focusedWebContents()?.send(channel);
}

/** Generate a fresh, stable per-window session key for brand-new windows. */
function nextWindowKey(): string {
  return `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function resolveAppIconPath(): string | undefined {
  const iconPath = path.resolve(__dirname, '../../build/icon.png');
  return existsSync(iconPath) ? iconPath : undefined;
}

function configureAppIdentity() {
  app.setPath('userData', path.join(app.getPath('appData'), APP_STORAGE_NAME));
  app.setName(APP_DISPLAY_NAME);
  app.setAboutPanelOptions({
    applicationName: APP_DISPLAY_NAME,
    applicationVersion: app.getVersion(),
  });
}

configureAppIdentity();

// ---------- macOS "Open With" / double-click handoff (⑥ os-integration, AC9) ----------
// `open-file` can fire BEFORE `whenReady` when the app is launched by opening a
// document in Finder, so the listener is registered at module load. Paths that
// arrive before the window exists are queued and flushed after createWindow().
const pendingOpenFiles: string[] = [];

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (!appIsReady) {
    pendingOpenFiles.push(filePath);
    return;
  }
  void openFileInWindow(filePath, { reuseBlank: true });
});

function flushPendingOpenFiles() {
  for (const filePath of pendingOpenFiles.splice(0)) {
    void openFileInWindow(filePath, { reuseBlank: true });
  }
}

/** Bring an existing window to the front (used when a second launch is rejected). */
function focusExistingWindow(): void {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
}

/** A blank launch window the first OS open-file may reuse (avoids an extra empty window). */
function findReusableBlankWindow(): BrowserWindow | null {
  if (launchWindowId == null) return null;
  const rec = registry.get(launchWindowId);
  if (!rec || rec.currentPath != null) return null;
  // Never reuse a window that holds unsaved content (would silently overwrite it).
  const snap = rec.lastSnapshot;
  if (snap && (snap.dirty || (snap.doc?.length ?? 0) > 0)) return null;
  return windowFromRecord(rec);
}

/**
 * Open `filePath` honoring duplicate-path ownership. If another window already
 * owns the file, focus it instead of opening a second writer; otherwise reuse a
 * blank launch window when allowed, else create a new window for the file.
 */
async function openFileInWindow(filePath: string, opts: { reuseBlank: boolean }): Promise<void> {
  const owner = registry.ownerOfPath(filePath);
  if (owner) {
    windowFromRecord(owner)?.focus();
    console.log(`[file] duplicate-path open focus owner=${owner.windowId} path=${filePath}`);
    return;
  }
  if (opts.reuseBlank) {
    const blank = findReusableBlankWindow();
    if (blank) {
      launchWindowId = null;
      await openFilePath(filePath, blank);
      return;
    }
  }
  await createWindow({ openFilePath: filePath });
}

/**
 * Deny any attempt to navigate a window's main frame or a subframe away from the
 * app's own origin (S-crit: a navigated renderer would expose the full preload
 * `window.api` to a remote page). External links are opened in the OS browser via
 * the explicit `setWindowOpenHandler` / `shell:open-external` path, never by
 * replacing the app document.
 */
function installNavigationGuards(win: BrowserWindow): void {
  const wc = win.webContents;
  const denyIfUntrusted = (event: Electron.Event, url: string) => {
    if (!isTrustedAppUrl(url, { isDev })) {
      event.preventDefault();
      console.warn(`[nav-guard] ${SECURITY_REASON.NAV_UNTRUSTED_ORIGIN} win=${win.id} blocked`);
    }
  };
  wc.on('will-navigate', denyIfUntrusted);
  wc.on('will-redirect', denyIfUntrusted);
  // Subframe navigations (iframes injected via converted HTML, etc.).
  wc.on('will-frame-navigate', (event) => {
    if (!isTrustedAppUrl(event.url, { isDev })) {
      event.preventDefault();
      console.warn(`[nav-guard] ${SECURITY_REASON.NAV_UNTRUSTED_ORIGIN} win=${win.id} subframe blocked`);
    }
  });
}

async function createWindow(
  opts: { restore?: SessionWindowSnapshot; openFilePath?: string } = {},
): Promise<BrowserWindow> {
  const { restore, openFilePath: filePathToOpen } = opts;
  const windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: 1280,
    height: 820,
    minWidth: 920,
    minHeight: 560,
    title: APP_DISPLAY_NAME,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };

  const iconPath = resolveAppIconPath();
  if (iconPath) windowOptions.icon = iconPath;

  const win = new BrowserWindow(windowOptions);

  const record: WindowRecord = {
    windowId: win.id,
    webContentsId: win.webContents.id,
    windowKey: restore?.id ?? nextWindowKey(),
    currentPath: restore?.path ?? null,
    lastFocusedAt: Date.now(),
    ready: false,
    pendingOutbound: [],
    restoreSnapshot: restore,
  };
  registry.register(record);
  if (restore?.path) {
    registry.claimPath(win.id, restore.path);
    // A restored path was a previously user-opened file → re-grant it so Save works.
    fileGrants.grantFile(win.webContents.id, restore.path);
  }

  win.on('focus', () => registry.touchFocus(win.id, Date.now()));
  win.on('closed', () => {
    // Abort any AI streams this window started so they don't leak network/memory
    // after the window is gone (chat keys are scoped `${webContentsId}:${id}`).
    const wcPrefix = `${record.webContentsId}:`;
    for (const [key, controller] of activeChats) {
      if (key.startsWith(wcPrefix)) {
        controller.abort();
        activeChats.delete(key);
      }
    }
    registry.unregister(win.id);
    fileGrants.release(record.webContentsId);
    if (launchWindowId === win.id) launchWindowId = null;
    console.log(`[window] closed id=${win.id}`);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  installNavigationGuards(win);

  console.log(`[window] created id=${win.id} key=${record.windowKey}${restore ? ' restore=1' : ''}`);

  if (isDev) {
    await win.loadURL('http://localhost:5173');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    await win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  if (filePathToOpen) await openFilePath(filePathToOpen, win);
  return win;
}

function buildMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'New',
          accelerator: 'CmdOrCtrl+N',
          click: () => void createWindow(),
        },
        {
          label: 'Open…',
          accelerator: 'CmdOrCtrl+O',
          click: () => handleOpen(),
        },
        { type: 'separator' },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () => sendToFocused('menu:save'),
        },
        {
          label: 'Save As…',
          accelerator: 'Shift+CmdOrCtrl+S',
          click: () => sendToFocused('menu:save-as'),
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Preview',
          accelerator: 'CmdOrCtrl+P',
          click: () => sendToFocused('menu:toggle-preview'),
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'close' }],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const CONVERTIBLE_EXTS = new Set<string>(CONVERTIBLE_EXT_LIST);

/**
 * Smarter conversion from kordoc IR blocks → Markdown.
 *
 * kordoc's `blocksToMarkdown` classifies almost every HWP paragraph as H1,
 * which produces visually broken documents. We re-interpret the blocks
 * using Korean-document conventions:
 *   - `□` / `■` prefix → section heading (H2)
 *   - `ㅇ` / `o` / `○` / `●` / `▶` / `※` / `·` prefix → bullet list item
 *   - "heading" blocks that match none of the above → plain paragraph
 *     (kordoc misclassification)
 *   - tables → render from IR cells with proper rowspan/colspan handling
 */
type KordocBlock = {
  type: 'paragraph' | 'table' | 'heading' | 'list' | 'image' | 'separator';
  text?: string;
  level?: number;
  listType?: 'ordered' | 'unordered';
  table?: {
    rows: number;
    cols: number;
    cells: Array<Array<{ text: string; colSpan: number; rowSpan: number }>>;
    hasHeader: boolean;
  };
};

const SECTION_PREFIX = /^[□■◆◇▣▤▥▦▧▨▩]\s+/;
const BULLET_PREFIX = /^[oO○●ㅇ▶▷※·•・◦‣⁃-]\s+/;

function classifyHeadingText(text: string): 'section' | 'bullet' | 'paragraph' {
  const t = text.trimStart();
  if (SECTION_PREFIX.test(t)) return 'section';
  if (BULLET_PREFIX.test(t)) return 'bullet';
  return 'paragraph';
}

function renderTable(t: KordocBlock['table']): string {
  if (!t || t.cells.length === 0) return '';
  const cells = t.cells;
  const cols = t.cols;
  // Flatten each row's cells to text; collapse to one MD row.
  const rows = cells.map((row) =>
    row.map((c) => (c.text ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim() || ' '),
  );
  if (rows.length === 0) return '';
  const header = rows[0];
  const body = rows.slice(1);
  // Normalize all rows to same column count
  const norm = (r: string[]) => {
    if (r.length === cols) return r;
    if (r.length > cols) return r.slice(0, cols);
    return [...r, ...Array(cols - r.length).fill(' ')];
  };
  const out: string[] = [];
  out.push('| ' + norm(header).join(' | ') + ' |');
  out.push('| ' + Array(cols).fill('---').join(' | ') + ' |');
  for (const r of body) out.push('| ' + norm(r).join(' | ') + ' |');
  return out.join('\n');
}

function blocksToCleanMarkdown(blocks: KordocBlock[]): string {
  const out: string[] = [];
  let prevWasList = false;
  for (const b of blocks) {
    if (b.type === 'separator') {
      out.push('', '---', '');
      prevWasList = false;
      continue;
    }
    if (b.type === 'image') {
      // Inline images aren't preserved in MD reliably; skip with a hint.
      out.push('', '<!-- (image) -->', '');
      prevWasList = false;
      continue;
    }
    if (b.type === 'table' && b.table) {
      out.push('', renderTable(b.table), '');
      prevWasList = false;
      continue;
    }
    const text = (b.text ?? '').trim();
    if (!text) continue;

    if (b.type === 'heading') {
      const klass = classifyHeadingText(text);
      if (klass === 'section') {
        // Strip the section glyph, render as H2
        const stripped = text.replace(SECTION_PREFIX, '').trim();
        out.push('', `## ${stripped}`, '');
        prevWasList = false;
      } else if (klass === 'bullet') {
        const stripped = text.replace(BULLET_PREFIX, '').trim();
        if (!prevWasList) out.push('');
        out.push(`- ${stripped}`);
        prevWasList = true;
      } else {
        // Genuine paragraph that kordoc misclassified.
        if (b.level && b.level >= 2 && b.level <= 6) {
          // Respect explicit H2/H3/etc. if present
          out.push('', `${'#'.repeat(b.level)} ${text}`, '');
          prevWasList = false;
        } else {
          out.push('', text, '');
          prevWasList = false;
        }
      }
      continue;
    }
    if (b.type === 'list') {
      out.push(`- ${text}`);
      prevWasList = true;
      continue;
    }
    // paragraph
    if (BULLET_PREFIX.test(text)) {
      const stripped = text.replace(BULLET_PREFIX, '').trim();
      if (!prevWasList) out.push('');
      out.push(`- ${stripped}`);
      prevWasList = true;
    } else if (SECTION_PREFIX.test(text)) {
      const stripped = text.replace(SECTION_PREFIX, '').trim();
      out.push('', `## ${stripped}`, '');
      prevWasList = false;
    } else {
      out.push('', text, '');
      prevWasList = false;
    }
  }
  // Collapse 3+ blank lines into 2
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

async function handleOpen() {
  const parent = windowFromRecord(registry.focusedOrLast());
  const dialogOpts: Electron.OpenDialogOptions = {
    properties: ['openFile'],
    filters: [
      { name: 'Documents', extensions: [...OPENABLE_DOCUMENT_EXTS] },
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdx'] },
      { name: 'Korean / Office', extensions: [...CONVERTIBLE_EXT_LIST] },
      { name: 'Text', extensions: ['txt'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  };
  const result = parent
    ? await dialog.showOpenDialog(parent, dialogOpts)
    : await dialog.showOpenDialog(dialogOpts);
  if (result.canceled || result.filePaths.length === 0) return;
  // File>Open always opens in a new window (duplicate paths focus the owner).
  await openFileInWindow(result.filePaths[0], { reuseBlank: false });
}

async function openFilePath(filePath: string, win: BrowserWindow): Promise<void> {
  if (win.isDestroyed()) return;
  // Reaching openFilePath means a user-driven open (dialog / OS open-with / restore /
  // a workspace entry already authorized by the IPC handler): grant the path so a
  // later Save to it is authorized, and the renderer path string is never the sole
  // authority for arbitrary reads/writes.
  fileGrants.grantFile(win.webContents.id, filePath);
  const rec = registry.getByWebContents(win.webContents.id);
  const sink = sinkFor(win);
  // Gate every payload on renderer readiness so a freshly created window never
  // drops `file:opened` (which would leave it blank); queued payloads flush in order.
  const send = (channel: string, payload: unknown) => {
    if (rec) sendWhenReady(rec, channel, payload, sink);
    else sink(channel, payload);
  };
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  if (CONVERTIBLE_EXTS.has(ext)) {
    console.log(`[kordoc] converting ${ext.toUpperCase()}: ${filePath}`);
    send('file:opened', {
      filePath: null,
      content: '',
      // Status-only — used to display a progress hint while parsing.
      error: undefined,
      progress: `Converting ${ext.toUpperCase()}…`,
    });
    try {
      // Cap document size BEFORE reading the whole file into memory so a huge or
      // malformed convertible file cannot exhaust the main process.
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_CONVERT_BYTES) {
        send('file:opened', {
          filePath: null,
          content: '',
          error: `Could not convert ${ext.toUpperCase()}: file is too large (max 25 MB).`,
        });
        return;
      }
      const buf = await fs.readFile(filePath);
      // Convert in an isolated worker (bounded in-main fallback). renderHtml is the
      // preferred source for the renderer's Turndown pass; raw markdown is the floor.
      const conv = await convertDocument(ext, buf);
      if (conv.ok && typeof conv.markdown === 'string') {
        const baseName = filePath.replace(/\.[^/.]+$/, '.md');
        send('file:opened', {
          filePath: baseName,
          content: conv.markdown,
          html: conv.html,
          converted: { from: ext.toUpperCase(), originalPath: filePath },
        });
        if (rec) registry.claimPath(rec.windowId, baseName);
        // The suggested .md sibling is a main-derived save target → grant it.
        fileGrants.grantFile(win.webContents.id, baseName);
      } else {
        send('file:opened', {
          filePath: null,
          content: '',
          error: conv.error ?? `Could not convert ${ext.toUpperCase()}.`,
        });
      }
    } catch (e: any) {
      send('file:opened', {
        filePath: null,
        content: '',
        error: `Failed to convert ${ext.toUpperCase()}: ${e?.message ?? e}`,
      });
    }
    return;
  }
  const content = await fs.readFile(filePath, 'utf-8');
  send('file:opened', { filePath, content });
  if (rec) registry.claimPath(rec.windowId, filePath);
}

handleTrusted('file:save', async (event, args: { filePath: string | null; content: string }) => {
  const rec = registry.getByWebContents(event.sender.id);
  const win = windowFromRecord(rec);
  let target = args.filePath;
  // A renderer-supplied path MUST be a safe local absolute path — never trust it
  // to write anywhere on disk (path traversal / arbitrary overwrite guard).
  if (target && !isSafeLocalAbsolutePath(target)) {
    return { saved: false as const, error: 'invalid-path' as const };
  }
  if (!target) {
    if (!win) return { saved: false as const };
    const result = await dialog.showSaveDialog(win, {
      filters: [{ name: 'Markdown', extensions: ['md'] }],
      defaultPath: 'untitled.md',
    });
    if (result.canceled || !result.filePath) return { saved: false as const };
    target = result.filePath;
    // The user picked this path in the save dialog → grant it as a write target.
    fileGrants.grantFile(event.sender.id, target);
  }
  // Capability gate: the target must be an owned/granted file or live inside a
  // granted workspace — never an arbitrary renderer-supplied absolute path.
  if (!fileGrants.isFileAllowed(event.sender.id, target)) {
    return { saved: false as const, error: 'not-authorized' as const };
  }
  const finalTarget = target;
  // Serialize reserve→write→commit per canonical file identity so two windows
  // racing the same path cannot both pass the duplicate guard and both write
  // (TOCTOU). Key by realpath(parent)+basename; fall back to the resolved path.
  const saveKey = (await canonicalNewTarget(finalTarget, nodeIdentityFs)) ?? path.resolve(finalTarget);
  return saveMutex.run(saveKey, async () => {
    // Duplicate-path guard: another live window owns this path → block + focus the
    // owner, never silently overwrite (the requesting window stays dirty).
    if (rec) {
      const decision = registry.resolvePathClaim(rec.windowId, finalTarget);
      if (decision.kind === 'focus-owner') {
        windowFromRecord(registry.get(decision.ownerWindowId))?.focus();
        console.log(
          `[file] duplicate-path blocked path=${finalTarget} owner=${decision.ownerWindowId} requester=${rec.windowId} focusOwner=true`,
        );
        return { saved: false as const, error: 'already-open' as const, ownerWindowId: decision.ownerWindowId };
      }
      // Reserve ownership BEFORE the write so a concurrent save serialized behind
      // this one sees the claim and is redirected to focus-owner.
      registry.claimPath(rec.windowId, finalTarget);
    }
    try {
      await fs.writeFile(finalTarget, args.content, 'utf-8');
    } catch (e) {
      return { saved: false as const, error: e instanceof Error ? e.message : 'write-failed' };
    }
    return { saved: true as const, filePath: finalTarget };
  });
});

handleTrusted('file:open-path', async (event, filePath: unknown) => {
  // Renderer-supplied path: validate format AND require a grant before reading so
  // a compromised renderer cannot exfiltrate arbitrary files.
  if (!isSafeLocalAbsolutePath(filePath)) {
    return { error: 'invalid-path' as const };
  }
  if (!fileGrants.isFileAllowed(event.sender.id, filePath)) {
    return { error: 'not-authorized' as const };
  }
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return { filePath, content };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'read-failed' };
  }
});

// ---------- Workspace / file-tree IPC (G004 — left-panel file tree) ----------

handleTrusted('workspace:open-folder', async (event) => {
  const parent =
    windowFromRecord(registry.getByWebContents(event.sender.id)) ??
    windowFromRecord(registry.focusedOrLast());
  const opts: Electron.OpenDialogOptions = {
    properties: ['openDirectory', 'createDirectory'],
  };
  const result = parent
    ? await dialog.showOpenDialog(parent, opts)
    : await dialog.showOpenDialog(opts);
  if (result.canceled || result.filePaths.length === 0) return null;
  // Record the chosen workspace root so subsequent listDir/open calls are scoped.
  fileGrants.grantWorkspace(event.sender.id, result.filePaths[0]);
  return result.filePaths[0];
});

handleTrusted('workspace:list-dir',
async (event, args: { rootPath: string; dirPath: string }) => {
  if (!fileGrants.isWorkspaceGranted(event.sender.id, args?.rootPath ?? '')) {
    return { ok: false as const, entries: [] as FileTreeEntry[], error: 'workspace-not-authorized' };
  }
  // Symlink-escape guard: the requested dir must realpath-resolve inside the
  // granted root, so a symlink planted in the workspace cannot list outside it.
  if (!(await isRealpathWithinRoot(args.rootPath, args.dirPath, nodeIdentityFs))) {
    return { ok: false as const, entries: [] as FileTreeEntry[], error: 'path-escapes-root' };
  }
  try {
    const entries = await listDirectory({ rootPath: args.rootPath, dirPath: args.dirPath });
    return { ok: true as const, entries };
  } catch (e: any) {
    return { ok: false as const, entries: [] as FileTreeEntry[], error: String(e?.message ?? e) };
  }
},);

handleTrusted('file:open-in-current', async (event, target: unknown) => {
  const rec = registry.getByWebContents(event.sender.id);
  const win = windowFromRecord(rec);
  if (!rec || !win) return { opened: false as const, error: 'no-window' as const };
  // The duplicate-path guard lives in `openFileInCurrentWindow`: when another
  // live window owns the target it focuses that owner and never opens a second
  // writer (`openFilePath` is not called).
  if (typeof target !== 'string' || !fileGrants.isFileAllowed(event.sender.id, target)) {
    return { opened: false as const, error: 'not-authorized' as const };
  }
  return openFileInCurrentWindow(rec.windowId, target, {
    ownerOfPath: (p) => registry.ownerOfPath(p),
    focusOwner: (ownerWindowId) => {
      windowFromRecord(registry.get(ownerWindowId))?.focus();
    },
    openInRequester: (absPath) => openFilePath(absPath, win),
  });
});

handleTrusted('shell:open-path', async (event, filePath: unknown) => {
  if (!isSafeLocalAbsolutePath(filePath)) {
    return { ok: false as const, error: 'invalid-path' as const };
  }
  if (!fileGrants.isFileAllowed(event.sender.id, filePath)) {
    return { ok: false as const, error: 'not-authorized' as const };
  }
  // shell.openPath resolves to '' on success or an error message string.
  const result = await shell.openPath(path.resolve(filePath as string));
  return result === '' ? { ok: true as const } : { ok: false as const, error: result };
});

// ---------- Codex OAuth IPC ----------

handleTrusted('auth:status', async () => getStatus());

handleTrusted('auth:login', async (event) => {
  const sender = event.sender;
  return new Promise<void>((resolve) => {
    void startLogin((update: LoginUpdate) => {
      sender.send('auth:login-update', update);
      if (update.kind === 'success' || update.kind === 'error') resolve();
    });
  });
});

handleTrusted('auth:cancel-login', async () => {
  cancelLogin();
});

handleTrusted('auth:logout', async () => {
  await logout();
});

handleTrusted('auth:providers-status', async () => getRegistry().getAuthStatuses());

handleTrusted('auth:has-any', async () => getRegistry().hasAnyAuth());

handleTrusted('auth:set-api-key', async (_e, args: { provider: AiProviderId; key: string }) => {
  if (!isAiProviderId(args?.provider)) throw new Error('Unknown provider');
  return getRegistry().setApiKey(args.provider, args.key);
});

handleTrusted('auth:delete-provider-key', async (_e, provider: AiProviderId) => {
  if (!isAiProviderId(provider)) throw new Error('Unknown provider');
  await getRegistry().deleteApiKey(provider);
});

// ---------- AI Chat IPC (streaming) ----------

const activeChats = new Map<string, AbortController>();
/** Scope chat ids by sender so cancelling in one window can't abort another window's stream. */
function chatKey(webContentsId: number, id: string): string {
  return `${webContentsId}:${id}`;
}

handleTrusted('ai:chat',
async (
  event,
  payload: {
    id: string;
    instructions: string;
    history: ChatTurn[];
    userText: string;
    model?: string | { provider: AiProviderId; id: string };
    surfaceMode?: string;
    images?: unknown;
  },
) => {
  // Validate the renderer-supplied payload at the IPC boundary (types do not
  // survive IPC): reject malformed/oversized requests before allocating a
  // provider stream, and surface the error on the chat's event channel.
  const shapeCheck = validateChatTextPayload(payload);
  if (!shapeCheck.ok) {
    const id = typeof payload?.id === 'string' ? payload.id : 'unknown';
    event.sender.send(`ai:chat:${id}`, { kind: 'error', message: shapeCheck.error, errorKind: 'provider' });
    return;
  }
  const controller = new AbortController();
  const sender = event.sender;
  const key = chatKey(sender.id, payload.id);
  // Duplicate-id guard (H-19): abort any prior stream on the same key before
  // replacing it, so the old controller can't run untracked after we overwrite it.
  activeChats.get(key)?.abort();
  activeChats.set(key, controller);
  const model =
    typeof payload.model === 'string'
      ? { provider: 'chatgpt' as AiProviderId, id: payload.model }
      : payload.model && isAiProviderId(payload.model.provider)
        ? payload.model
        : { provider: 'chatgpt' as AiProviderId, id: 'gpt-5.4-mini' };
  const imgCheck = validateImageAttachments(payload.images);
  if (!imgCheck.ok) {
    sender.send(`ai:chat:${payload.id}`, { kind: 'error', message: imgCheck.error, errorKind: 'provider' });
    activeChats.delete(key);
    return;
  }
  try {
    await getRegistry().streamProviderChat(
      {
        instructions: payload.instructions,
        history: payload.history,
        userText: payload.userText,
        model,
        surfaceMode:
          payload.surfaceMode === 'write' ||
          payload.surfaceMode === 'advise' ||
          payload.surfaceMode === 'html' ||
          payload.surfaceMode === 'block'
            ? payload.surfaceMode
            : undefined,
        images: imgCheck.images.length ? imgCheck.images : undefined,
        signal: controller.signal,
        maxOutputTokens: isHtmlExportInstructions(payload.instructions)
          ? htmlExportMaxTokens(model.provider, model.id)
          : undefined,
      },
      (e) => sender.send(`ai:chat:${payload.id}`, e),
    );
  } finally {
    // Only clear the entry if it still points at THIS controller — a newer
    // request for the same id may have replaced it (H-19).
    if (activeChats.get(key) === controller) activeChats.delete(key);
  }
},);

handleTrusted('ai:cancel', async (event, id: string) => {
  const key = chatKey(event.sender.id, id);
  activeChats.get(key)?.abort();
  activeChats.delete(key);
});

handleTrusted('ai:models', async (_e, force?: boolean) => getRegistry().getAvailableModels(force === true));

// ---------- Local AI provider config IPC (Ollama / LM Studio) ----------

handleTrusted('local-ai:get-config', async () => getRegistry().getLocalConfig());

handleTrusted('local-ai:set-config',
async (_e, partial: { ollama?: string; lmstudio?: string }) =>
  getRegistry().setLocalConfig(partial ?? {}),);

// ---------- Prompt-assembly context IPC (v1.1 Phase 1) ----------

function makeProjectWizardService() {
  const userDataPath = app.getPath('userData');
  return createWizardService({
    userDataPath,
    fs,
    now: () => nowInSeoulIso(),
    loadContextStack: createContextStackLoader(userDataPath, fs),
  });
}

handleTrusted('project-wizard:start', async (_e, projectFolder: string) =>
  makeProjectWizardService().start(await requireProjectFolder(projectFolder)),);

handleTrusted('project-wizard:save-approved-draft', async (_e, input) => {
  if (!isProjectWizardSaveApprovedDraftInput(input)) {
    throw new Error('Invalid project wizard draft payload');
  }
  const projectFolder = await requireProjectFolder(input.projectFolder);
  return makeProjectWizardService().saveApprovedDraft({ ...input, projectFolder });
});

async function requireProjectFolder(projectFolder: unknown): Promise<string> {
  if (!isSafeAbsoluteProjectFolderPath(projectFolder)) {
    throw new Error('Invalid project folder path');
  }
  const stat = await fs.stat(projectFolder);
  if (!stat.isDirectory()) {
    throw new Error('Project folder path is not a directory');
  }
  return projectFolder;
}


// ---------- Session snapshot IPC ----------

/** Normalize a renderer-sent session payload into a v2 window snapshot (main owns the id). */
function toWindowSnapshot(id: string, raw: unknown): SessionWindowSnapshot {
  const r = (raw ?? {}) as Record<string, unknown>;
  const view =
    r.view === 'split' || r.view === 'editor-only' || r.view === 'preview-only' ? r.view : undefined;
  const win: SessionWindowSnapshot = {
    id,
    path: typeof r.path === 'string' ? r.path : null,
    title: typeof r.title === 'string' ? r.title : null,
    doc: typeof r.doc === 'string' ? r.doc : '',
  };
  if (typeof r.savedAt === 'number') win.savedAt = r.savedAt;
  if (typeof r.splitRatio === 'number') win.splitRatio = r.splitRatio;
  if (view) win.view = view;
  if (Array.isArray(r.unifiedChatHistory)) {
    win.unifiedChatHistory = r.unifiedChatHistory as SessionWindowSnapshot['unifiedChatHistory'];
  }
  if (Array.isArray(r.chatHistory)) {
    win.chatHistory = r.chatHistory as SessionWindowSnapshot['chatHistory'];
  }
  if (typeof r.model === 'string') win.model = r.model;
  if (typeof r.dirty === 'boolean') win.dirty = r.dirty;
  return win;
}

// Session IPC is sender-scoped: each window reads/writes/clears only its own
// entry in the v2 aggregate. Main owns the per-window key (renderer never sees it).
handleTrusted('session:get', async (event) => {
  const rec = registry.getByWebContents(event.sender.id);
  return { snapshot: rec?.restoreSnapshot ?? null };
});

handleTrusted('session:write', async (event, snap: unknown) => {
  const rec = registry.getByWebContents(event.sender.id);
  if (!rec) return;
  const win = toWindowSnapshot(rec.windowKey, snap);
  rec.lastSnapshot = win; // track content/dirty so a blank launch window is reused safely
  const next = await mutateSessionAggregate((cur) => ({
    ...upsertWindowSnapshot(cur, win),
    cleanExit: false,
  }));

  console.log(`[session] write key=${rec.windowKey} windows=${next.windows.length}`);
});

handleTrusted('session:clear', async (event) => {
  const rec = registry.getByWebContents(event.sender.id);
  if (!rec) return;
  await mutateSessionAggregate((cur) => removeWindowSnapshot(cur, rec.windowKey));
});

// New windows must not receive `file:opened` before the renderer is ready, or the
// payload is dropped and the window renders blank. Flush the per-window queue here.
onTrusted('window:ready', (event) => {
  const rec = registry.markReady(event.sender.id);
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!rec || !win) return;
  const flushed = flushPendingOutbound(rec, sinkFor(win));
  console.log(`[window] ready id=${rec.windowId} flushed=${flushed}`);
});

handleTrusted('update:check', async () => checkForUpdate(app.getVersion()));
handleTrusted('app:version', () => app.getVersion());
/**
 * Convert an attached document (PDF/DOCX/HWP/XLSX) buffer to Markdown text so it
 * can be fed to the AI as context. Reuses the same kordoc pipeline as file-open.
 * Bounded (25 MiB) and never throws — returns an actionable error instead.
 */
handleTrusted('ai:convert-attachment', async (_e, payload: unknown) => {
  const p = (payload ?? {}) as { base64?: unknown; ext?: unknown };
  const ext = typeof p.ext === 'string' ? p.ext.toLowerCase() : '';
  const base64 = typeof p.base64 === 'string' ? p.base64 : '';
  if (!CONVERTIBLE_EXTS.has(ext)) return { ok: false, error: `Unsupported attachment type: ${ext || 'unknown'}` };
  // Reject oversized payloads BEFORE decoding the base64 (avoids materializing a
  // huge Buffer just to reject it).
  const precap = checkBase64SizePrecap(base64, MAX_CONVERT_BYTES);
  if (!precap.ok) return { ok: false, error: precap.error };
  let buf: Buffer;
  try {
    buf = Buffer.from(base64, 'base64');
  } catch {
    return { ok: false, error: 'Could not read the attached file.' };
  }
  if (buf.length === 0) return { ok: false, error: 'The attached file is empty.' };
  if (buf.length > MAX_CONVERT_BYTES) return { ok: false, error: 'Attached file is too large (max 25 MB).' };
  // Cheap content sniff: reject an obvious extension/content mismatch.
  const magic = checkMagicBytes(buf, ext);
  if (!magic.ok) return { ok: false, error: `Attachment content does not match .${ext}` };
  const conv = await convertDocument(ext, buf);
  return conv.ok && typeof conv.markdown === 'string'
    ? { ok: true, markdown: conv.markdown }
    : { ok: false, error: conv.error ?? `Could not convert ${ext.toUpperCase()}.` };
});
handleTrusted('app:relaunch', () => {
  // Full restart so every renderer surface re-renders in the newly selected
  // language. Renderers flush their session snapshot before invoking this, so
  // open documents and unsaved buffers are restored on the next launch.
  app.relaunch();
  app.exit(0);
});
handleTrusted('shell:open-external', async (_e, url: string) => {
  if (isAllowedExternalUrl(url)) await shell.openExternal(url);
});

// ---------- OS integration IPC (⑥ os-integration, AC9 — default .md editor) ----------

handleTrusted('os:md-handler-status', async () => {
  // Reports only whether *this* build can register. We never probe Launch
  // Services for the current default handler (fragile); the renderer reflects a
  // "registered" state only after a successful, user-initiated registration.
  const { supported } = mdHandlerStatus({ isPackaged: app.isPackaged, platform: process.platform });
  return { supported };
});

handleTrusted('os:register-md-handler', async () => {
  // User-initiated ONLY (never on boot, never in a loop). Idempotent:
  // `lsregister -f` updates the existing registration in place. Gated to
  // packaged darwin so dev / non-darwin returns an explicit unsupported state.
  const { supported } = mdHandlerStatus({ isPackaged: app.isPackaged, platform: process.platform });
  if (!supported) return { ok: false, error: 'unsupported' };
  const bundlePath = bundlePathFromExecPath(app.getPath('exe'));
  const target = buildLsRegisterTarget(bundlePath);
  if (!target || !bundlePath) return { ok: false, error: 'bundle-not-found' };
  const runVoid = (cmd: string, args: string[]): Promise<void> =>
    new Promise((resolve, reject) => {
      execFile(cmd, args, (err) => (err ? reject(err) : resolve()));
    });
  const runCapture = (cmd: string, args: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile(cmd, args, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
    });
  const APP_BUNDLE_ID = 'com.notepad-ai.app'; // = build.appId
  try {
    // 1) Register the bundle so Launch Services lists it under "Open With…".
    await runVoid(target.command, target.args);
    // 2) Best-effort: attempt to set the default AND read back the resolved
    //    handler. macOS may refuse the programmatic write (unsigned app / not a
    //    trusted GUI context), so we trust the READ-BACK, not the attempt: only
    //    report defaultSet when our bundle id is actually the resolved default.
    let defaultSet = false;
    try {
      const apply = buildApplyDefaultHandlerCommand(bundlePath);
      const resolved = (await runCapture(apply.command, apply.args)).trim();
      defaultSet = resolved === APP_BUNDLE_ID;
      console.log(`[md-handler] registered; default resolves to "${resolved}" (ours=${defaultSet})`);
    } catch (e) {
      console.log(`[md-handler] default check failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { ok: true, registered: true, defaultSet };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
});

// ---------- HTML export IPC (⑤ html-export) ----------

/** GET a small text resource with a hard timeout and body cap (never throws past the promise). */
function fetchTextLimited(url: string, opts: { timeoutMs: number; maxBytes: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'Notepad-AI', Accept: 'text/plain, text/markdown, */*' } },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`Design fetch failed (HTTP ${status}).`));
          return;
        }
        let bytes = 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > opts.maxBytes) {
            req.destroy(new Error('Design file is too large.'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        res.on('error', reject);
      },
    );
    req.setTimeout(opts.timeoutMs, () => req.destroy(new Error('Design fetch timed out.')));
    req.on('error', reject);
  });
}

handleTrusted('design:fetch', async (_e, input: unknown) => {
  const rawUrl = normalizeDesignMdUrl(input);
  if (!rawUrl || !isAllowedDesignFetchUrl(rawUrl)) {
    return {
      ok: false as const,
      error: 'That design source is not supported. Paste a getdesign.md name or its DESIGN.md link.',
    };
  }
  try {
    const designMd = await fetchTextLimited(rawUrl, { timeoutMs: 8000, maxBytes: 200 * 1024 });
    return { ok: true as const, designMd, rawUrl };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : 'Could not fetch the design.' };
  }
});

/** In-memory cache of the design index (slugs) for the session. */
let designListCache: { slug: string; name: string; pageUrl: string }[] | null = null;

handleTrusted('design:list', async () => {
  if (designListCache) return { ok: true as const, designs: designListCache };
  const url = designListContentsUrl();
  if (!isAllowedDesignListFetchUrl(url)) {
    return { ok: false as const, error: 'Design index source is not allowed.' };
  }
  try {
    const text = await fetchTextLimited(url, { timeoutMs: 8000, maxBytes: 512 * 1024 });
    const designs = parseDesignListFromContents(JSON.parse(text));
    if (designs.length > 0) designListCache = designs;
    return { ok: true as const, designs };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : 'Could not load the design list.' };
  }
});

/** Force a safe `.html` basename for the save dialog default. */
function htmlSaveFileName(name: unknown): string {
  const fallback = 'notepad-ai-export.html';
  if (typeof name !== 'string') return fallback;
  const base = name.trim().replace(/[/\\]/g, '').slice(0, 120);
  if (!base) return fallback;
  return /\.html?$/i.test(base) ? base : `${base}.html`;
}

handleTrusted('html:save', async (event, args: { html?: string; defaultName?: string }) => {
  const win = windowFromRecord(registry.getByWebContents(event.sender.id));
  if (!win || typeof args?.html !== 'string') return { saved: false as const };
  const result = await dialog.showSaveDialog(win, {
    filters: [{ name: 'HTML', extensions: ['html'] }],
    defaultPath: htmlSaveFileName(args.defaultName),
  });
  if (result.canceled || !result.filePath) return { saved: false as const };
  let target = result.filePath;
  if (!/\.html?$/i.test(target)) target += '.html';
  try {
    await fs.writeFile(target, args.html, 'utf-8');
  } catch (e) {
    return { saved: false as const, error: e instanceof Error ? e.message : 'write-failed' };
  }
  return { saved: true as const, filePath: target };
});

handleTrusted('html:open-saved', async (_e, filePath: unknown) => {
  if (!isOpenableSavedPath(filePath)) {
    return { opened: false as const, error: 'Not an openable HTML file.' };
  }
  const target = (filePath as string).trim();
  if (!existsSync(target)) {
    return { opened: false as const, error: 'The saved file no longer exists.' };
  }
  // shell.openPath resolves to '' on success or an error message string.
  const result = await shell.openPath(target);
  if (result) return { opened: false as const, error: result };
  return { opened: true as const };
});

app.on('before-quit', () => {
  // Mark the aggregate as a clean exit so the next launch starts fresh (no restore).
  void markCleanExitQueued();

});
app.whenReady().then(async () => {
  // Warm the login-shell PATH resolver off the hot path so the first claude/grok
  // reachability probe doesn't pay the shell-exec latency. Non-blocking (fire-and-forget).
  void prewarmCliSpawnPath();

  const iconPath = resolveAppIconPath();
  if (process.platform === 'darwin' && iconPath) {
    app.dock.setIcon(iconPath);
  }

  // Resolve bundled OCR asset paths once (no CDN fallback); ignore failures so a
  // missing OCR bundle never blocks startup — OCR surfaces its own error on use.
  try {
    configureOcr(
      resolveOcrAssetPaths({
        appPath: app.getAppPath(),
        resourcesPath: process.resourcesPath,
        packaged: app.isPackaged,
      }),
    );
  } catch {
    /* OCR stays unconfigured; runOcr will surface an actionable error if invoked */
  }

  buildMenu();
  appIsReady = true;

  // Recreate windows from an unclean previous exit (v2 aggregate); a clean exit
  // resets the aggregate and returns false so we open a single fresh window.
  const restored = await restorePreviousWindows();

  if (pendingOpenFiles.length > 0) {
    // Finder "Open With" / double-click paths queued before readiness: one window per file.
    flushPendingOpenFiles();
  } else if (!restored) {
    const win = await createWindow();
    launchWindowId = win.id;
  }

  app.on('activate', () => {
    if (registry.all().length === 0) {
      void createWindow().then((win) => {
        launchWindowId = win.id;
      });
    }
  });
});

/**
 * On an unclean previous exit, recreate one window per persisted non-empty window
 * so a crash never loses the multi-window set (each renderer offers its own
 * restore). On a clean exit, reset the aggregate so stale windows never resurrect.
 * Returns true when at least one window was recreated.
 */
async function restorePreviousWindows(): Promise<boolean> {
  const prev = await getSessionAggregate();

  if (prev.cleanExit === true) {
    await resetSessionAggregate();
    return false;
  }
  const candidates = prev.windows.filter(
    (w) => (w.doc?.length ?? 0) > 0 || (w.unifiedChatHistory?.length ?? 0) > 0,
  );
  if (candidates.length === 0) return false;
  for (const snap of candidates) await createWindow({ restore: snap });
  console.log(`[session] restored windows=${candidates.length}`);
  return true;
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
