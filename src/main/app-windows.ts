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
import { awaitWithinDeadline, CloseCoordinator, createQuiesceTransaction, runDecideCloseLoop, type CloseAttemptContext, type CloseCommitResult, type CloseDecision, type CloseTarget } from './close-coordinator';

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
  removeSessionWindows: (windowKeys: readonly string[]) => Promise<void>;
  commitQuitSession: (discardedWindowKeys: readonly string[]) => Promise<void>;
  showCloseDialog?: (win: BrowserWindow, labels: { title: string; message: string; save: string; discard: string; cancel: string; saveAllowed?: boolean }) => Promise<CloseGuardChoice>;
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
  approveAllForQuit: (intent: 'quit' | 'relaunch') => Promise<boolean>;
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
  showCloseDialog = async (win, labels) => {
    const buttons = labels.saveAllowed === false
      ? [labels.discard, labels.cancel]
      : [labels.save, labels.discard, labels.cancel];
    const result = await dialog.showMessageBox(win, {
      type: 'warning',
      title: labels.title,
      message: labels.message,
      buttons,
      defaultId: 0,
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
  let preserveSessionOnClose = false;
  const approvedCloseWindowIds = new Set<number>();
  const discardedWindowKeys = new Set<string>();
  const pendingDiscardedWindowKeys = new Set<string>();
  const coordinator = new CloseCoordinator();
  const pendingState = new Map<string, { webContentsId: number; resolve: (state: CloseGuardState | null) => void }>();
  const pendingSave = new Map<string, { webContentsId: number; resolve: (result: { saved: boolean; committedRevision: number | null }) => void }>();
  const windowLocales = new Map<number, CloseGuardState['locale']>();
  const pendingAuthorize = new Map<string, { webContentsId: number; resolve: (valid: boolean) => void }>();
  const pendingDiscardPrepare = new Map<string, { webContentsId: number; leaseId: string; resolve: (fenced: boolean) => void }>();
  const pendingDiscardRollback = new Map<string, { webContentsId: number; resolve: (rolledBack: boolean) => void }>();
  const pendingConsume = new Map<string, { webContentsId: number; resolve: (consumed: boolean) => void }>();
  const closeLeases = new Map<number, { id: string; invalidated: boolean }>();
  const quiesceReady = new Set<number>();
  const pendingQuiesce = new Map<string, { webContentsId: number; resolve: (value: boolean) => void }>();
  const activeQuiesce = new Map<number, { id: string; heartbeat: ReturnType<typeof setInterval> }>();

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
    if (pendingRollback && pendingRollback.webContentsId === event.sender.id) pendingRollback.resolve(true);
  });
  onTrusted('close:quiesce-ready', (event) => {
    quiesceReady.add(event.sender.id);
  });
  onTrusted('close:quiesce-result', (event, raw: unknown) => {
    const value = raw as Record<string, unknown>;
    const id = typeof value?.requestId === 'string' ? value.requestId : '';
    const pending = pendingQuiesce.get(id);
    if (!pending || pending.webContentsId !== event.sender.id) return;
    pendingQuiesce.delete(id);
    pending.resolve(value.prepared === true || value.rolledBack === true);
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
  const authorizeRendererClose = (win: BrowserWindow, leaseId: string | undefined): Promise<boolean> => {
    if (!activeLease(win, leaseId)) return Promise.resolve(false);
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

  const beginFenceRendererDiscard = (win: BrowserWindow | null, leaseId: string | undefined) => {
    if (!win || !activeLease(win, leaseId)) {
      return { result: Promise.resolve(false), cancel: () => {} };
    }
    const id = requestId('discard-prepare', win);
    let settle: (fenced: boolean) => void = () => {};
    const result = new Promise<boolean>((resolve) => {
      let settled = false;
      // No wall-clock deadline: prepare deliberately awaits the renderer's
      // active-save drain (atomic write + fsync latency has no valid upper
      // bound). The waiter settles ONLY from the prepare ACK, an explicit
      // peer-cancellation via cancel(), or window destruction.
      const onDestroyed = () => settle(false);
      settle = (fenced) => {
        if (settled) return;
        settled = true;
        win.removeListener('closed', onDestroyed);
        pendingDiscardPrepare.delete(id);
        resolve(fenced && activeLease(win, leaseId));
      };
      pendingDiscardPrepare.set(id, { webContentsId: win.webContents.id, leaseId: leaseId!, resolve: settle });
      win.once('closed', onDestroyed);
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
        resolve(false);
      }, timeoutMs);
      pendingQuiesce.set(id, {
        webContentsId: win.webContents.id,
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

  const targetsFor = (records: readonly WindowRecord[]): CloseTarget[] => records.map((rec) => ({ windowId: rec.windowId, windowKey: rec.windowKey }));

  const commitCloseTransaction = async (
    transaction: { intent: 'close' | 'quit' | 'relaunch'; targets: readonly CloseTarget[]; discards: readonly CloseTarget[] },
  ): Promise<CloseCommitResult> => {
    // A discard request fences autosave before its active save drains. Track it
    // before waiting so every partial prepare is explicitly rolled back.
    const requestedDiscards = [...transaction.discards];
    const rollback = async (targets: readonly CloseTarget[]) => {
      await Promise.all(targets.map(async (target) => {
        const win = BrowserWindow.fromId(target.windowId);
        const leaseId = leaseIdFor(target.windowId);
        await rollbackRendererDiscardFence(win, leaseId);
        if (leaseId && leaseIdFor(target.windowId) === leaseId) closeLeases.delete(target.windowId);
      }));
    };
    const prepares = requestedDiscards.map((target) => ({
      target,
      ...beginFenceRendererDiscard(BrowserWindow.fromId(target.windowId), leaseIdFor(target.windowId)),
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
    if (discardedKeys.length > 0) {
      for (const windowKey of discardedKeys) pendingDiscardedWindowKeys.add(windowKey);
    }
    try {
      if (transaction.intent === 'quit') {
        await commitQuitSession(discardedKeys);
      } else if (discardedKeys.length > 0) {
        await removeSessionWindows(discardedKeys);
      }
    } catch (error) {
      console.error('[session] failed to commit close transaction:', error);
      await rollback(transaction.targets);
      for (const windowKey of discardedKeys) pendingDiscardedWindowKeys.delete(windowKey);
      return false;
    }

    for (const windowKey of discardedKeys) {
      pendingDiscardedWindowKeys.delete(windowKey);
      discardedWindowKeys.add(windowKey);
    }
    preserveSessionOnClose = transaction.intent === 'relaunch';
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

  const approveAllForQuit = async (intent: 'quit' | 'relaunch') => {
    const result = await coordinator.request(intent, targetsFor(registry.all()), decideClose, commitCloseTransaction, quiesceTransaction);
    return result.approved && result.intent === intent;
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
      closeLeases.delete(win.id);
      windowLocales.delete(win.id);
      if (!preserveSessionOnClose && !discardedWindowKeys.has(record.windowKey)) {
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
    isSessionWriteFenced: (windowKey) => pendingDiscardedWindowKeys.has(windowKey) || discardedWindowKeys.has(windowKey),
  };
}
