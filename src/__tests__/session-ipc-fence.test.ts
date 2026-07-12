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

describe('session IPC discard fence', () => {
  beforeEach(() => {
    electron.reset();
    sessionStore.mutateSessionAggregate.mockReset();
  });

  it('drops a write admitted before discard fencing when its queued mutator runs after removal', async () => {
    const record = {
      windowId: 1,
      webContentsId: 1001,
      windowKey: 'discarded-window',
      currentPath: null,
      lastFocusedAt: 0,
      ready: true,
      pendingOutbound: [],
    };
    const syncSnapshotPath = vi.fn();
    let fenced = false;
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
      isSessionWriteFenced: () => fenced,
    });
    const write = electron.handler('session:write');
    expect(write).toBeDefined();

    const acceptedWrite = write!({
      sender: { id: record.webContentsId },
      senderFrame: { parent: null, url: 'file:///app/index.html' },
    }, { doc: 'late recovery state' });
    fenced = true;
    const committedRemoval: SessionSnapshotV2 = { version: 2, windows: [], cleanExit: false };
    const afterQueuedWrite = runQueuedMutation(committedRemoval);
    resolveMutation(afterQueuedWrite);
    await acceptedWrite;

    expect(afterQueuedWrite).toBe(committedRemoval);

    expect(record).not.toHaveProperty('lastSnapshot');
    expect(syncSnapshotPath).not.toHaveBeenCalled();
  });
});
