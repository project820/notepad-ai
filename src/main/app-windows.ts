import { app, BrowserWindow, dialog, shell } from 'electron';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { OPENABLE_DOCUMENT_EXTS, CONVERTIBLE_EXTS as CONVERTIBLE_EXT_LIST } from '../shared/file-types';
import { MAX_CONVERT_BYTES } from './converter-bounds';
import { FileGrants } from './file-grants';
import { isTrustedAppUrl, SECURITY_REASON } from './security';
import { isAllowedExternalUrl } from './safe-external';
import { ProjectWizardRootStore } from './project-wizard/access';
import { sendWhenReady, type OutboundSink, type WindowRecord, type WindowRegistry } from './window-registry';
import type { SessionWindowSnapshot } from './session-schema';
import { shouldPublishLaunchWindow, type CreateWindowOptions } from './lifecycle-flags';
import type { ConvertDocument } from './convert';

const APP_DISPLAY_NAME = 'Notepad AI';
const APP_STORAGE_NAME = 'notepad-ai';
const isDev = process.env.NODE_ENV === 'development';
const convertible = new Set<string>(CONVERTIBLE_EXT_LIST);

type AppWindowsDeps = {
  registry: WindowRegistry;
  fileGrants: FileGrants;
  projectWizardRoots: ProjectWizardRootStore;
  convertDocument: ConvertDocument;
  abortChatsForWebContents: (id: number) => void;
  hasSingleInstanceLock: boolean;
};

type AppWindows = {
  createWindow: (opts?: CreateWindowOptions & { restore?: SessionWindowSnapshot }) => Promise<BrowserWindow>;
  openFilePath: (path: string, win: BrowserWindow) => Promise<void>;
  handleOpen: () => Promise<void>;
  setReady: () => void;
  hasPendingOpenFiles: () => boolean;
  flushPendingOpenFiles: () => void;
  windowFromRecord: (rec: WindowRecord | null) => BrowserWindow | null;
  sinkFor: (win: BrowserWindow) => OutboundSink;
  sendToFocused: (channel: string) => void;
};

/**
 * Configure the production app identity. `NOTEPAD_AI_USERDATA` is a
 * main-process-only seam for isolated Electron integration runs.
 */
export function configureAppIdentity(): void {
  const userData = process.env.NOTEPAD_AI_USERDATA || path.join(app.getPath('appData'), APP_STORAGE_NAME);
  app.setPath('userData', userData);
  app.setName(APP_DISPLAY_NAME);
  app.setAboutPanelOptions({
    applicationName: APP_DISPLAY_NAME,
    applicationVersion: app.getVersion(),
  });
}

export function createAppWindows({
  registry,
  fileGrants,
  projectWizardRoots,
  convertDocument,
  abortChatsForWebContents,
  hasSingleInstanceLock,
}: AppWindowsDeps): AppWindows {
  let ready = false;
  let launchWindowId: number | null = null;
  const pending: string[] = [];

  const windowFromRecord = (rec: WindowRecord | null) => {
    if (!rec) return null;
    const win = BrowserWindow.fromId(rec.windowId);
    return win && !win.isDestroyed() ? win : null;
  };

  const sinkFor = (win: BrowserWindow): OutboundSink => (channel, payload) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  };

  const sendToFocused = (channel: string) => {
    windowFromRecord(registry.focusedOrLast())?.webContents.send(channel);
  };

  const focusExisting = () => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  };

  const installNavigationGuards = (win: BrowserWindow) => {
    const deny = (event: Electron.Event, url: string) => {
      if (!isTrustedAppUrl(url, { isDev })) {
        event.preventDefault();
        console.warn(`[nav-guard] ${SECURITY_REASON.NAV_UNTRUSTED_ORIGIN} win=${win.id} blocked`);
      }
    };
    win.webContents.on('will-navigate', deny);
    win.webContents.on('will-redirect', deny);
    win.webContents.on('will-frame-navigate', (event) => deny(event, event.url));
  };

  const icon = () => {
    const p = path.resolve(__dirname, '../../build/icon.png');
    return existsSync(p) ? p : undefined;
  };

  const reusable = () => {
    if (launchWindowId == null) return null;
    const rec = registry.get(launchWindowId);
    if (!rec || rec.currentPath != null || (rec.lastSnapshot && (rec.lastSnapshot.dirty || (rec.lastSnapshot.doc?.length ?? 0) > 0))) return null;
    return windowFromRecord(rec);
  };

  const openFileInWindow = async (filePath: string, reuseBlank: boolean) => {
    const owner = registry.ownerOfPath(filePath);
    if (owner) {
      windowFromRecord(owner)?.focus();
      console.log(`[file] duplicate-path open focus owner=${owner.windowId} path=${filePath}`);
      return;
    }
    if (reuseBlank) {
      const blank = reusable();
      if (blank) {
        launchWindowId = null;
        await openFilePath(filePath, blank);
        return;
      }
    }
    await createWindow({ openFilePath: filePath });
  };

  const openFilePath = async (filePath: string, win: BrowserWindow) => {
    if (win.isDestroyed()) return;
    fileGrants.grantFile(win.webContents.id, filePath);
    const rec = registry.getByWebContents(win.webContents.id);
    const sink = sinkFor(win);
    const send = (c: string, p: unknown) => rec ? sendWhenReady(rec, c, p, sink) : sink(c, p);
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    if (convertible.has(ext)) {
      console.log(`[kordoc] converting ${ext.toUpperCase()}: ${filePath}`);
      send('file:opened', { filePath: null, content: '', error: undefined, progress: `Converting ${ext.toUpperCase()}…` });
      try {
        if ((await fs.stat(filePath)).size > MAX_CONVERT_BYTES) {
          send('file:opened', { filePath: null, content: '', error: `Could not convert ${ext.toUpperCase()}: file is too large (max 25 MB).` });
          return;
        }
        const conv = await convertDocument(ext as 'hwp' | 'hwpx' | 'hwpml' | 'docx' | 'pdf' | 'xlsx' | 'xls', await fs.readFile(filePath));
        if (conv.ok && typeof conv.markdown === 'string') {
          const baseName = filePath.replace(/\.[^/.]+$/, '.md');
          send('file:opened', { filePath: baseName, content: conv.markdown, html: conv.html, converted: { from: ext.toUpperCase(), originalPath: filePath } });
          if (rec) registry.claimPath(rec.windowId, baseName);
          fileGrants.grantFile(win.webContents.id, baseName);
        } else {
          send('file:opened', { filePath: null, content: '', error: conv.error ?? `Could not convert ${ext.toUpperCase()}.` });
        }
      } catch (e: any) {
        send('file:opened', { filePath: null, content: '', error: `Failed to convert ${ext.toUpperCase()}: ${e?.message ?? e}` });
      }
      return;
    }
    const content = await fs.readFile(filePath, 'utf-8');
    send('file:opened', { filePath, content });
    if (rec) registry.claimPath(rec.windowId, filePath);
  };

  const createWindow = async (opts: CreateWindowOptions & { restore?: SessionWindowSnapshot } = {}) => {
    // NOTEPAD_AI_HIDE_WINDOWS is a main-process-only seam for integration
    // runners: real windows still exist and render, but never steal the
    // user's screen or focus during automated runs.
    const hideForIntegrationRun = process.env.NOTEPAD_AI_HIDE_WINDOWS === '1';
    const win = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 920,
      minHeight: 560,
      title: APP_DISPLAY_NAME,
      titleBarStyle: 'hiddenInset',
      backgroundColor: '#1e1e1e',
      ...(hideForIntegrationRun ? { show: false } : {}),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
      ...(icon() ? { icon: icon() } : {}),
    });
    const record: WindowRecord = {
      windowId: win.id,
      webContentsId: win.webContents.id,
      windowKey: opts.restore?.id ?? `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      currentPath: opts.restore?.path ?? null,
      lastFocusedAt: Date.now(),
      ready: false,
      pendingOutbound: [],
      restoreSnapshot: opts.restore,
    };
    registry.register(record);
    // Electron can deliver an open-file event while the initial window is loading.
    // Only lifecycle-created blank windows are eligible for that reuse.
    if (shouldPublishLaunchWindow(opts) && launchWindowId == null) launchWindowId = win.id;
    if (opts.restore?.path) {
      registry.claimPath(win.id, opts.restore.path);
      fileGrants.grantFile(win.webContents.id, opts.restore.path);
    }
    win.on('focus', () => registry.touchFocus(win.id, Date.now()));
    win.on('closed', () => {
      abortChatsForWebContents(record.webContentsId);
      registry.unregister(win.id);
      fileGrants.release(record.webContentsId);
      projectWizardRoots.release(record.webContentsId);
      if (launchWindowId === win.id) launchWindowId = null;
      console.log(`[window] closed id=${win.id}`);
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedExternalUrl(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    installNavigationGuards(win);
    console.log(`[window] created id=${win.id} key=${record.windowKey}${opts.restore ? ' restore=1' : ''}`);
    if (isDev) {
      await win.loadURL('http://localhost:5173');
      win.webContents.openDevTools({ mode: 'detach' });
    } else {
      await win.loadFile(path.join(__dirname, '../renderer/index.html'));
    }
    if (opts.openFilePath) await openFilePath(opts.openFilePath, win);
    return win;
  };

  const handleOpen = async () => {
    const parent = windowFromRecord(registry.focusedOrLast());
    const options: Electron.OpenDialogOptions = {
      properties: ['openFile'],
      filters: [
        { name: 'Documents', extensions: [...OPENABLE_DOCUMENT_EXTS] },
        { name: 'Markdown', extensions: ['md', 'markdown', 'mdx'] },
        { name: 'Korean / Office', extensions: [...CONVERTIBLE_EXT_LIST] },
        { name: 'Text', extensions: ['txt'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    };
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    if (!result.canceled && result.filePaths.length) await openFileInWindow(result.filePaths[0], false);
  };

  if (!hasSingleInstanceLock) {
    app.quit();
  } else {
    app.on('second-instance', (_event, argv) => {
      const arg = argv.slice(1).find((a) => typeof a === 'string' && !a.startsWith('-') && existsSync(a));
      if (arg && ready) void openFileInWindow(arg, true);
      else focusExisting();
    });
  }

  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    if (!ready) pending.push(filePath);
    else void openFileInWindow(filePath, true);
  });

  return {
    createWindow,
    openFilePath,
    handleOpen,
    setReady: () => {
      ready = true;
    },
    hasPendingOpenFiles: () => pending.length > 0,
    flushPendingOpenFiles: () => {
      for (const p of pending.splice(0)) void openFileInWindow(p, true);
    },
    windowFromRecord,
    sinkFor,
    sendToFocused,
  };
}
