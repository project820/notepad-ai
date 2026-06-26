import { describe, it, expect } from 'vitest';
import { atomicWrite, type AtomicWriteBackend } from '../main/atomic-write';

/**
 * In-memory fake `AtomicWriteBackend`. Records the operation order, every
 * `writeFile` (path/data/mode), each `randomId` it hands out, and which paths
 * were unlinked, while modelling temp-file -> target commit purely in a Map.
 */
function fakeBackend(
  opts: {
    failWriteFile?: boolean;
    failRename?: boolean;
    failFsyncDir?: boolean;
    omitFsyncDir?: boolean;
  } = {},
) {
  const files = new Map<string, string | Buffer>();
  const calls: string[] = [];
  const writes: Array<{ tmp: string; data: string | Buffer; mode: number }> = [];
  const ids: string[] = [];
  const unlinked: string[] = [];
  let counter = 0;

  const backend: AtomicWriteBackend = {
    async mkdir(_dir: string): Promise<void> {
      calls.push('mkdir');
    },
    async writeFile(tmp: string, data: string | Buffer, mode: number): Promise<void> {
      calls.push('writeFile');
      if (opts.failWriteFile) throw new Error('writeFile failed: disk full');
      writes.push({ tmp, data, mode });
      files.set(tmp, data);
    },
    async rename(tmp: string, target: string): Promise<void> {
      calls.push('rename');
      if (opts.failRename) throw new Error('rename failed');
      const data = files.get(tmp);
      if (data === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      files.delete(tmp);
      files.set(target, data);
    },
    async unlink(p: string): Promise<void> {
      calls.push('unlink');
      unlinked.push(p);
      files.delete(p);
    },
    async fsyncFile(_p: string): Promise<void> {
      calls.push('fsyncFile');
    },
    randomId(): string {
      const id = `id${counter++}`;
      ids.push(id);
      return id;
    },
  };

  if (!opts.omitFsyncDir) {
    backend.fsyncDir = async (_dir: string): Promise<void> => {
      calls.push('fsyncDir');
      if (opts.failFsyncDir) throw new Error('fsyncDir failed');
    };
  }

  return { backend, files, calls, writes, ids, unlinked };
}

describe('atomicWrite', () => {
  // (a) randomId — not a fixed PID/timestamp — drives the temp name, so two
  // writes in the same instant can never select the same temp path.
  it('uses a unique temp filename per write so same-instant writes never collide', async () => {
    const { backend, writes, ids, files } = fakeBackend();

    await atomicWrite('/data/session.json', 'first', { backend });
    await atomicWrite('/data/session.json', 'second', { backend });

    expect(ids).toEqual(['id0', 'id1']); // randomId called once per write
    expect(writes[0].tmp).toBe('/data/session.json.id0.tmp');
    expect(writes[1].tmp).toBe('/data/session.json.id1.tmp');
    expect(writes[0].tmp).not.toBe(writes[1].tmp);
    expect([...files.keys()]).toEqual(['/data/session.json']); // no temp leftover
  });

  // (b) ordering contract.
  it('calls the backend in mkdir -> writeFile -> fsyncFile -> rename -> fsyncDir order', async () => {
    const { backend, calls } = fakeBackend();

    await atomicWrite('/data/keys.json', 'payload', { backend });

    expect(calls).toEqual(['mkdir', 'writeFile', 'fsyncFile', 'rename', 'fsyncDir']);
  });

  // (c) permission bits.
  it('requests 0o600 file mode by default and honours an explicit mode', async () => {
    const a = fakeBackend();
    await atomicWrite('/data/keys.json', 'x', { backend: a.backend });
    expect(a.writes[0].mode).toBe(0o600);

    const b = fakeBackend();
    await atomicWrite('/data/keys.json', 'x', { backend: b.backend, mode: 0o644 });
    expect(b.writes[0].mode).toBe(0o644);
  });

  // (d) writeFile failure: target untouched, temp unlinked, error rethrown.
  it('preserves the previous target, unlinks the temp, and rethrows when writeFile fails', async () => {
    const { backend, files, calls, unlinked } = fakeBackend({ failWriteFile: true });
    files.set('/data/session.json', 'previous'); // pre-existing good copy

    await expect(atomicWrite('/data/session.json', 'new', { backend })).rejects.toThrow(
      'disk full',
    );

    expect(files.get('/data/session.json')).toBe('previous'); // untouched
    expect(unlinked).toEqual(['/data/session.json.id0.tmp']); // temp cleaned up
    expect(calls).not.toContain('rename'); // never reached the commit
  });

  // (e) happy path: rename commits the final data to the target.
  it('commits the final data to the target after a successful rename', async () => {
    const { backend, files } = fakeBackend();

    await atomicWrite('/data/session.json', 'committed-content', { backend });

    expect(files.get('/data/session.json')).toBe('committed-content');
    expect([...files.keys()]).toEqual(['/data/session.json']); // temp renamed away
  });

  // (f) rename failure also rolls back the temp and preserves the target.
  it('cleans up the temp file and preserves the target when rename fails', async () => {
    const { backend, files, unlinked } = fakeBackend({ failRename: true });
    files.set('/data/session.json', 'previous');

    await expect(atomicWrite('/data/session.json', 'new', { backend })).rejects.toThrow(
      'rename failed',
    );

    expect(files.get('/data/session.json')).toBe('previous'); // preserved
    expect(unlinked).toEqual(['/data/session.json.id0.tmp']); // temp removed
    expect(files.has('/data/session.json.id0.tmp')).toBe(false);
  });

  // (g) fsyncDir is optional and best-effort: absence or failure never aborts
  // an already-committed write.
  it('still commits when fsyncDir is absent or fails (best-effort durability)', async () => {
    const a = fakeBackend({ omitFsyncDir: true });
    await atomicWrite('/data/session.json', 'data-a', { backend: a.backend });
    expect(a.files.get('/data/session.json')).toBe('data-a');
    expect(a.calls).toEqual(['mkdir', 'writeFile', 'fsyncFile', 'rename']); // no fsyncDir step

    const b = fakeBackend({ failFsyncDir: true });
    await expect(
      atomicWrite('/data/session.json', 'data-b', { backend: b.backend }),
    ).resolves.toBeUndefined();
    expect(b.files.get('/data/session.json')).toBe('data-b'); // committed despite fsync error
  });
});
