/**
 * session-store-queue.test.ts — SessionQueue serialization + quit-transaction
 * regression tests (Phase 0 safety net).
 *
 * These cover the concrete lost-update and clean-exit races the insane-review
 * flagged: two windows writing concurrently used to drop one snapshot, and a
 * late renderer write could overwrite the before-quit cleanExit marker.
 */

import { describe, it, expect, vi } from 'vitest';
import { SessionQueue, type SessionQueueIO } from '../main/session-queue';
import {
  upsertWindowSnapshot,
  removeWindowSnapshot,
  type SessionSnapshotV2,
  type SessionWindowSnapshot,
} from '../main/session-schema';
const sessionStoreHarness = vi.hoisted(() => ({
  disk: { version: 2 as const, windows: [] as unknown[] },
  persists: 0,
  failPersist: false,
}));

vi.mock('electron', () => ({ app: { getPath: () => '/session-test' } }));
vi.mock('node:fs', () => ({
  promises: {
    readFile: async () => JSON.stringify(sessionStoreHarness.disk),
    rename: async () => {},
  },
}));
vi.mock('../main/atomic-write', () => ({
  nodeAtomicBackend: () => ({}),
  atomicWrite: async (_target: string, contents: string) => {
    sessionStoreHarness.persists += 1;
    if (sessionStoreHarness.failPersist) throw new Error('disk full');
    sessionStoreHarness.disk = JSON.parse(contents);
  },
}));

function win(id: string, doc = `doc-${id}`): SessionWindowSnapshot {
  return { id, path: null, doc, title: null } as SessionWindowSnapshot;
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
  it('drops late non-quit writes only after the final aggregate persists', async () => {
    const h = makeIO();
    const q = new SessionQueue(h.io);
    await q.mutate((s) => upsertWindowSnapshot(s, win('w1')));
    await q.beginQuit((s) => ({ ...s, cleanExit: true }));
    // late renderer write (must be dropped)
    await q.mutate((s) => upsertWindowSnapshot(s, win('w-late')));
    expect(h.disk.cleanExit).toBe(true);
    expect(h.disk.windows.map((w) => w.id)).toEqual(['w1']);
  });
  it('persists discarded removals and cleanExit in one final mutation', async () => {
    const h = makeIO();
    const q = new SessionQueue(h.io);
    await q.mutate((s) => upsertWindowSnapshot(s, win('discarded')));
    await q.mutate((s) => upsertWindowSnapshot(s, win('kept')));
    const persistsBeforeQuit = h.calls.filter((call) => call === 'persist:start').length;

    await q.beginQuit((s) => ({ ...removeWindowSnapshot(s, 'discarded'), cleanExit: true }));

    expect(h.disk.cleanExit).toBe(true);
    expect(h.disk.windows.map((window) => window.id)).toEqual(['kept']);
    expect(h.calls.filter((call) => call === 'persist:start')).toHaveLength(persistsBeforeQuit + 1);
  });

  it('does not publish the quit fence when final persistence fails', async () => {
    const h = makeIO();
    const q = new SessionQueue(h.io);
    h.failOncePersist();
    await expect(q.beginQuit((s) => ({ ...s, cleanExit: true }))).rejects.toThrow('disk full');
    expect(q.isQuitting()).toBe(false);
    await q.mutate((s) => upsertWindowSnapshot(s, win('w1')));
    expect(h.disk.windows.map((w) => w.id)).toEqual(['w1']);
  });

  it('isQuitting reflects a successfully persisted beginQuit', async () => {
    const h = makeIO();
    const q = new SessionQueue(h.io);
    expect(q.isQuitting()).toBe(false);
    await q.beginQuit((s) => ({ ...s, cleanExit: true }));
    expect(q.isQuitting()).toBe(true);
  });
  it('supersedes a committed quit with a durable shutdown snapshot', async () => {
    const h = makeIO();
    const q = new SessionQueue(h.io);
    await q.beginQuit((s) => ({ ...s, cleanExit: true }));
    await q.beginQuit((s) => ({ ...s, cleanExit: false, restoreReason: 'shutdown' }), { supersede: true });
    expect(h.disk).toMatchObject({ cleanExit: false, restoreReason: 'shutdown' });
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
    expect(h.disk.windows.map((w) => w.id)).not.toContain('w1');
  });
});
describe('session shutdown marker store', () => {
  it('writes filtered shutdown snapshots and its marker in one durable transaction', async () => {
    sessionStoreHarness.disk = {
      version: 2,
      windows: [win('stale-empty', '')],
    };
    sessionStoreHarness.persists = 0;
    vi.resetModules();
    const { markShutdownRestoreQueued, getSessionAggregate } = await import('../main/session-store');

    await markShutdownRestoreQueued([win('saved', 'body'), win('empty', '')]);

    expect(sessionStoreHarness.persists).toBe(1);
    await expect(getSessionAggregate()).resolves.toMatchObject({
      cleanExit: false,
      restoreReason: 'shutdown',
      windows: [{ id: 'saved', doc: 'body' }],
    });
  });
  it('supersedes a committed quit instead of silently accepting shutdown persistence', async () => {
    sessionStoreHarness.disk = { version: 2, windows: [win('saved', 'before')] };
    sessionStoreHarness.persists = 0;
    sessionStoreHarness.failPersist = false;
    vi.resetModules();
    const { markCleanExitQueued, markShutdownRestoreQueued, getSessionAggregate } = await import('../main/session-store');

    await markCleanExitQueued();
    await markShutdownRestoreQueued([win('saved', 'shutdown snapshot')]);

    expect(sessionStoreHarness.persists).toBe(2);
    await expect(getSessionAggregate()).resolves.toMatchObject({
      cleanExit: false,
      restoreReason: 'shutdown',
      windows: [{ id: 'saved', doc: 'shutdown snapshot' }],
    });
  });
  it('rejects a shutdown supersession when durable persistence fails', async () => {
    sessionStoreHarness.disk = { version: 2, windows: [win('saved', 'before')] };
    sessionStoreHarness.persists = 0;
    sessionStoreHarness.failPersist = false;
    vi.resetModules();
    const { markCleanExitQueued, markShutdownRestoreQueued, getSessionAggregate } = await import('../main/session-store');

    await markCleanExitQueued();
    sessionStoreHarness.failPersist = true;
    await expect(markShutdownRestoreQueued([win('saved', 'shutdown snapshot')])).rejects.toThrow('disk full');
    sessionStoreHarness.failPersist = false;

    await expect(getSessionAggregate()).resolves.toMatchObject({ cleanExit: true, windows: [{ id: 'saved', doc: 'before' }] });
  });
  it('removes a stale snapshot when its shutdown replacement is empty', async () => {
    sessionStoreHarness.disk = { version: 2, windows: [win('same-id', 'stale body')] };
    sessionStoreHarness.persists = 0;
    sessionStoreHarness.failPersist = false;
    vi.resetModules();
    const { markShutdownRestoreQueued, getSessionAggregate } = await import('../main/session-store');

    await markShutdownRestoreQueued([win('same-id', '')]);

    await expect(getSessionAggregate()).resolves.toMatchObject({ windows: [] });
  });
  it('clears the shutdown marker for a clean quit', async () => {
    sessionStoreHarness.disk = {
      version: 2,
      windows: [win('saved', 'body')],
      cleanExit: false,
      restoreReason: 'shutdown',
    };
    sessionStoreHarness.persists = 0;
    vi.resetModules();
    const { markCleanExitQueued, getSessionAggregate } = await import('../main/session-store');

    await markCleanExitQueued();

    expect(sessionStoreHarness.persists).toBe(1);
    await expect(getSessionAggregate()).resolves.toMatchObject({
      cleanExit: true,
      windows: [{ id: 'saved', doc: 'body' }],
    });
    expect((await getSessionAggregate()).restoreReason).toBeUndefined();
  });

  it('consumes only the marker and retains snapshots when consumption persistence fails', async () => {
    sessionStoreHarness.disk = {
      version: 2,
      windows: [win('saved', 'body')],
      cleanExit: false,
      restoreReason: 'shutdown',
    };
    sessionStoreHarness.persists = 0;
    sessionStoreHarness.failPersist = false;
    vi.resetModules();
    const { consumeShutdownRestoreMarker, getSessionAggregate } = await import('../main/session-store');

    sessionStoreHarness.failPersist = true;
    await expect(consumeShutdownRestoreMarker()).rejects.toThrow('disk full');
    sessionStoreHarness.failPersist = false;
    await expect(getSessionAggregate()).resolves.toMatchObject({
      restoreReason: 'shutdown',
      windows: [{ id: 'saved', doc: 'body' }],
    });
  });
});
