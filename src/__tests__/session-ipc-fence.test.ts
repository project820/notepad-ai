import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => {
  type Handler = (event: any, ...args: any[]) => unknown;
  const handlers = new Map<string, Handler>();
  return {
    ipcMain: {
      handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
      on: () => {},
    },
    BrowserWindow: { fromWebContents: () => null },
    handler: (channel: string) => handlers.get(channel),
    reset: () => handlers.clear(),
  };
});

const sessionStore = vi.hoisted(() => ({
  mutateSessionAggregate: vi.fn(),
}));

vi.mock('electron', () => electron);
vi.mock('../main/session-store', () => sessionStore);

import type { SessionSnapshotV2 } from '../main/session-schema';
import type { WindowRecord } from '../main/window-registry';

describe('session IPC discard fence', () => {
  beforeEach(() => {
    electron.reset();
    sessionStore.mutateSessionAggregate.mockReset();
  });

  it('drops a queued write after a preserved target enters its pending commit fence', async () => {
    const record = {
      windowId: 1,
      webContentsId: 1001,
      windowKey: 'preserved-quit-window',
      currentPath: null,
      lastFocusedAt: 0,
      ready: true,
      pendingOutbound: [],
    };
    const syncSnapshotPath = vi.fn();
    let fenced = false;
    const isSessionWriteFenced = vi.fn(() => fenced);
    let runQueuedMutation!: (state: SessionSnapshotV2) => SessionSnapshotV2;
    let resolveMutation!: (state: SessionSnapshotV2) => void;
    sessionStore.mutateSessionAggregate.mockImplementation((mutator: (state: SessionSnapshotV2) => SessionSnapshotV2) => new Promise<SessionSnapshotV2>((resolve) => {
      runQueuedMutation = mutator;
      resolveMutation = resolve;
    }));

    const { registerSessionIpc } = await import('../main/ipc/session-ipc');
    registerSessionIpc({
      registry: {
        getByWebContents: (id: number) => id === record.webContentsId ? record : null,
        syncSnapshotPath,
      } as never,
      sinkFor: () => (() => {}),
      isSessionWriteFenced,
    });
    const write = electron.handler('session:write');
    expect(write).toBeDefined();

    const acceptedWrite = write!({
      sender: { id: record.webContentsId },
      senderFrame: { parent: null, url: 'file:///app/index.html' },
    }, { doc: 'late recovery state' });
    fenced = true;
    const committedQuit: SessionSnapshotV2 = {
      version: 2,
      windows: [{ id: record.windowKey, path: null, title: null, doc: 'committed state' }],
      cleanExit: false,
    };
    const afterQueuedWrite = runQueuedMutation(committedQuit);
    resolveMutation(afterQueuedWrite);
    await acceptedWrite;
    expect(isSessionWriteFenced).toHaveBeenCalledTimes(2);

    expect(afterQueuedWrite).toBe(committedQuit);

    expect(record).not.toHaveProperty('lastSnapshot');
    expect(syncSnapshotPath).not.toHaveBeenCalled();
  });
  it('drops an admitted write when its record unregisters before the queued mutation runs', async () => {
    const record = {
      windowId: 1,
      webContentsId: 1001,
      windowKey: 'unregistered-window',
      currentPath: null,
      lastFocusedAt: 0,
      ready: true,
      pendingOutbound: [],
    };
    const syncSnapshotPath = vi.fn();
    let activeRecord: typeof record | null = record;
    let runQueuedMutation!: (state: SessionSnapshotV2) => SessionSnapshotV2;
    let resolveMutation!: (state: SessionSnapshotV2) => void;
    sessionStore.mutateSessionAggregate.mockImplementation((mutator: (state: SessionSnapshotV2) => SessionSnapshotV2) => new Promise<SessionSnapshotV2>((resolve) => {
      runQueuedMutation = mutator;
      resolveMutation = resolve;
    }));

    const { registerSessionIpc } = await import('../main/ipc/session-ipc');
    registerSessionIpc({
      registry: {
        getByWebContents: (id: number) => id === record.webContentsId ? activeRecord : null,
        syncSnapshotPath,
      } as never,
      sinkFor: () => (() => {}),
    });
    const write = electron.handler('session:write');
    expect(write).toBeDefined();

    const acceptedWrite = write!({
      sender: { id: record.webContentsId },
      senderFrame: { parent: null, url: 'file:///app/index.html' },
    }, { doc: 'late recovery state' });
    activeRecord = null;
    const committedQuit: SessionSnapshotV2 = {
      version: 2,
      windows: [{ id: record.windowKey, path: null, title: null, doc: 'committed state' }],
      cleanExit: false,
    };
    const afterQueuedWrite = runQueuedMutation(committedQuit);
    resolveMutation(afterQueuedWrite);
    await acceptedWrite;

    expect(afterQueuedWrite).toBe(committedQuit);
    expect(record).not.toHaveProperty('lastSnapshot');
    expect(syncSnapshotPath).not.toHaveBeenCalled();
  });
  it('drops an admitted write when its record is replaced before the queued mutation runs', async () => {
    const record = {
      windowId: 1,
      webContentsId: 1001,
      windowKey: 'replaced-window',
      currentPath: null,
      lastFocusedAt: 0,
      ready: true,
      pendingOutbound: [],
    };
    const replacement = {
      windowId: 2,
      webContentsId: record.webContentsId,
      windowKey: 'replacement-window',
      currentPath: null,
      lastFocusedAt: 0,
      ready: true,
      pendingOutbound: [],
    };
    const syncSnapshotPath = vi.fn();
    let activeRecord: typeof record = record;
    let runQueuedMutation!: (state: SessionSnapshotV2) => SessionSnapshotV2;
    let resolveMutation!: (state: SessionSnapshotV2) => void;
    sessionStore.mutateSessionAggregate.mockImplementation((mutator: (state: SessionSnapshotV2) => SessionSnapshotV2) => new Promise<SessionSnapshotV2>((resolve) => {
      runQueuedMutation = mutator;
      resolveMutation = resolve;
    }));

    const { registerSessionIpc } = await import('../main/ipc/session-ipc');
    registerSessionIpc({
      registry: {
        getByWebContents: (id: number) => id === record.webContentsId ? activeRecord : null,
        syncSnapshotPath,
      } as never,
      sinkFor: () => (() => {}),
    });
    const write = electron.handler('session:write');
    expect(write).toBeDefined();

    const acceptedWrite = write!({
      sender: { id: record.webContentsId },
      senderFrame: { parent: null, url: 'file:///app/index.html' },
    }, { doc: 'late recovery state' });
    activeRecord = replacement;
    const committedQuit: SessionSnapshotV2 = {
      version: 2,
      windows: [{ id: record.windowKey, path: null, title: null, doc: 'committed state' }],
      cleanExit: false,
    };
    const afterQueuedWrite = runQueuedMutation(committedQuit);
    resolveMutation(afterQueuedWrite);
    await acceptedWrite;

    expect(afterQueuedWrite).toBe(committedQuit);
    expect(record).not.toHaveProperty('lastSnapshot');
    expect(replacement).not.toHaveProperty('lastSnapshot');
    expect(syncSnapshotPath).not.toHaveBeenCalled();
  });
  it('uses the main-owned current path instead of a renderer-supplied path', async () => {
    const record: WindowRecord = {
      windowId: 1,
      webContentsId: 1001,
      windowKey: 'main-owned-path',
      currentPath: '/main-owned/document.md',
      lastFocusedAt: 0,
      ready: true,
      pendingOutbound: [],
    };
    const syncSnapshotPath = vi.fn();
    const claimPath = vi.fn();
    let persisted!: SessionSnapshotV2;
    sessionStore.mutateSessionAggregate.mockImplementation(async (mutator: (state: SessionSnapshotV2) => SessionSnapshotV2) => {
      persisted = mutator({ version: 2, windows: [], cleanExit: false });
      return persisted;
    });

    const { registerSessionIpc } = await import('../main/ipc/session-ipc');
    registerSessionIpc({
      registry: {
        getByWebContents: (id: number) => id === record.webContentsId ? record : null,
        syncSnapshotPath,
        claimPath,
      } as never,
      sinkFor: () => (() => {}),
    });
    const write = electron.handler('session:write');
    expect(write).toBeDefined();

    await write!({
      sender: { id: record.webContentsId },
      senderFrame: { parent: null, url: 'file:///app/index.html' },
    }, { path: '/renderer-supplied/arbitrary.md', doc: 'content' });

    expect(record.lastSnapshot?.path).toBe('/main-owned/document.md');
    expect(persisted.windows).toEqual([
      expect.objectContaining({ id: record.windowKey, path: '/main-owned/document.md', doc: 'content' }),
    ]);
    expect(syncSnapshotPath).toHaveBeenCalledWith(record.windowId, expect.objectContaining({ path: '/main-owned/document.md' }));
    expect(claimPath).not.toHaveBeenCalled();
  });
  it('does not mint a path claim from a renderer-supplied path for an untitled window', async () => {
    const record: WindowRecord = {
      windowId: 1,
      webContentsId: 1001,
      windowKey: 'untitled-window',
      currentPath: null,
      lastFocusedAt: 0,
      ready: true,
      pendingOutbound: [],
    };
    const syncSnapshotPath = vi.fn();
    const claimPath = vi.fn();
    let persisted!: SessionSnapshotV2;
    sessionStore.mutateSessionAggregate.mockImplementation(async (mutator: (state: SessionSnapshotV2) => SessionSnapshotV2) => {
      persisted = mutator({ version: 2, windows: [], cleanExit: false });
      return persisted;
    });

    const { registerSessionIpc } = await import('../main/ipc/session-ipc');
    registerSessionIpc({
      registry: {
        getByWebContents: (id: number) => id === record.webContentsId ? record : null,
        syncSnapshotPath,
        claimPath,
      } as never,
      sinkFor: () => (() => {}),
    });
    const write = electron.handler('session:write');
    expect(write).toBeDefined();

    await write!({
      sender: { id: record.webContentsId },
      senderFrame: { parent: null, url: 'file:///app/index.html' },
    }, { path: '/renderer-supplied/malicious.md', doc: 'content' });

    expect(record.currentPath).toBeNull();
    expect(record.lastSnapshot?.path).toBeNull();
    expect(persisted.windows).toEqual([
      expect.objectContaining({ id: record.windowKey, path: null, doc: 'content' }),
    ]);
    expect(syncSnapshotPath).toHaveBeenCalledWith(record.windowId, expect.objectContaining({ path: null }));
    expect(claimPath).not.toHaveBeenCalled();
  });
});
