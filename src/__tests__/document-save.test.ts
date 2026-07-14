import { describe, expect, it, vi } from 'vitest';
import { saveDocumentAtomically } from '../main/document-save';
import type {
  DescriptorAtomicWriteBackend,
  ExclusiveTempFileHandle,
} from '../main/atomic-write';

type FileNode = {
  data: string;
  mode: number;
  identity: { dev: bigint; ino: bigint };
};

type FakeBackend = {
  backend: DescriptorAtomicWriteBackend;
  handles: ExclusiveTempFileHandle[];
  handleOperations: Array<{ name: string; handle: ExclusiveTempFileHandle }>;
  nodeAt(path: string): FileNode | undefined;
  replacePath(path: string, data: string, mode: number): void;
};

function fakeBackend(
  files: Map<string, string>,
  calls: string[],
  opts: {
    failOpen?: Error;
    failClose?: Error;
    failWrite?: Error;
    failSync?: Error;
    failStat?: Error;
    failRename?: Error;
    modes?: Map<string, number>;
  } = {},
): FakeBackend {
  const paths = new Map<string, FileNode>();
  const handles: ExclusiveTempFileHandle[] = [];
  const handleOperations: Array<{ name: string; handle: ExclusiveTempFileHandle }> = [];
  let nextIno = 1n;

  const makeNode = (data: string, mode: number): FileNode => ({
    data,
    mode,
    identity: { dev: 1n, ino: nextIno++ },
  });
  const publish = (path: string, node: FileNode): void => {
    paths.set(path, node);
    files.set(path, node.data);
    opts.modes?.set(path, node.mode);
  };
  const remove = (path: string): void => {
    paths.delete(path);
    files.delete(path);
    opts.modes?.delete(path);
  };

  for (const [path, data] of files) {
    paths.set(path, makeNode(data, opts.modes?.get(path) ?? 0));
  }

  const backend: DescriptorAtomicWriteBackend = {
    async mkdir() {
      calls.push('mkdir');
    },
    async writeFile(_tmp, _data, _mode) {
      throw new Error('legacy path write must not be used');
    },
    async fsyncFile(_tmp) {
      throw new Error('legacy path fsync must not be used');
    },
    async rename(from, target) {
      calls.push('rename');
      if (opts.failRename) throw opts.failRename;
      const node = paths.get(from);
      if (!node) throw new Error('missing temporary path');
      remove(from);
      publish(target, node);
    },
    async unlink(path) {
      calls.push('unlink');
      remove(path);
    },
    async openExclusiveTemp(tmp, mode) {
      calls.push(`openExclusiveTemp:${mode.toString(8)}`);
      if (opts.failOpen) throw opts.failOpen;
      const node = makeNode('', mode);
      publish(tmp, node);
      let handle: ExclusiveTempFileHandle;
      handle = {
        async writeFile(data) {
          calls.push('handle.writeFile');
          handleOperations.push({ name: 'writeFile', handle });
          if (opts.failWrite) throw opts.failWrite;
          node.data = String(data);
          if (paths.get(tmp) === node) files.set(tmp, node.data);
        },
        async sync() {
          calls.push('handle.sync');
          handleOperations.push({ name: 'sync', handle });
          if (opts.failSync) throw opts.failSync;
        },
        async stat() {
          calls.push('handle.stat');
          handleOperations.push({ name: 'stat', handle });
          if (opts.failStat) throw opts.failStat;
          return node.identity;
        },
        async close() {
          calls.push('handle.close');
          if (opts.failClose) throw opts.failClose;
          handleOperations.push({ name: 'close', handle });
        },
      };
      handles.push(handle);
      return handle;
    },
    randomId() {
      return 'tmp';
    },
  };

  return {
    backend,
    handles,
    handleOperations,
    nodeAt(path) {
      return paths.get(path);
    },
    replacePath(path, data, mode) {
      publish(path, makeNode(data, mode));
    },
  };
}

describe('saveDocumentAtomically', () => {
  it('preserves the existing document when descriptor writing fails', async () => {
    const files = new Map([['/docs/note.md', 'old']]);
    const calls: string[] = [];
    const failure = new Error('disk full');
    const fake = fakeBackend(files, calls, { failWrite: failure });

    await expect(
      saveDocumentAtomically('/docs/note.md', 'new', {
        fs: { async stat() { return { mode: 0o640 }; } },
        backend: fake.backend,
      }),
    ).rejects.toBe(failure);

    expect(calls).toEqual([
      'openExclusiveTemp:640',
      'handle.writeFile',
      'handle.close',
      'unlink',
    ]);
    expect(files.get('/docs/note.md')).toBe('old');
    expect(files.has('/docs/note.md.tmp.tmp')).toBe(false);
  });

  it('commits documents through rename, preserves an existing mode, and uses one descriptor', async () => {
    const files = new Map([['/docs/note.md', 'old']]);
    const modes = new Map([['/docs/note.md', 0o640]]);
    const calls: string[] = [];
    const fake = fakeBackend(files, calls, { modes });

    await saveDocumentAtomically('/docs/note.md', 'new', {
      fs: { async stat() { return { mode: modes.get('/docs/note.md') ?? 0 }; } },
      backend: fake.backend,
    });

    expect(calls).toEqual([
      'openExclusiveTemp:640',
      'handle.writeFile',
      'handle.sync',
      'handle.stat',
      'rename',
      'handle.close',
    ]);
    expect(files.get('/docs/note.md')).toBe('new');
    expect(modes.get('/docs/note.md')).toBe(0o640);
    expect(fake.handles).toHaveLength(1);
    expect(fake.handleOperations.map(({ name }) => name)).toEqual(['writeFile', 'sync', 'stat', 'close']);
    expect(new Set(fake.handleOperations.map(({ handle }) => handle)).size).toBe(1);
  });

  it('runs beforeWrite before exclusive creation and beforeRename after descriptor stat', async () => {
    const files = new Map([['/docs/note.md', 'old']]);
    const calls: string[] = [];
    const fake = fakeBackend(files, calls);

    await saveDocumentAtomically('/docs/note.md', 'new', {
      fs: { async stat() { return { mode: 0o640 }; } },
      backend: fake.backend,
      async beforeWrite() {
        calls.push('beforeWrite');
      },
      async beforeRename(temp) {
        calls.push('beforeRename');
        expect(temp.path).toBe('/docs/note.md.tmp.tmp');
        expect(temp.identity).toEqual(fake.nodeAt(temp.path)?.identity);
        expect(fake.nodeAt(temp.path)?.data).toBe('new');
      },
    });

    expect(calls).toEqual([
      'beforeWrite',
      'openExclusiveTemp:640',
      'handle.writeFile',
      'handle.sync',
      'handle.stat',
      'beforeRename',
      'rename',
      'handle.close',
    ]);
  });

  it('unlinks a swapped temporary pathname and preserves the prior target when beforeRename rejects', async () => {
    const files = new Map([['/docs/note.md', 'old']]);
    const modes = new Map([['/docs/note.md', 0o640]]);
    const calls: string[] = [];
    const failure = new Error('authorization denied');
    const fake = fakeBackend(files, calls, { modes });
    let tempPath = '';

    await expect(
      saveDocumentAtomically('/docs/note.md', 'new', {
        fs: { async stat() { return { mode: modes.get('/docs/note.md') ?? 0 }; } },
        backend: fake.backend,
        async beforeRename(temp) {
          calls.push('beforeRename');
          tempPath = temp.path;
          expect(temp.identity).toEqual(fake.nodeAt(temp.path)?.identity);
          fake.replacePath(temp.path, 'attacker bytes', 0o600);
          calls.push('swapTempPath');
          expect(fake.nodeAt(temp.path)?.identity).not.toEqual(temp.identity);
          throw failure;
        },
      }),
    ).rejects.toBe(failure);

    expect(calls).toEqual([
      'openExclusiveTemp:640',
      'handle.writeFile',
      'handle.sync',
      'handle.stat',
      'beforeRename',
      'swapTempPath',
      'handle.close',
      'unlink',
    ]);
    expect(files.get('/docs/note.md')).toBe('old');
    expect(modes.get('/docs/note.md')).toBe(0o640);
    expect(files.has(tempPath)).toBe(false);
    expect(modes.has(tempPath)).toBe(false);
  });

  it('closes and unlinks a completed temporary file when descriptor sync fails', async () => {
    const files = new Map([['/docs/note.md', 'old']]);
    const modes = new Map([['/docs/note.md', 0o640]]);
    const calls: string[] = [];
    const failure = new Error('fsync failure');
    const fake = fakeBackend(files, calls, { failSync: failure, modes });

    await expect(
      saveDocumentAtomically('/docs/note.md', 'new', {
        fs: { async stat() { return { mode: modes.get('/docs/note.md') ?? 0 }; } },
        backend: fake.backend,
      }),
    ).rejects.toBe(failure);

    expect(calls).toEqual([
      'openExclusiveTemp:640',
      'handle.writeFile',
      'handle.sync',
      'handle.close',
      'unlink',
    ]);
    expect(files.get('/docs/note.md')).toBe('old');
    expect(modes.get('/docs/note.md')).toBe(0o640);
    expect(files.has('/docs/note.md.tmp.tmp')).toBe(false);
    expect(modes.has('/docs/note.md.tmp.tmp')).toBe(false);
  });

  it('closes and unlinks a completed temporary file when descriptor stat fails', async () => {
    const files = new Map([['/docs/note.md', 'old']]);
    const modes = new Map([['/docs/note.md', 0o640]]);
    const calls: string[] = [];
    const failure = new Error('stat failure');
    const fake = fakeBackend(files, calls, { failStat: failure, modes });

    await expect(
      saveDocumentAtomically('/docs/note.md', 'new', {
        fs: { async stat() { return { mode: modes.get('/docs/note.md') ?? 0 }; } },
        backend: fake.backend,
      }),
    ).rejects.toBe(failure);

    expect(calls).toEqual([
      'openExclusiveTemp:640',
      'handle.writeFile',
      'handle.sync',
      'handle.stat',
      'handle.close',
      'unlink',
    ]);
    expect(files.get('/docs/note.md')).toBe('old');
    expect(modes.get('/docs/note.md')).toBe(0o640);
    expect(files.has('/docs/note.md.tmp.tmp')).toBe(false);
    expect(modes.has('/docs/note.md.tmp.tmp')).toBe(false);
  });

  it('closes and unlinks a completed temporary file when rename fails', async () => {
    const files = new Map([['/docs/note.md', 'old']]);
    const modes = new Map([['/docs/note.md', 0o640]]);
    const calls: string[] = [];
    const failure = new Error('rename failure');
    const fake = fakeBackend(files, calls, { failRename: failure, modes });

    await expect(
      saveDocumentAtomically('/docs/note.md', 'new', {
        fs: { async stat() { return { mode: modes.get('/docs/note.md') ?? 0 }; } },
        backend: fake.backend,
      }),
    ).rejects.toBe(failure);

    expect(calls).toEqual([
      'openExclusiveTemp:640',
      'handle.writeFile',
      'handle.sync',
      'handle.stat',
      'rename',
      'handle.close',
      'unlink',
    ]);
    expect(files.get('/docs/note.md')).toBe('old');
    expect(modes.get('/docs/note.md')).toBe(0o640);
    expect(files.has('/docs/note.md.tmp.tmp')).toBe(false);
    expect(modes.has('/docs/note.md.tmp.tmp')).toBe(false);
  });
  it('does not unlink a temp pathname that this invocation never created', async () => {
    const files = new Map([['/docs/note.md', 'old']]);
    const beforeWriteCalls: string[] = [];
    const beforeWriteFake = fakeBackend(files, beforeWriteCalls);
    const denied = new Error('authorization denied');

    await expect(saveDocumentAtomically('/docs/note.md', 'new', {
      fs: { async stat() { return { mode: 0o640 }; } },
      backend: beforeWriteFake.backend,
      async beforeWrite() {
        beforeWriteCalls.push('beforeWrite');
        throw denied;
      },
    })).rejects.toBe(denied);
    expect(beforeWriteCalls).toEqual(['beforeWrite']);

    const openCalls: string[] = [];
    const openFailure = new Error('exclusive open failed');
    const openFake = fakeBackend(files, openCalls, { failOpen: openFailure });
    await expect(saveDocumentAtomically('/docs/note.md', 'new', {
      fs: { async stat() { return { mode: 0o640 }; } },
      backend: openFake.backend,
    })).rejects.toBe(openFailure);
    expect(openCalls).toEqual(['openExclusiveTemp:640']);
    expect(files.get('/docs/note.md')).toBe('old');
  });

  it('keeps a successful rename committed when descriptor close later fails', async () => {
    const files = new Map([['/docs/note.md', 'old']]);
    const calls: string[] = [];
    const closeFailure = new Error('close failed');
    const fake = fakeBackend(files, calls, { failClose: closeFailure });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(saveDocumentAtomically('/docs/note.md', 'new', {
      fs: { async stat() { return { mode: 0o640 }; } },
      backend: fake.backend,
    })).resolves.toBeUndefined();

    expect(files.get('/docs/note.md')).toBe('new');
    expect(warn).toHaveBeenCalledWith('[atomic-write] post-rename descriptor close failed');
    warn.mockRestore();
  });

  it('uses mode 0o644 for a new document', async () => {
    const files = new Map<string, string>();
    const calls: string[] = [];
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const fake = fakeBackend(files, calls);

    await saveDocumentAtomically('/docs/new.md', 'new', {
      fs: { async stat() { throw missing; } },
      backend: fake.backend,
    });

    expect(calls).toContain('openExclusiveTemp:644');
  });
});