import { app, BrowserWindow, dialog, shell } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { OPENABLE_DOCUMENT_EXTS, CONVERTIBLE_EXTS as CONVERTIBLE_EXT_LIST } from '../shared/file-types';
import { MAX_CONVERT_BYTES } from './converter-bounds';
import { FileGrants } from './file-grants';
import { nodeAssetReadFs, readFdBoundFile } from './asset-file-reader';
import { isTrustedAppUrl, SECURITY_REASON } from './security';
import { isAllowedExternalUrl } from './safe-external';
import { ProjectWizardRootStore } from './project-wizard/access';
import { sendWhenReady, type OutboundSink, type WindowRecord, type WindowRegistry } from './window-registry';
import { isRestorableSessionWindow, normalizeWindowSnapshot, type SessionWindowSnapshot } from './session-schema';
import { markShutdownRestoreQueued } from './session-store';
import { queueOrOpenFile, shouldPublishLaunchWindow, type CreateWindowOptions } from './lifecycle-flags';
import { logWarn } from './app-log';
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
import { awaitWithinDeadline, CloseCoordinator, createQuiesceTransaction, runDecideCloseLoop, type CloseAttemptContext, type CloseCommitResult, type CloseDecision, type CloseTarget } from './close-coordinator';

const APP_DISPLAY_NAME = 'Notepad AI';
const APP_STORAGE_NAME = 'notepad-ai';
const isDev = process.env.NODE_ENV === 'development';
const convertible = new Set<string>(CONVERTIBLE_EXT_LIST);

type OpenEnrollmentPolicy = 'consume-authorized' | 'enroll-os-open';

type AppWindowsDeps = {
  registry: WindowRegistry;
  fileGrants: FileGrants;
  projectWizardRoots: ProjectWizardRootStore;
  convertDocument: ConvertDocument;
  abortChatsForWebContents: (id: number) => void;
  hasSingleInstanceLock: boolean;
  removeSessionWindow: (windowKey: string) => Promise<void>;
  removeSessionWindows: (windowKeys: readonly string[]) => Promise<void>;
  commitQuitSession: (discardedWindowKeys: readonly string[]) => Promise<void>;
  commitShutdownSession?: (snapshots: readonly SessionWindowSnapshot[]) => Promise<void>;
  showCloseDialog?: (win: BrowserWindow, labels: { title: string; message: string; save: string; discard: string; cancel: string; saveAllowed?: boolean }) => Promise<CloseGuardChoice>;
};

type AppWindows = {
  createWindow: (opts?: CreateWindowOptions & { restore?: SessionWindowSnapshot; restoreReason?: 'shutdown' }) => Promise<BrowserWindow>;
  openFilePath: (path: string, win: BrowserWindow, enrollment?: OpenEnrollmentPolicy) => Promise<void>;
  handleOpen: () => Promise<void>;
  setReady: () => void;
  hasPendingOpenFiles: () => boolean;
  flushPendingOpenFiles: () => void;
  windowFromRecord: (rec: WindowRecord | null) => BrowserWindow | null;
  sinkFor: (win: BrowserWindow) => OutboundSink;
  sendToFocused: (channel: string) => void;
  approveClose: (win: BrowserWindow) => Promise<boolean>;
  approveAllForQuit: (intent: 'quit' | 'relaunch' | 'shutdown') => Promise<boolean>;
  waitForCloseTransaction: () => Promise<void>;
  clearCloseApprovals: () => void;
  isSessionWriteFenced: (windowKey: string) => boolean;
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
  removeSessionWindows,
  commitQuitSession,
  commitShutdownSession = markShutdownRestoreQueued,
  showCloseDialog = async (win, labels) => {
    const buttons = labels.saveAllowed === false
      ? [labels.discard, labels.cancel]
      : [labels.save, labels.discard, labels.cancel];
    const result = await dialog.showMessageBox(win, {
      type: 'warning',
      title: labels.title,
      message: labels.message,
      buttons,
      defaultId: labels.saveAllowed === false ? 1 : 0,
      cancelId: buttons.length - 1,
      noLink: true,
    });
    if (labels.saveAllowed === false) return result.response === 0 ? 'discard' : 'cancel';
    return closeGuardChoiceFromButton(result.response);
  },
}: AppWindowsDeps): AppWindows {
  let ready = false;
  let launchWindowId: number | null = null;
  const pending: string[] = [];
  const sessionTargetStates = new Map<string, 'pending-commit' | 'committed-removed' | 'committed-preserved'>();
  const approvedCloseWindowIds = new Set<number>();
  const coordinator = new CloseCoordinator();
  const pendingState = new Map<string, { webContentsId: number; resolve: (state: CloseGuardState | null) => void }>();
  const pendingSave = new Map<string, { webContentsId: number; resolve: (result: { saved: boolean; committedRevision: number | null }) => void }>();
  const windowLocales = new Map<number, CloseGuardState['locale']>();
  const pendingAuthorize = new Map<string, { webContentsId: number; resolve: (valid: boolean) => void }>();
  const pendingDiscardPrepare = new Map<string, { webContentsId: number; leaseId: string; resolve: (fenced: boolean) => void }>();
  const pendingDiscardRollback = new Map<string, { webContentsId: number; resolve: (rolledBack: boolean) => void }>();
  const pendingConsume = new Map<string, { webContentsId: number; resolve: (consumed: boolean) => void }>();
  const closeLeases = new Map<number, { id: string; invalidated: boolean }>();
  // Leases minted by main for unready restorable windows during shutdown: no
  // renderer handshake is possible, so authorize/consume short-circuit true.
  const mainOwnedShutdownLeases = new Set<string>();
  const pendingShutdownPersist = new Map<string, {
    webContentsId: number;
    leaseId: string;
    resolve: (result: { ok: boolean; revision: number; snapshot: unknown; fileSaved: boolean; error?: string }) => void;
  }>();
  const quiesceReady = new Set<number>();
  const pendingQuiesce = new Map<string, {
    webContentsId: number;
    phase: 'prepare' | 'rollback';
    resolve: (value: boolean) => void;
  }>();
  const activeQuiesce = new Map<number, { id: string; heartbeat: ReturnType<typeof setInterval> }>();
  const lateQuiesceRollbacks = new Map<string, number>();

  const requestId = (kind: string, win: BrowserWindow) => `${kind}:${win.id}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const waitForState = (
    id: string,
    webContentsId: number,
    send: () => void,
  ) => new Promise<CloseGuardState | null>((resolve) => {
    const timer = setTimeout(() => {
      pendingState.delete(id);
      resolve(null);
    }, 400);
    pendingState.set(id, {
      webContentsId,
      resolve: (value) => {
        clearTimeout(timer);
        pendingState.delete(id);
        resolve(value);
      },
    });
    send();
  });

  onTrusted('close:state', (event, raw: unknown) => {
    const value = raw as Record<string, unknown>;
    const id = typeof value?.requestId === 'string' ? value.requestId : '';
    const revision = value.revision;
    const pending = pendingState.get(id);
    if (!pending || pending.webContentsId !== event.sender.id) return;
    if (
      typeof value.dirty !== 'boolean'
      || typeof value.hasPath !== 'boolean'
      || typeof value.docEmpty !== 'boolean'
      || typeof revision !== 'number'
      || !Number.isSafeInteger(revision)
      || revision < 0
    ) {
      pending.resolve(null);
      return;
    }
    pending.resolve({
      dirty: value.dirty,
      hasPath: value.hasPath,
      docEmpty: value.docEmpty,
      revision,
      known: true,
      syncFailed: value.syncFailed === true,
      locale: normalizeCloseGuardLocale(value.locale),
    });
  });
  onTrusted('close:save-result', (event, raw: unknown) => {
    const value = raw as Record<string, unknown>;
    const id = typeof value?.requestId === 'string' ? value.requestId : '';
    const pending = pendingSave.get(id);
    if (!pending || pending.webContentsId !== event.sender.id) return;
    pending.resolve({
      saved: value.saved === true,
      committedRevision: Number.isSafeInteger(value.committedRevision) && (value.committedRevision as number) >= 0
        ? value.committedRevision as number
        : null,
    });
  });
  onTrusted('close:shutdown-persist:result', (event, raw: unknown) => {
    const value = raw as Record<string, unknown>;
    const id = typeof value?.id === 'string' ? value.id : '';
    const pending = pendingShutdownPersist.get(id);
    if (!pending || pending.webContentsId !== event.sender.id) return;
    pendingShutdownPersist.delete(id);
    const fileSaved = value.fileSaved === true;
    const error = typeof value.error === 'string' ? value.error : undefined;
    if (error) {
      void logWarn('lifecycle', 'shutdown persistence reported a failed save', { fileSaved, error, webContentsId: event.sender.id });
    }
    pending.resolve({
      ok: value.ok === true,
      revision: Number.isSafeInteger(value.revision) && (value.revision as number) >= 0
        ? value.revision as number
        : -1,
      snapshot: value.snapshot,
      fileSaved,
      error,
    });
  });
  onTrusted('close:authorize-result', (event, raw: unknown) => {
    const value = raw as Record<string, unknown>;
    const id = typeof value?.requestId === 'string' ? value.requestId : '';
    const pending = pendingAuthorize.get(id);
    if (!pending || pending.webContentsId !== event.sender.id) return;
    pendingAuthorize.delete(id);
    pending.resolve(value.valid === true);
  });
  onTrusted('close:consume-result', (event, raw: unknown) => {
    const value = raw as Record<string, unknown>;
    const id = typeof value?.requestId === 'string' ? value.requestId : '';
    const pending = pendingConsume.get(id);
    if (!pending || pending.webContentsId !== event.sender.id) return;
    pendingConsume.delete(id);
    pending.resolve(value.consumed === true);
  });
  onTrusted('close:discard-result', (event, raw: unknown) => {
    const value = raw as Record<string, unknown>;
    const id = typeof value?.requestId === 'string' ? value.requestId : '';
    const pendingPrepare = pendingDiscardPrepare.get(id);
    if (pendingPrepare && pendingPrepare.webContentsId === event.sender.id) {
      pendingPrepare.resolve(value.fenced === true);
      return;
    }
    const pendingRollback = pendingDiscardRollback.get(id);
    if (pendingRollback && pendingRollback.webContentsId === event.sender.id) pendingRollback.resolve(value.fenced === true);
  });
  onTrusted('close:quiesce-ready', (event) => {
    quiesceReady.add(event.sender.id);
  });
  onTrusted('close:quiesce-result', (event, raw: unknown) => {
    const value = raw as Record<string, unknown>;
    const id = typeof value?.requestId === 'string' ? value.requestId : '';
    const pending = pendingQuiesce.get(id);
    if (!pending || pending.webContentsId !== event.sender.id) {
      if (value.prepared === true && lateQuiesceRollbacks.get(id) === event.sender.id) {
        lateQuiesceRollbacks.delete(id);
        event.sender.send('close:quiesce-rollback', { requestId: id });
      }
      return;
    }
    const response = pending.phase === 'prepare' ? value.prepared : value.rolledBack;
    if (typeof response !== 'boolean') return;
    pendingQuiesce.delete(id);
    pending.resolve(response);
  });
  onTrusted('close:lease-invalidated', (event, raw: unknown) => {
    const value = raw as Record<string, unknown>;
    const id = typeof value?.requestId === 'string' ? value.requestId : '';
    const win = BrowserWindow.fromWebContents(event.sender);
    const lease = closeLeases.get(win?.id ?? -1);
    if (!lease || lease.id !== id) return;
    lease.invalidated = true;
    for (const pending of pendingDiscardPrepare.values()) {
      if (pending.webContentsId === event.sender.id && pending.leaseId === id) pending.resolve(false);
    }
    for (const pending of pendingShutdownPersist.values()) {
      if (pending.webContentsId === event.sender.id && pending.leaseId === id) {
        pending.resolve({ ok: false, revision: -1, snapshot: null, fileSaved: false });
      }
    }
  });
  onTrusted('close:locale', (event, locale: unknown) => {
    const rec = registry.getByWebContents(event.sender.id);
    if (rec) windowLocales.set(rec.windowId, normalizeCloseGuardLocale(locale));
  });

  const queryCloseState = async (win: BrowserWindow): Promise<CloseGuardState & { leaseId: string | null }> => {
    const rec = registry.get(win.id);
    const fallback = stateFromSnapshot(rec?.lastSnapshot);
    if (!rec || !rec.ready || win.isDestroyed()) {
      return { ...fallback, locale: windowLocales.get(win.id) ?? fallback.locale, leaseId: null };
    }
    const id = requestId('state', win);
    const live = await waitForState(id, win.webContents.id, () => win.webContents.send('close:query-state', { requestId: id }));
    if (!live) return { ...fallback, locale: windowLocales.get(win.id) ?? fallback.locale, leaseId: null };
    closeLeases.set(win.id, { id, invalidated: false });
    return { ...live, leaseId: id };
  };

  const saveFromRenderer = async (win: BrowserWindow, revision: number, deadline = Date.now() + 5_000) => {
    if (win.isDestroyed()) return { saved: false, committedRevision: null };
    const id = requestId('save', win);
    return new Promise<{ saved: boolean; committedRevision: number | null }>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const onDestroyed = () => pending.resolve({ saved: false, committedRevision: null });
      const pending = {
        webContentsId: win.webContents.id,
        resolve: (result: { saved: boolean; committedRevision: number | null }) => {
          if (timer) clearTimeout(timer);
          win.removeListener('closed', onDestroyed);
          pendingSave.delete(id);
          resolve(result);
        },
      };
      pendingSave.set(id, pending);
      win.once('closed', onDestroyed);
      timer = setTimeout(() => pending.resolve({ saved: false, committedRevision: null }), Math.max(0, deadline - Date.now()));
      win.webContents.send('close:save', { requestId: id, revision });
    });
  };
  const activeLease = (win: BrowserWindow, leaseId: string | undefined) => {
    const lease = closeLeases.get(win.id);
    return !!leaseId && !!lease && lease.id === leaseId && !lease.invalidated && !win.isDestroyed();
  };
  const persistShutdownFromRenderer = (
    win: BrowserWindow,
    leaseId: string,
    revision: number,
    deadline: number,
  ) => new Promise<{ ok: boolean; revision: number; snapshot: unknown; fileSaved: boolean; error?: string }>((resolve) => {
    if (!activeLease(win, leaseId) || Date.now() >= deadline) {
      resolve({ ok: false, revision: -1, snapshot: null, fileSaved: false });
      return;
    }
    const id = requestId('shutdown-persist', win);
    const onDestroyed = () => settle({ ok: false, revision: -1, snapshot: null, fileSaved: false });
    const settle = (result: { ok: boolean; revision: number; snapshot: unknown; fileSaved: boolean; error?: string }) => {
      clearTimeout(timer);
      win.removeListener('closed', onDestroyed);
      pendingShutdownPersist.delete(id);
      resolve(result);
    };
    const timer = setTimeout(() => settle({ ok: false, revision: -1, snapshot: null, fileSaved: false }), Math.max(0, deadline - Date.now()));
    pendingShutdownPersist.set(id, { webContentsId: win.webContents.id, leaseId, resolve: settle });
    win.once('closed', onDestroyed);
    win.webContents.send('close:shutdown-persist:request', { id, leaseId, revision });
  });
  const authorizeRendererClose = (win: BrowserWindow, leaseId: string | undefined): Promise<boolean> => {
    if (!activeLease(win, leaseId)) return Promise.resolve(false);
    if (leaseId && mainOwnedShutdownLeases.has(leaseId)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingAuthorize.delete(leaseId!);
        resolve(false);
      }, 400);
      pendingAuthorize.set(leaseId!, {
        webContentsId: win.webContents.id,
        resolve: (valid) => {
          clearTimeout(timer);
          pendingAuthorize.delete(leaseId!);
          resolve(valid && activeLease(win, leaseId));
        },
      });
      win.webContents.send('close:authorize', { requestId: leaseId });
    });
  };
  const consumeRendererClose = (win: BrowserWindow, leaseId: string | undefined): Promise<boolean> => {
    if (!activeLease(win, leaseId)) return Promise.resolve(false);
    if (leaseId && mainOwnedShutdownLeases.has(leaseId)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingConsume.delete(leaseId!);
        resolve(false);
      }, 400);
      pendingConsume.set(leaseId!, {
        webContentsId: win.webContents.id,
        resolve: (consumed) => {
          clearTimeout(timer);
          pendingConsume.delete(leaseId!);
          resolve(consumed && activeLease(win, leaseId));
        },
      });
      win.webContents.send('close:consume', { requestId: leaseId });
    });
  };

  const beginFenceRendererDiscard = (win: BrowserWindow | null, leaseId: string | undefined, timeoutMs = 5_000) => {
    if (!win || !activeLease(win, leaseId)) {
      return { result: Promise.resolve(false), cancel: () => {} };
    }
    const id = requestId('discard-prepare', win);
    let settle: (fenced: boolean) => void = () => {};
    const result = new Promise<boolean>((resolve) => {
      let settled = false;
      // A discard never approves before the active save drains, but it must
      // still settle so the coordinator can compensate and release ownership.
      let timer: ReturnType<typeof setTimeout> | null = null;
      const onDestroyed = () => settle(false);
      settle = (fenced) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        win.removeListener('closed', onDestroyed);
        pendingDiscardPrepare.delete(id);
        resolve(fenced && activeLease(win, leaseId));
      };
      pendingDiscardPrepare.set(id, { webContentsId: win.webContents.id, leaseId: leaseId!, resolve: settle });
      win.once('closed', onDestroyed);
      timer = setTimeout(() => settle(false), timeoutMs);
      win.webContents.send('close:discard', { requestId: id, leaseId });
    });
    return { result, cancel: () => settle(false) };
  };
  const rollbackRendererDiscardFence = async (win: BrowserWindow | null, leaseId: string | undefined): Promise<boolean> => {
    if (!leaseId || !win || win.isDestroyed()) return false;
    const id = requestId('discard-rollback', win);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const onDestroyed = () => settle(false);
      const settle = (rolledBack: boolean) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        win.removeListener('closed', onDestroyed);
        pendingDiscardRollback.delete(id);
        resolve(rolledBack);
      };
      pendingDiscardRollback.set(id, { webContentsId: win.webContents.id, resolve: settle });
      win.once('closed', onDestroyed);
      timer = setTimeout(() => settle(false), 400);
      win.webContents.send('close:discard-rollback', { requestId: id, leaseId });
    });
  };
  const waitForQuiesce = (win: BrowserWindow, channel: 'close:quiesce-prepare' | 'close:quiesce-rollback', ttlMs?: number, timeoutMs = 1_000, id = requestId('quiesce', win)): Promise<boolean> => {
    if (win.isDestroyed()) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingQuiesce.delete(id);
        // A late prepare ACK can still have installed a renderer fence. Keep an
        // ownership record so its ACK triggers a same-id rollback.
        if (channel === 'close:quiesce-prepare' && !win.isDestroyed()) {
          lateQuiesceRollbacks.set(id, win.webContents.id);
          setTimeout(() => lateQuiesceRollbacks.delete(id), 3_000);
        }
        resolve(false);
      }, timeoutMs);
      pendingQuiesce.set(id, {
        webContentsId: win.webContents.id,
        phase: channel === 'close:quiesce-prepare' ? 'prepare' : 'rollback',
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      });
      win.webContents.send(channel, ttlMs == null ? { requestId: id } : { requestId: id, ttlMs });
    });
  };

  const quiesceAll = async (targets: readonly CloseTarget[], rollback: boolean): Promise<boolean> => {
    const active = targets.map((target) => BrowserWindow.fromId(target.windowId))
      .filter((win): win is BrowserWindow => !!win && quiesceReady.has(win.webContents.id));
    if (active.length !== targets.length) return true;
    const results = await Promise.all(active.map(async (win) => {
      const existing = activeQuiesce.get(win.id);
      if (!rollback && existing) return true;
      if (rollback) {
        if (!existing) return true;
        clearInterval(existing.heartbeat);
        activeQuiesce.delete(win.id);
        return waitForQuiesce(win, 'close:quiesce-rollback', undefined, 1_000, existing.id);
      }
      const id = requestId('quiesce', win);
      const heartbeat = setInterval(() => {
        if (!win.isDestroyed()) win.webContents.send('close:quiesce-heartbeat', { requestId: id, ttlMs: 1_500 });
      }, 500);
      activeQuiesce.set(win.id, { id, heartbeat });
      const prepared = await waitForQuiesce(win, 'close:quiesce-prepare', 1_500, 1_000, id);
      if (!prepared) {
        clearInterval(heartbeat);
        activeQuiesce.delete(win.id);
      }
      return prepared;
    }));
    return results.every(Boolean);
  };
  const quiesceTransaction = createQuiesceTransaction({
    prepare: async (target) => quiesceAll([target], false),
    rollback: async (target) => { await quiesceAll([target], true); },
    commit: async (target) => {
      const active = activeQuiesce.get(target.windowId);
      if (active) clearInterval(active.heartbeat);
      activeQuiesce.delete(target.windowId);
    },
    awaitWithinDeadline,
  });
  const leaseIdFor = (windowId: number) => closeLeases.get(windowId)?.id;

  const decideClose = async (target: CloseTarget, context: CloseAttemptContext): Promise<CloseDecision> => {
    const win = BrowserWindow.fromId(target.windowId);
    if (!win || win.isDestroyed()) return 'allow';

    let state: (CloseGuardState & { leaseId: string | null }) | null = null;
    return runDecideCloseLoop({
      context,
      queryState: async () => {
        state = await queryCloseState(win);
      },
      resolveGuard: async () => {
        if (!state) return 'cancel';
        return resolveCloseGuard({
          state,
          // Native dialog dwell is intentionally outside the forward RPC SLA.
          showDialog: async (labels) => {
            const opened = Date.now();
            const choice = await showCloseDialog(win, labels);
            // Native modal dwell is not renderer RPC time.
            context.forwardDeadline += Date.now() - opened;
            return choice;
          },
          save: async () => {
            const result = await saveFromRenderer(win, state!.revision, context.forwardDeadline);
            if (!result.saved) return false;
            const current = await queryCloseState(win);
            return current.known === true && current.revision === result.committedRevision;
          },
        });
      },
      authorize: () => authorizeRendererClose(win, leaseIdFor(win.id)),
    });
  };
  const shutdownSnapshots = new Map<string, SessionWindowSnapshot>();
  const durableSnapshotForShutdown = (rec: WindowRecord): SessionWindowSnapshot | null => {
    if (rec.restoreSnapshot) {
      return normalizeWindowSnapshot(rec.windowKey, rec.currentPath ?? rec.restoreSnapshot.path, rec.restoreSnapshot);
    }
    if (rec.lastSnapshot) {
      return normalizeWindowSnapshot(rec.windowKey, rec.currentPath ?? rec.lastSnapshot.path, rec.lastSnapshot);
    }
    if (rec.currentPath != null) {
      // File-backed window still loading: disk is source of truth.
      return { id: rec.windowKey, path: rec.currentPath, title: null, doc: '', dirty: false };
    }
    return null;
  };
  const mintMainOwnedShutdownLease = (windowId: number): string => {
    const id = `main-owned-shutdown:${windowId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    closeLeases.set(windowId, { id, invalidated: false });
    mainOwnedShutdownLeases.add(id);
    return id;
  };
  const decideShutdown = async (target: CloseTarget, context: CloseAttemptContext): Promise<CloseDecision> => {
    const win = BrowserWindow.fromId(target.windowId);
    if (!win || win.isDestroyed()) return 'allow';

    const rec = registry.get(target.windowId);
    // Restored / file-backed windows that are still loading cannot complete the
    // renderer lease handshake. Use the durable main-side snapshot instead so
    // powerMonitor's preventDefault does not strand the OS power-off.
    if (rec && !rec.ready) {
      const durable = durableSnapshotForShutdown(rec);
      if (!durable) return 'cancel';
      shutdownSnapshots.set(target.windowKey, durable);
      mintMainOwnedShutdownLease(target.windowId);
      return 'allow';
    }

    let state: (CloseGuardState & { leaseId: string | null }) | null = null;
    return runDecideCloseLoop({
      context,
      queryState: async () => {
        shutdownSnapshots.delete(target.windowKey);
        state = await queryCloseState(win);
      },
      resolveGuard: async () => {
        if (!state?.leaseId || !state.known || state.syncFailed) return 'cancel';
        const result = await persistShutdownFromRenderer(win, state.leaseId, state.revision, context.forwardDeadline);
        if (
          !result.ok
          || result.revision !== state.revision
          || result.snapshot == null
          || typeof result.snapshot !== 'object'
          || !activeLease(win, state.leaseId)
        ) {
          return 'cancel';
        }
        const live = registry.get(target.windowId);
        if (!live) return 'cancel';
        const fromRenderer = normalizeWindowSnapshot(target.windowKey, live.currentPath, result.snapshot);
        // Crash-recovery windows keep restoreSnapshot until the user accepts or
        // declines the banner. A ready renderer can still be blank; do not clobber
        // the durable recovered draft with that empty live snapshot.
        const pendingRecovery = live.restoreSnapshot
          ? normalizeWindowSnapshot(target.windowKey, live.currentPath ?? live.restoreSnapshot.path, live.restoreSnapshot)
          : null;
        const chosen = pendingRecovery
          && isRestorableSessionWindow(pendingRecovery)
          && !isRestorableSessionWindow(fromRenderer)
          ? pendingRecovery
          : fromRenderer;
        shutdownSnapshots.set(target.windowKey, chosen);
        return 'allow';
      },
      authorize: () => authorizeRendererClose(win, leaseIdFor(win.id)),
    });
  };

  const targetsFor = (records: readonly WindowRecord[]): CloseTarget[] => records.map((rec) => ({ windowId: rec.windowId, windowKey: rec.windowKey }));

  const commitCloseTransaction = async (
    transaction: { intent: 'close' | 'quit' | 'relaunch' | 'shutdown'; targets: readonly CloseTarget[]; discards: readonly CloseTarget[]; context: CloseAttemptContext },
  ): Promise<CloseCommitResult> => {
    // A discard request fences autosave before its active save drains. Track it
    // before waiting so every partial prepare is explicitly rolled back.
    const requestedDiscards = [...transaction.discards];
    const rollback = async (targets: readonly CloseTarget[]) => {
      await Promise.all(targets.map(async (target) => {
        const win = BrowserWindow.fromId(target.windowId);
        const leaseId = leaseIdFor(target.windowId);
        const rolledBack = await rollbackRendererDiscardFence(win, leaseId);
        // Retain ownership when renderer compensation failed; a later close
        // query/lease expiry must not be mistaken for a completed rollback.
        if (rolledBack && leaseId && leaseIdFor(target.windowId) === leaseId) closeLeases.delete(target.windowId);
      }));
    };
    const prepares = requestedDiscards.map((target) => ({
      target,
      ...beginFenceRendererDiscard(
        BrowserWindow.fromId(target.windowId),
        leaseIdFor(target.windowId),
        Math.max(0, transaction.context.forwardDeadline - Date.now()),
      ),
    }));
    let failedPrepare = false;
    let failPrepare: () => void = () => {};
    const prepareFailed = new Promise<void>((resolve) => {
      failPrepare = resolve;
    });
    const allPrepared = Promise.all(prepares.map(async ({ result }) => {
      if (!await result) {
        failedPrepare = true;
        failPrepare();
      }
    }));
    await Promise.race([allPrepared, prepareFailed]);
    if (failedPrepare) {
      for (const { cancel } of prepares) cancel();
      await rollback(requestedDiscards);
      return { retry: requestedDiscards };
    }

    // One full parallel validation epoch must finish with every lease still
    // valid. A lease invalidation returns only that window to the decision
    // phase; the coordinator bounds repeated retries.
    const validation = await Promise.all(transaction.targets.map(async (target) => {
      const win = BrowserWindow.fromId(target.windowId);
      return !!win && await authorizeRendererClose(win, leaseIdFor(target.windowId));
    }));
    const invalid = transaction.targets.filter((target, index) => {
      const win = BrowserWindow.fromId(target.windowId);
      return !validation[index] || !win || !activeLease(win, leaseIdFor(target.windowId));
    });
    if (invalid.length > 0) {
      await rollback(requestedDiscards);
      return { retry: [...new Map([...invalid, ...requestedDiscards].map((target) => [target.windowId, target])).values()] };
    }

    const snapshots = transaction.intent === 'shutdown'
      ? transaction.targets.map((target) => shutdownSnapshots.get(target.windowKey))
      : [];
    if (transaction.intent === 'shutdown' && snapshots.some((snapshot) => !snapshot)) {
      await rollback(transaction.targets);
      return { retry: transaction.targets };
    }

    // Consume every already-authorized lease before any persistent or teardown
    // side effect. The renderer rejects later document mutations for a consumed
    // lease, closing the final validation-to-close race.
    const consumed = await Promise.all(transaction.targets.map(async (target) => {
      const win = BrowserWindow.fromId(target.windowId);
      return !!win && await consumeRendererClose(win, leaseIdFor(target.windowId));
    }));
    const notConsumed = transaction.targets.filter((target, index) => {
      const win = BrowserWindow.fromId(target.windowId);
      return !consumed[index] || !win || !activeLease(win, leaseIdFor(target.windowId));
    });
    if (notConsumed.length > 0) {
      await rollback(transaction.targets);
      return { retry: transaction.targets };
    }

    const discardedKeys = requestedDiscards.map((target) => target.windowKey);
    for (const target of transaction.targets) {
      sessionTargetStates.set(target.windowKey, 'pending-commit');
    }
    const removedSessionKeys = transaction.intent === 'close'
      ? transaction.targets.map((target) => target.windowKey)
      : discardedKeys;
    try {
      if (transaction.intent === 'quit') {
        await commitQuitSession(discardedKeys);
      } else if (transaction.intent === 'shutdown') {
        await commitShutdownSession(snapshots as SessionWindowSnapshot[]);
      } else if (removedSessionKeys.length > 0) {
        await removeSessionWindows(removedSessionKeys);
      }
    } catch (error) {
      console.error('[session] failed to commit close transaction:', error);
      await rollback(transaction.targets);
      for (const target of transaction.targets) sessionTargetStates.delete(target.windowKey);
      return false;
    }

    for (const target of transaction.targets) {
      sessionTargetStates.set(
        target.windowKey,
        removedSessionKeys.includes(target.windowKey) ? 'committed-removed' : 'committed-preserved',
      );
    }

    for (const target of transaction.targets) {
      approvedCloseWindowIds.add(target.windowId);
      closeLeases.delete(target.windowId);
    }
    return true;
  };

  const approveClose = async (win: BrowserWindow): Promise<boolean> => {
    if (approvedCloseWindowIds.has(win.id)) return true;
    const rec = registry.get(win.id);
    if (!rec || win.isDestroyed()) return true;
    const result = await coordinator.request('close', targetsFor([rec]), decideClose, (transaction) => commitCloseTransaction(transaction), quiesceTransaction);
    return result.approved;
  };

  const approveAllForQuit = async (intent: 'quit' | 'relaunch' | 'shutdown') => {
    const records = registry.all();
    const unreadyBlankRecords = intent === 'shutdown'
      ? records.filter((rec) => !rec.ready && rec.currentPath == null && !rec.restoreSnapshot && !rec.lastSnapshot)
      : [];
    try {
      const result = await coordinator.request(
        intent,
        targetsFor(intent === 'shutdown' ? records.filter((rec) => !unreadyBlankRecords.includes(rec)) : records),
        intent === 'shutdown' ? decideShutdown : decideClose,
        commitCloseTransaction,
        quiesceTransaction,
      );
      if (result.approved && result.intent === 'shutdown') {
        for (const rec of unreadyBlankRecords) approvedCloseWindowIds.add(rec.windowId);
      }
      return result.approved && result.intent === intent;
    } finally {
      if (intent === 'shutdown') {
        shutdownSnapshots.clear();
        mainOwnedShutdownLeases.clear();
      }
    }
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
        await openFilePath(filePath, blank, 'enroll-os-open');
        return;
      }
    }
    await createWindow({ openFilePath: filePath });
  };

  const openFilePath = async (
    filePath: string,
    win: BrowserWindow,
    enrollment: OpenEnrollmentPolicy = 'consume-authorized',
  ) => {
    if (win.isDestroyed()) return;
    const rec = registry.getByWebContents(win.webContents.id);
    const sink = sinkFor(win);
    const send = (c: string, p: unknown) => rec ? sendWhenReady(rec, c, p, sink) : sink(c, p);
    const requestedExtension = filePath.split('.').pop()?.toLowerCase() ?? '';
    const grant = (await fileGrants.authorizeExistingFile(win.webContents.id, filePath))?.grant
      ?? (enrollment === 'enroll-os-open'
        ? await fileGrants.grantExistingFile(
          win.webContents.id,
          filePath,
          convertible.has(requestedExtension) ? 'conversion' : 'os-open',
        )
        : null);

    if (!grant) {
      send('file:opened', { filePath: null, content: '', error: 'Could not open the selected file.' });
      return;
    }
    const canonicalPath = grant.realpath;
    const ext = canonicalPath.split('.').pop()?.toLowerCase() ?? '';
    if (convertible.has(ext)) {
      console.log(`[kordoc] converting ${ext.toUpperCase()}: ${canonicalPath}`);
      send('file:opened', { filePath: null, content: '', error: undefined, progress: `Converting ${ext.toUpperCase()}…` });
      try {
        const read = await readFdBoundFile(grant, nodeAssetReadFs, MAX_CONVERT_BYTES);
        if (!read.ok) {
          const error = read.error === 'too-large'
            ? `Could not convert ${ext.toUpperCase()}: file is too large (max 25 MB).`
            : `Failed to convert ${ext.toUpperCase()}: ${read.error}`;
          send('file:opened', { filePath: null, content: '', error });
          return;
        }
        const bytes = Buffer.from(read.bytes.buffer, read.bytes.byteOffset, read.bytes.byteLength);
        const conv = await convertDocument(ext as 'hwp' | 'hwpx' | 'hwpml' | 'docx' | 'pdf' | 'xlsx' | 'xls', bytes);
        if (conv.ok && typeof conv.markdown === 'string') {
          const baseName = canonicalPath.replace(/\.[^/.]+$/, '.md');
          const saveTarget = await fileGrants.grantSaveTarget(win.webContents.id, baseName);
          const convertedPath = saveTarget?.canonicalPath ?? null;
          send('file:opened', { filePath: convertedPath, content: conv.markdown, html: conv.html, converted: { from: ext.toUpperCase(), originalPath: canonicalPath } });
          if (rec && convertedPath) registry.claimPath(rec.windowId, convertedPath);
        } else {
          send('file:opened', { filePath: null, content: '', error: conv.error ?? `Could not convert ${ext.toUpperCase()}.` });
        }
      } catch (e: any) {
        send('file:opened', { filePath: null, content: '', error: `Failed to convert ${ext.toUpperCase()}: ${e?.message ?? e}` });
      }
      return;
    }
    const read = await readFdBoundFile(grant, nodeAssetReadFs);
    if (!read.ok) {
      send('file:opened', { filePath: null, content: '', error: 'Could not open the selected file.' });
      return;
    }
    const content = Buffer.from(read.bytes.buffer, read.bytes.byteOffset, read.bytes.byteLength).toString('utf-8');
    send('file:opened', { filePath: canonicalPath, content });
    if (rec) registry.claimPath(rec.windowId, canonicalPath);
  };

  const createWindow = async (opts: CreateWindowOptions & { restore?: SessionWindowSnapshot; restoreReason?: 'shutdown' } = {}) => {
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
      restoreReason: opts.restoreReason,
    };
    registry.register(record);
    // Electron can deliver an open-file event while the initial window is loading.
    // Only lifecycle-created blank windows are eligible for that reuse.
    if (shouldPublishLaunchWindow(opts) && launchWindowId == null) launchWindowId = win.id;
    if (opts.restore?.path) {
      registry.claimPath(win.id, opts.restore.path);
      await fileGrants.grantExistingFile(win.webContents.id, opts.restore.path, 'session-restore');
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
      closeLeases.delete(win.id);
      windowLocales.delete(win.id);
      const sessionState = sessionTargetStates.get(record.windowKey);
      sessionTargetStates.delete(record.windowKey);
      if (!sessionState) {
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
    if (opts.openFilePath) await openFilePath(opts.openFilePath, win, 'enroll-os-open');
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
    waitForCloseTransaction: () => coordinator.waitForIdle(),
    clearCloseApprovals: () => approvedCloseWindowIds.clear(),
    isSessionWriteFenced: (windowKey) => sessionTargetStates.has(windowKey),
  };
}
