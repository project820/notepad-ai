import { describe, expect, it, vi } from 'vitest';

const ipc = vi.hoisted(() => {
  type Handler = (event: any, ...args: any[]) => unknown;
  const handlers = new Map<string, Handler>();
  return {
    handleTrusted: (channel: string, handler: Handler) => handlers.set(channel, handler),
    handler: (channel: string) => handlers.get(channel),
    reset: () => handlers.clear(),
  };
});

vi.mock('../main/ipc-guard', () => ({ handleTrusted: ipc.handleTrusted }));
vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  shell: { openPath: vi.fn() },
}));

import { FileGrants } from '../main/file-grants';
import { registerFileIpc } from '../main/ipc/file-ipc';
import type { IdentityFs } from '../main/path-identity';
import { WindowRegistry, type WindowRecord } from '../main/window-registry';

const WEB_CONTENTS_ID = 701;
const REQUESTED_TARGET = '/save-authority/new.md';
const CANONICAL_PARENT = '/canonical/save-authority';
const CANONICAL_TARGET = `${CANONICAL_PARENT}/new.md`;
const PRIOR_PATH = '/canonical/prior.md';
const TEMPORARY_PATH = `${CANONICAL_TARGET}.atomic-save.tmp`;

type FakeNode = {
  dev: bigint;
  ino: bigint;
  kind: 'file' | 'directory';
};

type TemporaryObjectAudit = {
  path: string | null;
  written: FakeNode | null;
  fsynced: FakeNode | null;
  validated: FakeNode[];
  renameAttempt: { sourcePath: string; targetPath: string; node: FakeNode } | null;
  renamed: FakeNode | null;
  unlinked: string[];
};

function identityFor(node: FakeNode): string {
  return `${node.dev}:${node.ino}`;
}

function makeIdentityFs(): {
  fs: IdentityFs;
  temporary: TemporaryObjectAudit;
  put(path: string, realpath: string, node: FakeNode): void;
  replace(path: string, node: FakeNode): void;
  redirect(path: string, realpath: string): void;
  move(sourcePath: string, targetPath: string): FakeNode;
  nodeAt(path: string): FakeNode | null;
  trackTemporary(path: string): void;
  unlink(path: string): void;
} {
  const paths = new Map<string, string>([
    ['/save-authority', CANONICAL_PARENT],
    [CANONICAL_PARENT, CANONICAL_PARENT],
  ]);
  const nodes = new Map<string, FakeNode>([
    [CANONICAL_PARENT, { dev: 7n, ino: 70n, kind: 'directory' }],
  ]);
  const temporary: TemporaryObjectAudit = {
    path: null,
    written: null,
    fsynced: null,
    validated: [],
    renameAttempt: null,
    renamed: null,
    unlinked: [],
  };
  const nodeAt = (path: string): FakeNode | null => {
    const realpath = paths.get(path);
    return realpath ? nodes.get(realpath) ?? null : null;
  };
  return {
    fs: {
      async realpath(target) {
        const resolved = paths.get(target);
        if (!resolved) throw Object.assign(new Error(`ENOENT: ${target}`), { code: 'ENOENT' });
        return resolved;
      },
      async stat(target) {
        const node = nodes.get(target);
        if (!node) throw Object.assign(new Error(`ENOENT stat: ${target}`), { code: 'ENOENT' });
        if (target === temporary.path) temporary.validated.push(node);
        return {
          dev: node.dev,
          ino: node.ino,
          isFile: () => node.kind === 'file',
          isDirectory: () => node.kind === 'directory',
        };
      },
      async lstat(target) {
        const resolved = paths.get(target);
        const node = resolved ? nodes.get(resolved) : null;
        if (!node) throw Object.assign(new Error(`ENOENT lstat: ${target}`), { code: 'ENOENT' });
        return {
          dev: node.dev,
          ino: node.ino,
          isFile: () => node.kind === 'file',
          isDirectory: () => node.kind === 'directory',
        };
      },
    },
    temporary,
    put(path, realpath, node) {
      paths.set(path, realpath);
      paths.set(realpath, realpath);
      nodes.set(realpath, node);
    },
    replace(path, node) {
      const realpath = paths.get(path) ?? path;
      paths.set(path, realpath);
      paths.set(realpath, realpath);
      nodes.set(realpath, node);
    },
    redirect(path, realpath) {
      paths.set(path, realpath);
    },
    move(sourcePath, targetPath) {
      const sourceRealpath = paths.get(sourcePath);
      const node = sourceRealpath ? nodes.get(sourceRealpath) : null;
      if (!sourceRealpath || !node) throw new Error(`ENOENT rename: ${sourcePath}`);
      temporary.renameAttempt = { sourcePath, targetPath, node };
      paths.delete(sourcePath);
      if (sourceRealpath === sourcePath) paths.delete(sourceRealpath);
      nodes.delete(sourceRealpath);
      paths.set(targetPath, targetPath);
      nodes.set(targetPath, node);
      temporary.renamed = node;
      return node;
    },
    nodeAt,
    trackTemporary(path) {
      temporary.path = path;
    },
    unlink(path) {
      const realpath = paths.get(path);
      paths.delete(path);
      if (realpath === path) paths.delete(realpath);
      if (realpath) nodes.delete(realpath);
      temporary.unlinked.push(path);
    },
  };
}

async function createHarness(options: {
  mutateBeforeFirstValidation?: (identityFs: ReturnType<typeof makeIdentityFs>) => void;
  mutateBetweenValidations?: (identityFs: ReturnType<typeof makeIdentityFs>) => void;
  replaceTempAfterValidation?: (identityFs: ReturnType<typeof makeIdentityFs>, tempPath: string) => void;
  aliasTempAfterValidation?: (identityFs: ReturnType<typeof makeIdentityFs>, tempPath: string) => void;
  rejectRename?: boolean;
  releaseBeforeCommit?: boolean;
} = {}) {
  ipc.reset();
  const identityFs = makeIdentityFs();
  const fileGrants = new FileGrants(identityFs.fs);
  await fileGrants.grantSaveTarget(WEB_CONTENTS_ID, REQUESTED_TARGET);

  const registry = new WindowRegistry();
  const record: WindowRecord = {
    windowId: 71,
    webContentsId: WEB_CONTENTS_ID,
    windowKey: 'save-authority-window',
    currentPath: PRIOR_PATH,
    lastFocusedAt: 0,
    ready: true,
    pendingOutbound: [],
  };
  registry.register(record);
  const restorePathClaim = vi.spyOn(registry, 'restorePathClaim');
  const events: string[] = [];
  const backend = {
    mkdir: vi.fn(async (_dir: string) => {
      events.push('mkdir');
    }),
    writeFile: vi.fn(async () => {
      throw new Error('obsolete path write');
    }),
    fsyncFile: vi.fn(async () => {
      throw new Error('obsolete path fsync');
    }),
    openExclusiveTemp: vi.fn(async (tempPath: string, _mode: number) => {
      events.push('open');
      const node = { dev: 7n, ino: 71n, kind: 'file' as const };
      identityFs.trackTemporary(tempPath);
      identityFs.put(tempPath, tempPath, node);
      return {
        writeFile: async (_content: string | Buffer) => {
          events.push('write');
          identityFs.temporary.written = node;
        },
        sync: async () => {
          events.push('fsync');
          if (identityFs.nodeAt(tempPath) !== node) throw new Error('fsync-wrong-temp');
          identityFs.temporary.fsynced = node;
          options.mutateBetweenValidations?.(identityFs);
        },
        stat: async () => {
          events.push('fstat');
          return { dev: node.dev, ino: node.ino };
        },
        close: async () => {
          events.push('close');
        },
      };
    }),
    rename: vi.fn(async (tempPath: string, targetPath: string) => {
      events.push('rename');
      const node = identityFs.nodeAt(tempPath);
      if (tempPath !== identityFs.temporary.path || !node) throw new Error('rename-wrong-temp');
      identityFs.temporary.renameAttempt = { sourcePath: tempPath, targetPath, node };
      if (options.rejectRename) throw new Error('rename-rejected');
      identityFs.move(tempPath, targetPath);
    }),
    unlink: vi.fn(async (tempPath: string) => {
      events.push('unlink');
      identityFs.unlink(tempPath);
    }),
    randomId: vi.fn(() => 'atomic-save'),
  };
  let validationCount = 0;
  const originalValidate = fileGrants.validateWriteAuthorization.bind(fileGrants);
  const validateWriteAuthorization = vi.spyOn(fileGrants, 'validateWriteAuthorization').mockImplementation(async (authorization) => {
    events.push('validate');
    validationCount += 1;
    const valid = await originalValidate(authorization);
    if (valid && validationCount === 2) {
      options.replaceTempAfterValidation?.(identityFs, TEMPORARY_PATH);
      options.aliasTempAfterValidation?.(identityFs, TEMPORARY_PATH);
    }
    return valid;
  });
  const originalCommit = fileGrants.commitSavedFile.bind(fileGrants);
  const commitSavedFile = vi.spyOn(fileGrants, 'commitSavedFile').mockImplementation((webContentsId, authorization, preparedTempIdentity) => {
    events.push('commit');
    if (options.releaseBeforeCommit) fileGrants.release(webContentsId);
    return originalCommit(webContentsId, authorization, preparedTempIdentity);
  });

  registerFileIpc({
    registry,
    fileGrants,
    identityFs: identityFs.fs,
    saveMutex: {
      async run(_key, task) {
        options.mutateBeforeFirstValidation?.(identityFs);
        return task();
      },
    },
    backend,
    windowFromRecord: () => null,
    openFilePath: async () => {},
  });

  const save = ipc.handler('file:save');
  if (!save) throw new Error('file:save handler was not registered');
  return {
    backend,
    commitSavedFile,
    events,
    fileGrants,
    identityFs,
    record,
    restorePathClaim,
    save: () => save({ sender: { id: WEB_CONTENTS_ID } }, { filePath: REQUESTED_TARGET, content: 'saved document' }),
    validateWriteAuthorization,
  };
}

describe('file:save authority validation', () => {
  it('rejects a parent authority replacement before any temporary write and restores the prior claim', async () => {
    const harness = await createHarness({
      mutateBeforeFirstValidation: (identityFs) => {
        identityFs.replace(CANONICAL_PARENT, { dev: 7n, ino: 72n, kind: 'directory' });
      },
    });

    await expect(harness.save()).resolves.toEqual({ saved: false, error: 'not-authorized' });

    expect(harness.validateWriteAuthorization).toHaveBeenCalledTimes(1);
    expect(harness.backend.openExclusiveTemp).not.toHaveBeenCalled();
    expect(harness.backend.rename).not.toHaveBeenCalled();
    expect(harness.commitSavedFile).not.toHaveBeenCalled();
    expect(harness.record.currentPath).toBe(PRIOR_PATH);
    expect(harness.restorePathClaim).toHaveBeenCalledWith(harness.record.windowId, PRIOR_PATH);
  });

  it('rejects a target authority change after the temporary write but before rename and restores the prior claim', async () => {
    const harness = await createHarness({
      mutateBetweenValidations: (identityFs) => {
        identityFs.put(CANONICAL_TARGET, CANONICAL_TARGET, { dev: 7n, ino: 72n, kind: 'file' });
      },
    });

    await expect(harness.save()).resolves.toEqual({ saved: false, error: 'not-authorized' });

    expect(harness.validateWriteAuthorization).toHaveBeenCalledTimes(2);
    expect(harness.backend.openExclusiveTemp).toHaveBeenCalledOnce();
    expect(harness.backend.rename).not.toHaveBeenCalled();
    expect(harness.commitSavedFile).not.toHaveBeenCalled();
    expect(harness.record.currentPath).toBe(PRIOR_PATH);
    expect(harness.restorePathClaim).toHaveBeenCalledWith(harness.record.windowId, PRIOR_PATH);
  });

  it('uses one exact temporary object through fsync, validation, rename, and commit', async () => {
    const harness = await createHarness();

    await expect(harness.save()).resolves.toEqual({ saved: true, filePath: CANONICAL_TARGET });

    const written = harness.identityFs.temporary.written;
    if (!written) throw new Error('the fake backend did not create a temporary object');

    expect(harness.validateWriteAuthorization).toHaveBeenCalledTimes(2);
    expect(harness.backend.mkdir).not.toHaveBeenCalled();
    expect(harness.backend.randomId).toHaveBeenCalledOnce();
    expect(harness.backend.randomId).toHaveBeenCalledWith();
    expect(harness.backend.openExclusiveTemp).toHaveBeenCalledOnce();
    expect(harness.backend.openExclusiveTemp).toHaveBeenCalledWith(TEMPORARY_PATH, 0o644);
    expect(harness.backend.rename).toHaveBeenCalledOnce();
    expect(harness.backend.rename).toHaveBeenCalledWith(TEMPORARY_PATH, CANONICAL_TARGET);
    expect(harness.backend.unlink).not.toHaveBeenCalled();
    expect(harness.identityFs.temporary.path).toBe(TEMPORARY_PATH);
    expect(harness.identityFs.temporary.fsynced).toBe(written);
    expect(harness.identityFs.temporary.validated).toHaveLength(1);
    expect(harness.identityFs.temporary.validated[0]).toBe(written);
    expect(harness.identityFs.temporary.renameAttempt).toEqual({
      sourcePath: TEMPORARY_PATH,
      targetPath: CANONICAL_TARGET,
      node: written,
    });
    expect(harness.identityFs.temporary.renamed).toBe(written);
    expect(harness.identityFs.nodeAt(CANONICAL_TARGET)).toBe(written);
    expect(harness.commitSavedFile).toHaveBeenCalledOnce();
    expect(harness.commitSavedFile).toHaveBeenCalledWith(
      WEB_CONTENTS_ID,
      expect.objectContaining({ canonicalTarget: CANONICAL_TARGET }),
      { realpath: TEMPORARY_PATH, identity: identityFor(written), kind: 'file' },
    );
    expect(harness.events).toEqual(['validate', 'open', 'write', 'fsync', 'fstat', 'validate', 'rename', 'close', 'commit']);
    expect(harness.record.currentPath).toBe(CANONICAL_TARGET);
  });
  it('reports a committed save when authority is released after rename', async () => {
    const harness = await createHarness({ releaseBeforeCommit: true });

    await expect(harness.save()).resolves.toEqual({ saved: true, filePath: CANONICAL_TARGET });

    expect(harness.identityFs.temporary.renamed).not.toBeNull();
    expect(harness.identityFs.nodeAt(CANONICAL_TARGET)).toBe(harness.identityFs.temporary.renamed);
    expect(harness.commitSavedFile).toHaveBeenCalledOnce();
    expect(harness.restorePathClaim).not.toHaveBeenCalled();
    expect(harness.record.currentPath).toBe(CANONICAL_TARGET);
  });
  it('rejects a symlink alias to the prepared inode after pre-rename validation', async () => {
    const harness = await createHarness({
      aliasTempAfterValidation: (identityFs, tempPath) => {
        const prepared = identityFs.nodeAt(tempPath);
        if (!prepared) throw new Error('missing prepared temp');
        const aliasTarget = `${tempPath}.alias-target`;
        identityFs.put(aliasTarget, aliasTarget, prepared);
        identityFs.redirect(tempPath, aliasTarget);
      },
    });

    await expect(harness.save()).resolves.toEqual({ saved: false, error: 'write-failed' });

    expect(harness.backend.rename).not.toHaveBeenCalled();
    expect(harness.commitSavedFile).not.toHaveBeenCalled();
    expect(harness.identityFs.nodeAt(CANONICAL_TARGET)).toBeNull();
  });

  it('does not grant authority to a temporary object replaced after pre-rename validation', async () => {
    const replacement = { dev: 7n, ino: 72n, kind: 'file' as const };
    const harness = await createHarness({
      replaceTempAfterValidation: (identityFs, tempPath) => {
        identityFs.replace(tempPath, replacement);
      },
    });

    await expect(harness.save()).resolves.toEqual({ saved: false, error: 'write-failed' });

    const written = harness.identityFs.temporary.written;
    if (!written) throw new Error('the fake backend did not create a temporary object');

    expect(harness.identityFs.temporary.fsynced).toBe(written);
    expect(harness.identityFs.temporary.validated).toHaveLength(1);
    expect(harness.identityFs.temporary.validated[0]).toBe(replacement);
    expect(harness.identityFs.temporary.renamed).toBeNull();
    expect(harness.backend.rename).not.toHaveBeenCalled();
    expect(harness.commitSavedFile).not.toHaveBeenCalled();
    expect(harness.identityFs.nodeAt(CANONICAL_TARGET)).toBeNull();
    expect(harness.identityFs.temporary.unlinked).toEqual([TEMPORARY_PATH]);
  });

  it('rejects a rename failure after pre-rename validation without committing and restores the prior claim', async () => {
    const harness = await createHarness({ rejectRename: true });

    await expect(harness.save()).resolves.toEqual({ saved: false, error: 'rename-rejected' });

    const written = harness.identityFs.temporary.written;
    if (!written) throw new Error('the fake backend did not create a temporary object');

    expect(harness.validateWriteAuthorization).toHaveBeenCalledTimes(2);
    expect(harness.backend.rename).toHaveBeenCalledWith(TEMPORARY_PATH, CANONICAL_TARGET);
    expect(harness.backend.unlink).toHaveBeenCalledWith(TEMPORARY_PATH);
    expect(harness.identityFs.temporary.fsynced).toBe(written);
    expect(harness.identityFs.temporary.validated).toHaveLength(1);
    expect(harness.identityFs.temporary.validated[0]).toBe(written);
    expect(harness.identityFs.temporary.renamed).toBeNull();
    expect(harness.identityFs.temporary.unlinked).toEqual([TEMPORARY_PATH]);
    expect(harness.identityFs.nodeAt(TEMPORARY_PATH)).toBeNull();
    expect(harness.commitSavedFile).not.toHaveBeenCalled();
    expect(harness.events).toEqual(['validate', 'open', 'write', 'fsync', 'fstat', 'validate', 'rename', 'close', 'unlink']);
    expect(harness.record.currentPath).toBe(PRIOR_PATH);
    expect(harness.restorePathClaim).toHaveBeenCalledWith(harness.record.windowId, PRIOR_PATH);
  });
});
