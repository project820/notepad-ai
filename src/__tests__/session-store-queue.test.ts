/**
 * session-store-queue.test.ts — SessionQueue serialization + quit-transaction
 * regression tests (Phase 0 safety net).
 *
 * These cover the concrete lost-update and clean-exit races the insane-review
 * flagged: two windows writing concurrently used to drop one snapshot, and a
 * late renderer write could overwrite the before-quit cleanExit marker.
 */

import { describe, it, expect } from 'vitest';
import { SessionQueue, type SessionQueueIO } from '../main/session-queue';
import {
  upsertWindowSnapshot,
  removeWindowSnapshot,
  type SessionSnapshotV2,
  type SessionWindowSnapshot,
} from '../main/session-schema';

function win(id: string, doc = `doc-${id}`): SessionWindowSnapshot {
  return { id, path: null, doc, pendingTitle: null } as SessionWindowSnapshot;
}

/** In-memory IO that records load/persist activity and can inject a failure. */
function makeIO(initial: SessionSnapshotV2 = { version: 2, windows: [] }) {
  const calls: string[] = [];
  let loadCount = 0;
  let disk: SessionSnapshotV2 = initial;
  let failNextPersist = false;
  const io: SessionQueueIO = {
    async load() {
      loadCount += 1;
      calls.push('load');
      return disk;
    },
    async persist(state) {
      calls.push('persist:start');
      if (failNextPersist) {
        failNextPersist = false;
        calls.push('persist:fail');
        throw new Error('disk full');
      }
      disk = state;
      calls.push('persist:end');
    },
  };
  return {
    io,
    calls,
    get loadCount() {
      return loadCount;
    },
    get disk() {
      return disk;
    },
    failOncePersist() {
      failNextPersist = true;
    },
  };
}

describe('SessionQueue — single-flight load', () => {
  it('loads the aggregate at most once across reads and mutations', async () => {
    const h = makeIO();
    const q = new SessionQueue(h.io);
    await Promise.all([q.read(), q.read(), q.mutate((s) => upsertWindowSnapshot(s, win('w1')))]);
    expect(h.loadCount).toBe(1);
  });
});

describe('SessionQueue — concurrent writes preserve every window (lost-update fix)', () => {
  it('two windows writing concurrently both survive', async () => {
    const h = makeIO();
    const q = new SessionQueue(h.io);
    // Fire both without awaiting between — the old read-modify-write dropped one.
    const a = q.mutate((s) => upsertWindowSnapshot(s, win('w1')));
    const b = q.mutate((s) => upsertWindowSnapshot(s, win('w2')));
    await Promise.all([a, b]);
    const ids = h.disk.windows.map((w) => w.id).sort();
    expect(ids).toEqual(['w1', 'w2']);
  });

  it('serializes persists (no interleave)', async () => {
    const h = makeIO();
    const q = new SessionQueue(h.io);
    await Promise.all([
      q.mutate((s) => upsertWindowSnapshot(s, win('w1'))),
      q.mutate((s) => upsertWindowSnapshot(s, win('w2'))),
    ]);
    const persists = h.calls.filter((c) => c.startsWith('persist'));
    // Each persist:start must be immediately followed by its persist:end.
    expect(persists).toEqual(['persist:start', 'persist:end', 'persist:start', 'persist:end']);
  });

  it('a clear that removes a window builds on the latest in-memory state', async () => {
    const h = makeIO();
    const q = new SessionQueue(h.io);
    await q.mutate((s) => upsertWindowSnapshot(s, win('w1')));
    await q.mutate((s) => upsertWindowSnapshot(s, win('w2')));
    await q.mutate((s) => removeWindowSnapshot(s, 'w1'));
    expect(h.disk.windows.map((w) => w.id)).toEqual(['w2']);
  });
});

describe('SessionQueue — quit transaction', () => {
  it('drops late non-quit writes after beginQuit so cleanExit wins', async () => {
    const h = makeIO();
    const q = new SessionQueue(h.io);
    await q.mutate((s) => upsertWindowSnapshot(s, win('w1')));
    q.beginQuit();
    // clean-exit marker (allowed during quit)
    await q.mutate((s) => ({ ...s, cleanExit: true }), { allowDuringQuit: true });
    // late renderer write (must be dropped)
    await q.mutate((s) => upsertWindowSnapshot(s, win('w-late')));
    expect(h.disk.cleanExit).toBe(true);
    expect(h.disk.windows.map((w) => w.id)).toEqual(['w1']);
  });

  it('isQuitting reflects beginQuit', async () => {
    const h = makeIO();
    const q = new SessionQueue(h.io);
    expect(q.isQuitting()).toBe(false);
    q.beginQuit();
    expect(q.isQuitting()).toBe(true);
  });
});

describe('SessionQueue — a persist failure does not wedge later writes', () => {
  it('keeps serving mutations after one persist rejects', async () => {
    const h = makeIO();
    const q = new SessionQueue(h.io);
    h.failOncePersist();
    await expect(q.mutate((s) => upsertWindowSnapshot(s, win('w1')))).rejects.toThrow('disk full');
    // The next mutation must still run and persist.
    await q.mutate((s) => upsertWindowSnapshot(s, win('w2')));
    expect(h.disk.windows.map((w) => w.id)).toContain('w2');
  });
});
