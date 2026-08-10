import { describe, expect, it, vi } from 'vitest';
import { handleCloseSaveRequest } from './close-save-handler';

describe('handleCloseSaveRequest', () => {
  it('reports document save before waiting for session snapshot persistence', async () => {
    let releaseSnapshot!: () => void;
    const snapshotFlush = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    const send = vi.fn();
    const request = handleCloseSaveRequest({
      requestId: 'save:1',
      requestedRevision: 4,
      save: async () => 4,
      isDirty: () => false,
      flushSessionSnapshot: () => snapshotFlush,
      onSnapshotFlushError: vi.fn(),
      send,
    });

    await vi.waitFor(() => expect(send).toHaveBeenCalledWith('save:1', { saved: true, committedRevision: 4 }));
    releaseSnapshot();
    await request;
  });

  it('keeps a snapshot flush failure after a successful document ACK', async () => {
    const send = vi.fn();
    const onSnapshotFlushError = vi.fn();
    await handleCloseSaveRequest({
      requestId: 'save:2',
      requestedRevision: 4,
      save: async () => 4,
      isDirty: () => false,
      flushSessionSnapshot: async () => { throw new Error('session write failed'); },
      onSnapshotFlushError,
      send,
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('save:2', { saved: true, committedRevision: 4 });
    expect(onSnapshotFlushError).toHaveBeenCalledOnce();
  });
});
