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
import { queueOrOpenFile, shouldPublishLaunchWindow, type CreateWindowOptions } from './lifecycle-flags';
import type { ConvertDocument } from './convert';
import {
  closeGuardChoiceFromButton,
  guardCloseEvent,
  normalizeCloseGuardLocale,
  resolveCloseGuard,
  stateFromSnapshot,
  type CloseGuardChoice,
  type CloseGuardState,
} from './close-guard';
import { onTrusted } from './ipc-guard';

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
  removeSessionWindow: (windowKey: string) => Promise<void>;
  showCloseDialog?: (win: BrowserWindow, labels: { title: string; message: string; save: string; discard: string; cancel: string }) => Promise<CloseGuardChoice>;
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
  approveClose: (win: BrowserWindow) => Promise<boolean>;
  approveAllForQuit: () => Promise<boolean>;
  clearCloseApprovals: () => void;
  preserveSessionOnClose: () => void;
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
  removeSessionWindow,
  showCloseDialog = async (win, labels) => {
    const result = await dialog.showMessageBox(win, {
      type: 'warning',
      title: labels.title,
      message: labels.message,
      buttons: [labels.save, labels.discard, labels.cancel],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    return closeGuardChoiceFromButton(result.response);
  },
}: AppWindowsDeps): AppWindows {
  let ready = false;
  let launchWindowId: number | null = null;
  const pending: string[] = [];
  let preserveSessionOnClose = false;
  const approvedCloseWindowIds = new Set<number>();
  const pendingState = new Map<string, { webContentsId: number; resolve: (state: CloseGuardState | null) => void }>();
  const pendingSave = new Map<string, { webContentsId: number; resolve: (saved: boolean) => void }>();

  const requestId = (kind: string, win: BrowserWindow) => `${kind}:${win.id}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const waitFor = <T>(
    pending: Map<string, { webContentsId: number; resolve: (value: T) => void }>,
    id: string,
    webContentsId: number,
    send: () => void,
    fallback: T,
  ) => new Promise<T>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(fallback);
    }, 400);
    pending.set(id, {
      webContentsId,
      resolve: (value) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(value);
      },
    });
    send();
  });

  onTrusted('close:state', (event, raw: unknown) => {
    const value = raw as Record<string, unknown>;
    const id = typeof value?.requestId === 'string' ? value.requestId : '';
    const pending = pendingState.get(id);
    if (!pending || pending.webContentsId !== event.sender.id) return;
    if (
      typeof value.dirty !== 'boolean'
      || typeof value.hasPath !== 'boolean'
      || typeof value.docEmpty !== 'boolean'
    ) {
      pending.resolve(null);
      return;
    }
    pending.resolve({
      dirty: value.dirty,
      hasPath: value.hasPath,
      docEmpty: value.docEmpty,
      locale: normalizeCloseGuardLocale(value.locale),
    });
  });
  onTrusted('close:save-result', (event, raw: unknown) => {
    const value = raw as Record<string, unknown>;
    const id = typeof value?.requestId === 'string' ? value.requestId : '';
    const pending = pendingSave.get(id);
    if (!pending || pending.webContentsId !== event.sender.id) return;
    pending.resolve(value.saved === true);
  });

  const queryCloseState = async (win: BrowserWindow): Promise<CloseGuardState> => {
    const rec = registry.get(win.id);
    if (!rec || !rec.ready || win.isDestroyed()) return stateFromSnapshot(rec?.lastSnapshot);
    const id = requestId('state', win);
    return (await waitFor(
      pendingState,
      id,
      win.webContents.id,
      () => win.webContents.send('close:query-state', { requestId: id }),
      null,
    )) ?? stateFromSnapshot(rec.lastSnapshot);
  };

  const saveFromRenderer = async (win: BrowserWindow): Promise<boolean> => {
    if (win.isDestroyed()) return false;
    const id = requestId('save', win);
    return waitFor(
      pendingSave,
      id,
      win.webContents.id,
      () => win.webContents.send('close:save', { requestId: id }),
      false,
    );
  };

  const approveClose = async (win: BrowserWindow): Promise<boolean> => {
    if (approvedCloseWindowIds.has(win.id)) return true;
    const rec = registry.get(win.id);
    if (!rec || win.isDestroyed()) return true;
    const action = await resolveCloseGuard({
      state: await queryCloseState(win),
      showDialog: (labels) => showCloseDialog(win, labels),
      save: () => saveFromRenderer(win),
    });
    if (action === 'cancel') return false;
    if (action === 'discard') await removeSessionWindow(rec.windowKey);
    approvedCloseWindowIds.add(win.id);
    return true;
  };

  const approveAllForQuit = async () => {
    for (const rec of registry.all()) {
      const win = windowFromRecord(rec);
      if (win && !(await approveClose(win))) return false;
    }
    return true;
  };

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
    let closeGuardPending = false;
    win.on('close', (event) => {
      if (approvedCloseWindowIds.has(win.id)) return;
      if (closeGuardPending) {
        event.preventDefault();
        return;
      }
      closeGuardPending = true;
      guardCloseEvent(
        event,
        () => approveClose(win).finally(() => {
          closeGuardPending = false;
        }),
        () => {
          if (!win.isDestroyed()) win.close();
        },
        (error) => console.error('[close] guard failed:', error),
      );
    });
    win.on('closed', () => {
      abortChatsForWebContents(record.webContentsId);
      registry.unregister(win.id);
      fileGrants.release(record.webContentsId);
      projectWizardRoots.release(record.webContentsId);
      approvedCloseWindowIds.delete(win.id);
      if (!preserveSessionOnClose) {
        void removeSessionWindow(record.windowKey).catch((error) => {
          console.error('[session] failed to remove closed window:', error);
        });
      }
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
      if (arg) {
        queueOrOpenFile(ready, arg, pending, (filePath) => void openFileInWindow(filePath, true));
        if (!ready) focusExisting();
      } else {
        focusExisting();
      }
    });
  }

  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    queueOrOpenFile(ready, filePath, pending, (path) => void openFileInWindow(path, true));
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
    approveClose,
    approveAllForQuit,
    clearCloseApprovals: () => approvedCloseWindowIds.clear(),
    preserveSessionOnClose: () => {
      preserveSessionOnClose = true;
    },
  };
}
