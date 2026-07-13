import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => {
  type Listener = (...args: any[]) => void;
  const ipcListeners = new Map<string, Listener>();
  const windows = new Map<number, FakeWindow>();
  let onSend: ((win: FakeWindow, channel: string, payload: any) => void) | null = null;

  class FakeWindow {
    readonly listeners = new Map<string, Listener[]>();
    destroyed = false;
    readonly webContents: {
      id: number;
      send: (channel: string, payload: any) => void;
      on: () => void;
      setWindowOpenHandler: () => void;
      openDevTools: () => void;
    };

    constructor(readonly id: number) {
      this.webContents = {
        id: id + 1000,
        send: (channel, payload) => onSend?.(this, channel, payload),
        on: () => {},
        setWindowOpenHandler: () => {},
        openDevTools: () => {},
      };
      windows.set(id, this);
    }

    on(event: string, listener: Listener) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
      return this;
    }

    once(event: string, listener: Listener) {
      const once: Listener = (...args) => {
        this.removeListener(event, once);
        listener(...args);
      };
      return this.on(event, once);
    }

    removeListener(event: string, listener: Listener) {
      this.listeners.set(event, (this.listeners.get(event) ?? []).filter((candidate) => candidate !== listener));
      return this;
    }

    emit(event: string) {
      for (const listener of this.listeners.get(event) ?? []) listener();
    }

    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    restore() {}
    focus() {}
    close() {}
    async loadFile() {}
  }

  return {
    app: { on: vi.fn(), quit: vi.fn(), getPath: vi.fn(() => '/tmp'), setPath: vi.fn(), setName: vi.fn(), setAboutPanelOptions: vi.fn() },
    dialog: { showOpenDialog: vi.fn(), showMessageBox: vi.fn() },
    shell: { openExternal: vi.fn() },
    ipcMain: {
      on: (channel: string, listener: Listener) => ipcListeners.set(channel, listener),
      handle: vi.fn(),
    },
    BrowserWindow: Object.assign(FakeWindow, {
      fromId: (id: number) => windows.get(id) ?? null,
      fromWebContents: (webContents: { id: number }) => [...windows.values()].find((win) => win.webContents.id === webContents.id) ?? null,
      getAllWindows: () => [...windows.values()],
    }),
    createWindow: (id: number) => new FakeWindow(id),
    emitIpc: (channel: string, win: FakeWindow, payload: any) => ipcListeners.get(channel)?.({
      sender: win.webContents,
      senderFrame: { parent: null, url: 'file:///app/index.html' },
    }, payload),
    setOnSend: (handler: ((win: FakeWindow, channel: string, payload: any) => void) | null) => { onSend = handler; },
    reset: () => {
      ipcListeners.clear();
      windows.clear();
      onSend = null;
    },
  };
});

vi.mock('electron', () => electron);

import type { WindowRecord } from '../main/window-registry';

type FakeWindow = InstanceType<typeof electron.BrowserWindow>;

type ReplyPolicy = (win: FakeWindow, channel: string, payload: { requestId: string; leaseId?: string }) => void;
type StatePolicy = (win: FakeWindow, payload: { requestId: string }) => void;

function registryFor(records: WindowRecord[]) {
  return {
    all: () => records,
    get: (id: number) => records.find((record) => record.windowId === id) ?? null,
    getByWebContents: (id: number) => records.find((record) => record.webContentsId === id) ?? null,
    focusedOrLast: () => null,
    register: () => {},
    unregister: () => {},
    touchFocus: () => {},
    ownerOfPath: () => null,
    claimPath: () => {},
  };
}

async function setup(
  reply: ReplyPolicy,
  showCloseDialog: () => Promise<'save' | 'discard' | 'cancel'>,
  count = 2,
  authorize: () => boolean = () => true,
  commitQuitSession: () => Promise<void> = async () => {},
  removeSessionWindow: () => Promise<void> = async () => {},
  removeSessionWindows: () => Promise<void> = async () => {},
  replyState: StatePolicy = (win, payload) => {
    electron.emitIpc('close:state', win, { ...payload, dirty: true, hasPath: true, docEmpty: false, revision: 0, locale: 'en' });
  },
) {
  electron.reset();
  vi.resetModules();
  const wins = Array.from({ length: count }, (_, index) => electron.createWindow(index + 1));
  const records = wins.map((win, index) => ({
    windowId: win.id,
    webContentsId: win.webContents.id,
    windowKey: `window-${index + 1}`,
    currentPath: '/tmp/draft.md',
    lastFocusedAt: 0,
    ready: true,
    pendingOutbound: [],
  }));
  const { createAppWindows } = await import('../main/app-windows');
  const appWindows = createAppWindows({
    registry: registryFor(records),
    fileGrants: { grantFile: () => {}, release: () => {} } as never,
    projectWizardRoots: { release: () => {} } as never,
    convertDocument: async () => ({ ok: false }),
    abortChatsForWebContents: () => {},
    hasSingleInstanceLock: true,
    removeSessionWindow,
    removeSessionWindows,
    commitQuitSession,
    showCloseDialog: async () => showCloseDialog(),
  });
  electron.setOnSend((win, channel, payload) => {
    if (channel === 'close:query-state') {
      replyState(win, payload);
    } else if (channel === 'close:authorize') {
      electron.emitIpc('close:authorize-result', win, { requestId: payload.requestId, valid: authorize() });
    } else {
      reply(win, channel, payload);
    }
  });
  return { appWindows, wins };
}

describe('discard close IPC waiters', () => {
  beforeEach(() => electron.reset());
  it('approves a save only after a fresh matching post-save revision', async () => {
    let stateQueries = 0;
    const commitQuitSession = vi.fn(async () => {});
    const { appWindows } = await setup((win, channel, payload) => {
      if (channel === 'close:save') {
        electron.emitIpc('close:save-result', win, { requestId: payload.requestId, saved: true, committedRevision: 7 });
      }
      if (channel === 'close:consume') {
        electron.emitIpc('close:consume-result', win, { requestId: payload.requestId, consumed: true });
      }
    }, async () => 'save', 1, () => true, commitQuitSession, async () => {}, async () => {}, (win, payload) => {
      stateQueries += 1;
      electron.emitIpc('close:state', win, { ...payload, dirty: true, hasPath: true, docEmpty: false, revision: 7, locale: 'en' });
    });

    await expect(appWindows.approveAllForQuit('quit')).resolves.toBe(true);

    expect(stateQueries).toBe(2);
    expect(commitQuitSession).toHaveBeenCalledWith([]);
  });

  it('fails closed when a save result has a stale post-save revision', async () => {
    let stateQueries = 0;
    const authorize = vi.fn(() => true);
    const commitQuitSession = vi.fn(async () => {});
    const { appWindows } = await setup((win, channel, payload) => {
      if (channel === 'close:save') {
        electron.emitIpc('close:save-result', win, { requestId: payload.requestId, saved: true, committedRevision: 7 });
      }
    }, async () => 'save', 1, authorize, commitQuitSession, async () => {}, async () => {}, (win, payload) => {
      stateQueries += 1;
      electron.emitIpc('close:state', win, { ...payload, dirty: true, hasPath: true, docEmpty: false, revision: stateQueries === 1 ? 7 : 8, locale: 'en' });
    });

    await expect(appWindows.approveAllForQuit('quit')).resolves.toBe(false);

    expect(stateQueries).toBe(2);
    expect(authorize).not.toHaveBeenCalled();
    expect(commitQuitSession).not.toHaveBeenCalled();
  });

  it('cancels dirty close and quit without session-removal or quit-commit callbacks', async () => {
    const removeSessionWindow = vi.fn(async () => {});
    const removeSessionWindows = vi.fn(async () => {});
    const commitQuitSession = vi.fn(async () => {});
    const { appWindows, wins } = await setup(
      () => {},
      async () => 'cancel',
      1,
      () => true,
      commitQuitSession,
      removeSessionWindow,
      removeSessionWindows,
    );

    await expect(appWindows.approveClose(wins[0])).resolves.toBe(false);
    await expect(appWindows.approveAllForQuit('quit')).resolves.toBe(false);

    expect(removeSessionWindow).not.toHaveBeenCalled();
    expect(removeSessionWindows).not.toHaveBeenCalled();
    expect(commitQuitSession).not.toHaveBeenCalled();
  });

  it('cancels a peer prepare and rolls back both targets when one prepare fails', async () => {
    const rollbackTargets: number[] = [];
    let dialogs = 0;
    const { appWindows, wins } = await setup((win, channel, payload) => {
      if (channel === 'close:discard' && win.id === 2) {
        electron.emitIpc('close:discard-result', win, { requestId: payload.requestId, fenced: false });
      }
      if (channel === 'close:discard-rollback') {
        rollbackTargets.push(win.id);
        electron.emitIpc('close:discard-result', win, { requestId: payload.requestId });
      }
    }, async () => (++dialogs > 2 ? 'cancel' : 'discard'));

    await expect(appWindows.approveAllForQuit('quit')).resolves.toBe(false);

    expect(rollbackTargets.sort()).toEqual(wins.map((win) => win.id));
  });

  it('does not let a late prepare ACK settle a rollback waiter with a distinct operation id', async () => {
    let prepareId = '';
    let rollbackId = '';
    let dialogs = 0;
    const { appWindows } = await setup((win, channel, payload) => {
      if (channel === 'close:discard') {
        prepareId = payload.requestId;
        electron.emitIpc('close:discard-result', win, { requestId: payload.requestId, fenced: false });
      }
      if (channel === 'close:discard-rollback') {
        rollbackId = payload.requestId;
        electron.emitIpc('close:discard-result', win, { requestId: prepareId, fenced: true });
        queueMicrotask(() => electron.emitIpc('close:discard-result', win, { requestId: payload.requestId }));
      }
    }, async () => (++dialogs > 1 ? 'cancel' : 'discard'), 1);

    await expect(appWindows.approveAllForQuit('quit')).resolves.toBe(false);

    expect(rollbackId).not.toBe(prepareId);
  });

  it('settles prepare and rollback waiters when their windows are destroyed', async () => {
    let dialogs = 0;
    const prepare = await setup((win, channel) => {
      if (channel === 'close:discard') {
        win.destroyed = true;
        win.emit('closed');
      }
      if (channel === 'close:discard-rollback') {
        win.destroyed = true;
        win.emit('closed');
      }
    }, async () => (++dialogs > 1 ? 'cancel' : 'discard'), 1);

    await expect(prepare.appWindows.approveAllForQuit('quit')).resolves.toBe(false);
    expect(prepare.wins[0].destroyed).toBe(true);

    dialogs = 0;
    let authorizationRequests = 0;
    const rollback = await setup((win, channel, payload) => {
      if (channel === 'close:discard') {
        electron.emitIpc('close:discard-result', win, { requestId: payload.requestId, fenced: true });
      }
      if (channel === 'close:discard-rollback') {
        win.destroyed = true;
        win.emit('closed');
      }
    }, async () => (++dialogs > 1 ? 'cancel' : 'discard'), 1, () => ++authorizationRequests < 2);

    await expect(rollback.appWindows.approveAllForQuit('quit')).resolves.toBe(false);
    expect(rollback.wins[0].destroyed).toBe(true);
  });

  it('waits for an active save drain beyond the control-plane timeout before committing discard', async () => {
    vi.useFakeTimers();
    let settled = false;
    try {
      const { appWindows } = await setup((win, channel, payload) => {
        if (channel === 'close:discard') {
          setTimeout(() => {
            electron.emitIpc('close:discard-result', win, { requestId: payload.requestId, fenced: true });
          }, 450);
        }
        if (channel === 'close:consume') {
          electron.emitIpc('close:consume-result', win, { requestId: payload.requestId, consumed: true });
        }
      }, async () => 'discard', 1);

      const approval = appWindows.approveAllForQuit('quit').then((approved) => {
        settled = true;
        return approved;
      });
      await vi.advanceTimersByTimeAsync(400);

      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(50);
      await expect(approval).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it('times out a missing rollback ACK, releases the session fence, and denies teardown', async () => {
    vi.useFakeTimers();
    try {
      let rollbackRequests = 0;
      let dialogs = 0;
      const commitQuitSession = vi.fn(async () => { throw new Error('disk full'); });
      const { appWindows } = await setup((win, channel, payload) => {
        if (channel === 'close:discard') {
          electron.emitIpc('close:discard-result', win, { requestId: payload.requestId, fenced: true });
        }
        if (channel === 'close:consume') {
          electron.emitIpc('close:consume-result', win, { requestId: payload.requestId, consumed: true });
        }
        if (channel === 'close:discard-rollback') rollbackRequests += 1;
      }, async () => (++dialogs === 1 ? 'discard' : 'cancel'), 1, () => true, commitQuitSession);

      let settled = false;
      const approval = appWindows.approveAllForQuit('quit').then((approved) => {
        settled = true;
        return approved;
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(rollbackRequests).toBe(1);
      expect(appWindows.isSessionWriteFenced('window-1')).toBe(true);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(399);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(approval).resolves.toBe(false);
      expect(appWindows.isSessionWriteFenced('window-1')).toBe(false);
      expect(commitQuitSession).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
  it('keeps a temporary discard fence through rollback, then restores writes after a failed commit', async () => {
    let rejectCommit!: (error: Error) => void;
    let signalCommitStarted!: () => void;
    let signalRollbackStarted!: () => void;
    let rollbackReply!: { win: FakeWindow; payload: { requestId: string } };
    const commitStarted = new Promise<void>((resolve) => { signalCommitStarted = resolve; });
    const rollbackStarted = new Promise<void>((resolve) => { signalRollbackStarted = resolve; });
    const commitQuitSession = vi.fn(() => new Promise<void>((_resolve, reject) => {
      rejectCommit = reject;
      signalCommitStarted();
    }));
    const rollbackTargets: number[] = [];
    const { appWindows } = await setup((win, channel, payload) => {
      if (channel === 'close:discard') {
        electron.emitIpc('close:discard-result', win, { requestId: payload.requestId, fenced: true });
      }
      if (channel === 'close:consume') {
        electron.emitIpc('close:consume-result', win, { requestId: payload.requestId, consumed: true });
      }
      if (channel === 'close:discard-rollback') {
        rollbackTargets.push(win.id);
        rollbackReply = { win, payload };
        signalRollbackStarted();
      }
    }, async () => 'discard', 1, () => true, commitQuitSession);

    const approval = appWindows.approveAllForQuit('quit');
    await commitStarted;
    expect(appWindows.isSessionWriteFenced('window-1')).toBe(true);

    rejectCommit(new Error('disk full'));
    await rollbackStarted;
    expect(appWindows.isSessionWriteFenced('window-1')).toBe(true);
    electron.emitIpc('close:discard-result', rollbackReply.win, { requestId: rollbackReply.payload.requestId });
    await expect(approval).resolves.toBe(false);

    expect(rollbackTargets).toEqual([1]);
    expect(appWindows.isSessionWriteFenced('window-1')).toBe(false);
  });
  it('preserves failed renderer discard compensation as a denied close', async () => {
    const rollbackResults: boolean[] = [];
    const commitQuitSession = vi.fn(async () => { throw new Error('disk full'); });
    const { appWindows } = await setup((win, channel, payload) => {
      if (channel === 'close:discard') {
        electron.emitIpc('close:discard-result', win, { requestId: payload.requestId, fenced: true });
      }
      if (channel === 'close:consume') {
        electron.emitIpc('close:consume-result', win, { requestId: payload.requestId, consumed: true });
      }
      if (channel === 'close:discard-rollback') {
        rollbackResults.push(false);
        electron.emitIpc('close:discard-result', win, { requestId: payload.requestId, fenced: false });
      }
    }, async () => 'discard', 1, () => true, commitQuitSession);

    await expect(appWindows.approveAllForQuit('quit')).resolves.toBe(false);

    expect(rollbackResults).toEqual([false]);
    expect(appWindows.isSessionWriteFenced('window-1')).toBe(false);
  });
});
