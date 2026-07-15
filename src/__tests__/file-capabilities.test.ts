/**
 * file-capabilities.test.ts — per-window identity-bearing filesystem authority.
 */

import { describe, expect, it } from 'vitest';
import { FileGrants } from '../main/file-grants';
import type { CanonicalPathIdentity, IdentityFs } from '../main/path-identity';

const WC = 7;

type FakeNode = {
  dev: bigint;
  ino: bigint;
  kind: 'file' | 'directory' | 'other';
};

type FakeLookupError = 'EACCES' | 'EIO';

function filesystemError(code: 'ENOENT' | FakeLookupError, target: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${target}`), { code });
}

function makeFs(
  realpaths: Record<string, string>,
  initialNodes: Record<string, FakeNode>,
): {
  fs: IdentityFs;
  put(path: string, realpath: string, node: FakeNode): void;
  replace(realpath: string, node: FakeNode): void;
  failLookup(path: string, code: FakeLookupError): void;
  failStat(path: string, code: FakeLookupError): void;
  failLstat(path: string, code: FakeLookupError): void;
  makeDangling(path: string, node: FakeNode): void;
} {
  const paths = new Map(Object.entries(realpaths));
  const nodes = new Map(Object.entries(initialNodes));
  const lookupErrors = new Map<string, FakeLookupError>();
  const statErrors = new Map<string, FakeLookupError>();
  const lstatErrors = new Map<string, FakeLookupError>();
  const statFor = (node: FakeNode) => ({
    dev: node.dev,
    ino: node.ino,
    isFile: () => node.kind === 'file',
    isDirectory: () => node.kind === 'directory',
  });
  return {
    fs: {
      async realpath(target) {
        const lookupError = lookupErrors.get(target);
        if (lookupError) throw filesystemError(lookupError, target);
        const resolved = paths.get(target);
        if (!resolved) throw filesystemError('ENOENT', target);
        return resolved;
      },
      async stat(target) {
        const statError = statErrors.get(target);
        if (statError) throw filesystemError(statError, target);
        const node = nodes.get(target);
        if (!node) throw filesystemError('ENOENT', target);
        return statFor(node);
      },
      async lstat(target) {
        const lstatError = lstatErrors.get(target);
        if (lstatError) throw filesystemError(lstatError, target);
        const node = nodes.get(target) ?? nodes.get(paths.get(target) ?? target);
        if (!node) throw filesystemError('ENOENT', target);
        return statFor(node);
      },
    },
    put(path, realpath, node) {
      paths.set(path, realpath);
      paths.set(realpath, realpath);
      nodes.set(realpath, node);
    },
    replace(realpath, node) {
      nodes.set(realpath, node);
    },
    failLookup(path, code) {
      lookupErrors.set(path, code);
    },
    failStat(path, code) {
      statErrors.set(path, code);
    },
    failLstat(path, code) {
      lstatErrors.set(path, code);
    },
    makeDangling(path, node) {
      paths.delete(path);
      nodes.set(path, node);
    },
  };
}

describe('FileGrants — workspace grants', () => {
  it('records and authorizes the canonical workspace identity only', async () => {
    const fake = makeFs(
      {
        '/workspace': '/real/workspace',
        '/real/workspace': '/real/workspace',
      },
      {
        '/real/workspace': { dev: 1n, ino: 100n, kind: 'directory' },
      },
    );
    const grants = new FileGrants(fake.fs);

    const workspace = await grants.grantWorkspace(WC, '/workspace');

    expect(workspace).toEqual({
      realpath: '/real/workspace',
      identity: '1:100',
      kind: 'directory',
      generation: 0,
    });
    await expect(grants.authorizeWorkspace(WC, '/real/workspace')).resolves.toEqual(workspace);
    await expect(grants.authorizeWorkspace(WC, '/')).resolves.toBeNull();
    await expect(grants.projectWizardRoots(WC)).resolves.toEqual(['/real/workspace']);
  });
});

describe('FileGrants — file authority', () => {
  it('matches direct grants by canonical realpath and identity, not a hardlink alias', async () => {
    const fake = makeFs(
      {
        '/selected.md': '/real/notes/selected.md',
        '/hardlink.md': '/real/notes/hardlink.md',
      },
      {
        '/real/notes/selected.md': { dev: 2n, ino: 20n, kind: 'file' },
        '/real/notes/hardlink.md': { dev: 2n, ino: 20n, kind: 'file' },
      },
    );
    const grants = new FileGrants(fake.fs);

    const grant = await grants.grantExistingFile(WC, '/selected.md', 'open-dialog');

    expect(grant).toEqual({
      realpath: '/real/notes/selected.md',
      identity: '2:20',
      kind: 'file',
      source: 'open-dialog',
      generation: 0,
    });
    await expect(grants.authorizeExistingFile(WC, '/selected.md')).resolves.toEqual({
      scope: 'direct',
      grant,
    });
    await expect(grants.authorizeExistingFile(WC, '/hardlink.md')).resolves.toBeNull();
    await expect(grants.projectWizardRoots(WC)).resolves.toEqual([]);
  });

  it('requires main-derived enumeration before authorizing workspace children', async () => {
    const fake = makeFs(
      {
        '/workspace': '/real/workspace',
        '/real/workspace': '/real/workspace',
        '/workspace/docs/a.md': '/real/workspace/docs/a.md',
        '/outside.md': '/real/outside.md',
      },
      {
        '/real/workspace': { dev: 3n, ino: 30n, kind: 'directory' },
        '/real/workspace/docs/a.md': { dev: 3n, ino: 31n, kind: 'file' },
        '/real/outside.md': { dev: 3n, ino: 32n, kind: 'file' },
      },
    );
    const grants = new FileGrants(fake.fs);
    const workspace = await grants.grantWorkspace(WC, '/workspace');

    expect(workspace).not.toBeNull();
    await expect(grants.authorizeExistingFile(WC, '/workspace/docs/a.md')).resolves.toBeNull();
    const workspaceWrite = await grants.authorizeWriteTarget(WC, '/workspace/new.md');
    expect(workspaceWrite).toMatchObject({
      scope: 'workspace',
      canonicalTarget: '/real/workspace/new.md',
      expectedTarget: null,
      parentRealpath: '/real/workspace',
      parentIdentity: '3:30',
      workspaceRealpath: '/real/workspace',
      workspaceIdentity: '3:30',
    });
    await expect(grants.validateWriteAuthorization(workspaceWrite!)).resolves.toBe(true);

    const recorded = await grants.recordWorkspaceEnumeration(WC, workspace!, [
      '/workspace/docs/a.md',
      '/outside.md',
    ]);

    expect(recorded).toEqual([{
      realpath: '/real/workspace/docs/a.md',
      identity: '3:31',
      kind: 'file',
      source: 'workspace-enumeration',
      generation: 0,
      workspaceRealpath: '/real/workspace',
      workspaceIdentity: '3:30',
    }]);
    await expect(grants.authorizeExistingFile(WC, '/workspace/docs/a.md')).resolves.toEqual({
      scope: 'workspace-enumeration',
      grant: recorded[0],
    });
    fake.replace('/real/workspace/docs/a.md', { dev: 3n, ino: 33n, kind: 'file' });

    await expect(grants.authorizeExistingFile(WC, '/workspace/docs/a.md')).resolves.toBeNull();
    await expect(grants.authorizeWriteTarget(WC, '/workspace/docs/a.md')).resolves.toBeNull();
  });

  it('rejects a stale inode after a directly granted file is replaced', async () => {
    const fake = makeFs(
      {
        '/notes': '/real/notes',
        '/notes/a.md': '/real/notes/a.md',
        '/real/notes': '/real/notes',
        '/real/notes/a.md': '/real/notes/a.md',
      },
      {
        '/real/notes': { dev: 4n, ino: 40n, kind: 'directory' },
        '/real/notes/a.md': { dev: 4n, ino: 41n, kind: 'file' },
      },
    );
    const grants = new FileGrants(fake.fs);
    await grants.grantExistingFile(WC, '/notes/a.md', 'session-restore');
    const authorization = await grants.authorizeWriteTarget(WC, '/notes/a.md');
    expect(authorization).toMatchObject({
      scope: 'direct',
      canonicalTarget: '/real/notes/a.md',
      parentRealpath: '/real/notes',
      parentIdentity: '4:40',
      expectedTarget: {
        realpath: '/real/notes/a.md',
        identity: '4:41',
        kind: 'file',
      },
    });
    await expect(grants.validateWriteAuthorization(authorization!)).resolves.toBe(true);

    fake.replace('/real/notes/a.md', { dev: 4n, ino: 42n, kind: 'file' });
    await expect(grants.validateWriteAuthorization(authorization!)).resolves.toBe(false);

    await expect(grants.authorizeExistingFile(WC, '/notes/a.md')).resolves.toBeNull();
    await expect(grants.authorizeWriteTarget(WC, '/notes/a.md')).resolves.toBeNull();
  });

  it('rejects a save authorization before commit when its authorized parent is replaced', async () => {
    const fake = makeFs(
      {
        '/exports': '/real/exports',
        '/real/exports': '/real/exports',
      },
      {
        '/real/exports': { dev: 5n, ino: 50n, kind: 'directory' },
      },
    );
    const grants = new FileGrants(fake.fs);

    await grants.grantSaveTarget(WC, '/exports/new.md');
    const authorization = await grants.authorizeWriteTarget(WC, '/exports/new.md');

    expect(authorization?.expectedTarget).toBeNull();
    fake.replace('/real/exports', { dev: 5n, ino: 51n, kind: 'directory' });

    await expect(grants.validateWriteAuthorization(authorization!)).resolves.toBe(false);
  });
  it('rejects workspace writes after parent or root replacement and enforces root containment', async () => {
    const fake = makeFs(
      {
        '/workspace': '/real/workspace',
        '/real/workspace': '/real/workspace',
        '/workspace/docs': '/real/workspace/docs',
        '/real/workspace/docs': '/real/workspace/docs',
        '/real/outside': '/real/outside',
      },
      {
        '/real/workspace': { dev: 5n, ino: 50n, kind: 'directory' },
        '/real/workspace/docs': { dev: 5n, ino: 51n, kind: 'directory' },
        '/real/outside': { dev: 5n, ino: 50n, kind: 'directory' },
      },
    );
    const grants = new FileGrants(fake.fs);
    await grants.grantWorkspace(WC, '/workspace');
    const authorization = await grants.authorizeWriteTarget(WC, '/workspace/docs/new.md');

    expect(authorization).toMatchObject({
      scope: 'workspace',
      canonicalTarget: '/real/workspace/docs/new.md',
      parentRealpath: '/real/workspace/docs',
      parentIdentity: '5:51',
      workspaceRealpath: '/real/workspace',
      workspaceIdentity: '5:50',
    });
    await expect(grants.validateWriteAuthorization(authorization!)).resolves.toBe(true);

    const outsideAuthorization = {
      ...authorization!,
      canonicalTarget: '/real/outside/new.md',
      parentRealpath: '/real/outside',
    };
    await expect(grants.validateWriteAuthorization(outsideAuthorization)).resolves.toBe(false);

    fake.replace('/real/workspace/docs', { dev: 5n, ino: 52n, kind: 'directory' });
    await expect(grants.validateWriteAuthorization(authorization!)).resolves.toBe(false);

    fake.replace('/real/workspace/docs', { dev: 5n, ino: 51n, kind: 'directory' });
    fake.replace('/real/workspace', { dev: 5n, ino: 53n, kind: 'directory' });
    await expect(grants.validateWriteAuthorization(authorization!)).resolves.toBe(false);
  });
  it('accepts a new save target only after lstat verifies true absence', async () => {
    const fake = makeFs(
      {
        '/exports': '/real/exports',
        '/real/exports': '/real/exports',
      },
      {
        '/real/exports': { dev: 5n, ino: 50n, kind: 'directory' },
      },
    );
    const grants = new FileGrants(fake.fs);

    const grant = await grants.grantSaveTarget(WC, '/exports/new.md');
    const authorization = await grants.authorizeWriteTarget(WC, '/exports/new.md');

    expect(grant).toMatchObject({
      canonicalPath: '/real/exports/new.md',
      expectedTarget: null,
    });
    await expect(grants.validateWriteAuthorization(authorization!)).resolves.toBe(true);
  });
  it.each(['EACCES', 'EIO'] as const)(
    'treats an %s lstat failure as unverified absence at grant and validation',
    async (code) => {
      const fake = makeFs(
        {
          '/exports': '/real/exports',
          '/real/exports': '/real/exports',
        },
        {
          '/real/exports': { dev: 5n, ino: 50n, kind: 'directory' },
        },
      );
      fake.failLstat('/real/exports/new.md', code);
      const grants = new FileGrants(fake.fs);

      await expect(grants.grantSaveTarget(WC, '/exports/new.md')).resolves.toBeNull();

      const validFake = makeFs(
        {
          '/exports': '/real/exports',
          '/real/exports': '/real/exports',
        },
        {
          '/real/exports': { dev: 5n, ino: 50n, kind: 'directory' },
        },
      );
      const validGrants = new FileGrants(validFake.fs);
      await validGrants.grantSaveTarget(WC, '/exports/new.md');
      const authorization = await validGrants.authorizeWriteTarget(WC, '/exports/new.md');
      validFake.failLstat('/real/exports/new.md', code);

      await expect(validGrants.validateWriteAuthorization(authorization!)).resolves.toBe(false);

      const authorizationFake = makeFs(
        {
          '/exports': '/real/exports',
          '/real/exports': '/real/exports',
        },
        {
          '/real/exports': { dev: 5n, ino: 50n, kind: 'directory' },
        },
      );
      const authorizationGrants = new FileGrants(authorizationFake.fs);
      await authorizationGrants.grantSaveTarget(WC, '/exports/new.md');
      authorizationFake.failLstat('/real/exports/new.md', code);

      await expect(authorizationGrants.authorizeWriteTarget(WC, '/exports/new.md')).resolves.toBeNull();
    },
  );

  it.each(['EACCES', 'EIO'] as const)(
    'fails closed for %s identity stat errors on target, parent, and workspace root',
    async (code) => {
      const targetFake = makeFs(
        {
          '/exports': '/real/exports',
          '/real/exports': '/real/exports',
          '/exports/existing.md': '/real/exports/existing.md',
          '/real/exports/existing.md': '/real/exports/existing.md',
        },
        {
          '/real/exports': { dev: 5n, ino: 50n, kind: 'directory' },
          '/real/exports/existing.md': { dev: 5n, ino: 51n, kind: 'file' },
        },
      );
      targetFake.failStat('/real/exports/existing.md', code);
      await expect(new FileGrants(targetFake.fs).grantSaveTarget(WC, '/exports/existing.md')).resolves.toBeNull();

      const targetAuthorizationFake = makeFs(
        {
          '/exports': '/real/exports',
          '/real/exports': '/real/exports',
          '/exports/existing.md': '/real/exports/existing.md',
          '/real/exports/existing.md': '/real/exports/existing.md',
        },
        {
          '/real/exports': { dev: 5n, ino: 50n, kind: 'directory' },
          '/real/exports/existing.md': { dev: 5n, ino: 51n, kind: 'file' },
        },
      );
      const targetAuthorizationGrants = new FileGrants(targetAuthorizationFake.fs);
      await targetAuthorizationGrants.grantSaveTarget(WC, '/exports/existing.md');
      targetAuthorizationFake.failStat('/real/exports/existing.md', code);

      await expect(
        targetAuthorizationGrants.authorizeWriteTarget(WC, '/exports/existing.md'),
      ).resolves.toBeNull();

      const parentFake = makeFs(
        {
          '/exports': '/real/exports',
          '/real/exports': '/real/exports',
        },
        {
          '/real/exports': { dev: 5n, ino: 50n, kind: 'directory' },
        },
      );
      parentFake.failStat('/real/exports', code);
      await expect(new FileGrants(parentFake.fs).grantSaveTarget(WC, '/exports/new.md')).resolves.toBeNull();

      const parentAuthorizationFake = makeFs(
        {
          '/exports': '/real/exports',
          '/real/exports': '/real/exports',
        },
        {
          '/real/exports': { dev: 5n, ino: 50n, kind: 'directory' },
        },
      );
      const parentAuthorizationGrants = new FileGrants(parentAuthorizationFake.fs);
      await parentAuthorizationGrants.grantSaveTarget(WC, '/exports/new.md');
      parentAuthorizationFake.failStat('/real/exports', code);

      await expect(parentAuthorizationGrants.authorizeWriteTarget(WC, '/exports/new.md')).resolves.toBeNull();

      const workspaceFake = makeFs(
        {
          '/workspace': '/real/workspace',
          '/real/workspace': '/real/workspace',
        },
        {
          '/real/workspace': { dev: 5n, ino: 60n, kind: 'directory' },
        },
      );
      const workspaceGrants = new FileGrants(workspaceFake.fs);
      await workspaceGrants.grantWorkspace(WC, '/workspace');
      workspaceFake.failStat('/real/workspace', code);

      await expect(workspaceGrants.authorizeWriteTarget(WC, '/workspace/new.md')).resolves.toBeNull();

      const targetValidationFake = makeFs(
        {
          '/exports': '/real/exports',
          '/real/exports': '/real/exports',
          '/exports/existing.md': '/real/exports/existing.md',
          '/real/exports/existing.md': '/real/exports/existing.md',
        },
        {
          '/real/exports': { dev: 5n, ino: 50n, kind: 'directory' },
          '/real/exports/existing.md': { dev: 5n, ino: 51n, kind: 'file' },
        },
      );
      const targetValidationGrants = new FileGrants(targetValidationFake.fs);
      await targetValidationGrants.grantSaveTarget(WC, '/exports/existing.md');
      const targetAuthorization = await targetValidationGrants.authorizeWriteTarget(WC, '/exports/existing.md');
      targetValidationFake.failStat('/real/exports/existing.md', code);

      await expect(targetValidationGrants.validateWriteAuthorization(targetAuthorization!)).resolves.toBe(false);

      const parentValidationFake = makeFs(
        {
          '/exports': '/real/exports',
          '/real/exports': '/real/exports',
        },
        {
          '/real/exports': { dev: 5n, ino: 50n, kind: 'directory' },
        },
      );
      const parentValidationGrants = new FileGrants(parentValidationFake.fs);
      await parentValidationGrants.grantSaveTarget(WC, '/exports/new.md');
      const parentAuthorization = await parentValidationGrants.authorizeWriteTarget(WC, '/exports/new.md');
      parentValidationFake.failStat('/real/exports', code);

      await expect(parentValidationGrants.validateWriteAuthorization(parentAuthorization!)).resolves.toBe(false);

      const workspaceValidationFake = makeFs(
        {
          '/workspace': '/real/workspace',
          '/real/workspace': '/real/workspace',
          '/workspace/docs': '/real/workspace/docs',
          '/real/workspace/docs': '/real/workspace/docs',
        },
        {
          '/real/workspace': { dev: 5n, ino: 60n, kind: 'directory' },
          '/real/workspace/docs': { dev: 5n, ino: 61n, kind: 'directory' },
        },
      );
      const workspaceValidationGrants = new FileGrants(workspaceValidationFake.fs);
      await workspaceValidationGrants.grantWorkspace(WC, '/workspace');
      const workspaceAuthorization = await workspaceValidationGrants.authorizeWriteTarget(
        WC,
        '/workspace/docs/new.md',
      );
      workspaceValidationFake.failStat('/real/workspace', code);

      await expect(workspaceValidationGrants.validateWriteAuthorization(workspaceAuthorization!)).resolves.toBe(
        false,
      );
    },
  );

  for (const targetFailure of [
    {
      name: 'EACCES',
      apply: (fake: ReturnType<typeof makeFs>, target: string) => fake.failLookup(target, 'EACCES'),
    },
    {
      name: 'EIO',
      apply: (fake: ReturnType<typeof makeFs>, target: string) => fake.failLookup(target, 'EIO'),
    },
    {
      name: 'a dangling final symlink',
      apply: (fake: ReturnType<typeof makeFs>, target: string) => fake.makeDangling(target, {
        dev: 5n,
        ino: 51n,
        kind: 'other',
      }),
    },
  ]) {
    it(`fails closed for ${targetFailure.name} while granting a save target`, async () => {
      const fake = makeFs(
        {
          '/exports': '/real/exports',
          '/real/exports': '/real/exports',
        },
        {
          '/real/exports': { dev: 5n, ino: 50n, kind: 'directory' },
        },
      );
      targetFailure.apply(fake, '/real/exports/new.md');
      const grants = new FileGrants(fake.fs);

      await expect(grants.grantSaveTarget(WC, '/exports/new.md')).resolves.toBeNull();
    });

    it(`fails closed for ${targetFailure.name} before writing a save target`, async () => {
      const fake = makeFs(
        {
          '/exports': '/real/exports',
          '/real/exports': '/real/exports',
        },
        {
          '/real/exports': { dev: 5n, ino: 50n, kind: 'directory' },
        },
      );
      const grants = new FileGrants(fake.fs);
      await grants.grantSaveTarget(WC, '/exports/new.md');
      const authorization = await grants.authorizeWriteTarget(WC, '/exports/new.md');

      targetFailure.apply(fake, '/real/exports/new.md');

      await expect(grants.validateWriteAuthorization(authorization!)).resolves.toBe(false);
    });

    it(`fails closed for ${targetFailure.name} before renaming a prepared save target`, async () => {
      const fake = makeFs(
        {
          '/exports': '/real/exports',
          '/real/exports': '/real/exports',
        },
        {
          '/real/exports': { dev: 5n, ino: 50n, kind: 'directory' },
        },
      );
      const grants = new FileGrants(fake.fs);
      await grants.grantSaveTarget(WC, '/exports/new.md');
      const authorization = await grants.authorizeWriteTarget(WC, '/exports/new.md');

      await expect(grants.validateWriteAuthorization(authorization!)).resolves.toBe(true);
      targetFailure.apply(fake, '/real/exports/new.md');

      await expect(grants.validateWriteAuthorization(authorization!)).resolves.toBe(false);
    });
  }

  it('rejects a save authorization before commit when a new target appears', async () => {
    const fake = makeFs(
      {
        '/exports': '/real/exports',
        '/real/exports': '/real/exports',
      },
      {
        '/real/exports': { dev: 5n, ino: 50n, kind: 'directory' },
      },
    );
    const grants = new FileGrants(fake.fs);

    await grants.grantSaveTarget(WC, '/exports/new.md');
    const authorization = await grants.authorizeWriteTarget(WC, '/exports/new.md');

    expect(authorization?.expectedTarget).toBeNull();
    fake.put('/exports/new.md', '/real/exports/new.md', {
      dev: 5n,
      ino: 51n,
      kind: 'file',
    });

    await expect(grants.validateWriteAuthorization(authorization!)).resolves.toBe(false);
  });

  it('consumes a new save target after commit so a later inode replacement is denied', async () => {
    const fake = makeFs(
      {
        '/exports': '/real/exports',
        '/real/exports': '/real/exports',
      },
      {
        '/real/exports': { dev: 5n, ino: 50n, kind: 'directory' },
      },
    );
    const grants = new FileGrants(fake.fs);

    const saveTarget = await grants.grantSaveTarget(WC, '/exports/new.md');

    expect(saveTarget).toMatchObject({
      kind: 'save-target',
      canonicalPath: '/real/exports/new.md',
      parentRealpath: '/real/exports',
      parentIdentity: '5:50',
      expectedTarget: null,
    });
    const authorization = await grants.authorizeWriteTarget(WC, '/exports/new.md');
    expect(authorization).toMatchObject({
      scope: 'save-target',
      canonicalTarget: '/real/exports/new.md',
      parentRealpath: '/real/exports',
      parentIdentity: '5:50',
      expectedTarget: null,
    });
    await expect(grants.validateWriteAuthorization(authorization!)).resolves.toBe(true);

    fake.put('/exports/new.md', '/real/exports/new.md', {
      dev: 5n,
      ino: 51n,
      kind: 'file',
    });
    const preparedTemp: CanonicalPathIdentity = {
      realpath: '/real/exports/.new.md.tmp',
      identity: '5:51' as CanonicalPathIdentity['identity'],
      kind: 'file',
    };
    const committed = grants.commitSavedFile(WC, authorization!, preparedTemp);

    expect(committed).toMatchObject({
      realpath: '/real/exports/new.md',
      identity: '5:51',
      kind: 'file',
      source: 'atomic-save',
    });
    await expect(grants.validateWriteAuthorization(authorization!)).resolves.toBe(false);

    const committedAuthorization = await grants.authorizeWriteTarget(WC, '/exports/new.md');

    expect(committedAuthorization).toMatchObject({
      scope: 'direct',
      canonicalTarget: '/real/exports/new.md',
      parentRealpath: '/real/exports',
      parentIdentity: '5:50',
      expectedTarget: {
        realpath: '/real/exports/new.md',
        identity: '5:51',
        kind: 'file',
      },
    });
    await expect(grants.validateWriteAuthorization(committedAuthorization!)).resolves.toBe(true);
    fake.replace('/real/exports/new.md', { dev: 5n, ino: 52n, kind: 'file' });

    await expect(grants.authorizeWriteTarget(WC, '/exports/new.md')).resolves.toBeNull();
  });

  it('does not leak grants to another window', async () => {
    const fake = makeFs(
      {
        '/': '/',
        '/workspace': '/real/workspace',
        '/note.md': '/real/note.md',
      },
      {
        '/': { dev: 6n, ino: 59n, kind: 'directory' },
        '/real/workspace': { dev: 6n, ino: 60n, kind: 'directory' },
        '/real/note.md': { dev: 6n, ino: 61n, kind: 'file' },
      },
    );
    const grants = new FileGrants(fake.fs);
    await grants.grantWorkspace(WC, '/workspace');
    await grants.grantExistingFile(WC, '/note.md', 'os-open');

    await expect(grants.authorizeWorkspace(9, '/workspace')).resolves.toBeNull();
    await expect(grants.authorizeExistingFile(9, '/note.md')).resolves.toBeNull();
    await expect(grants.authorizeWriteTarget(9, '/note.md')).resolves.toBeNull();
  });

  it('release drops workspace, file, and save-target authority', async () => {
    const fake = makeFs(
      {
        '/workspace': '/real/workspace',
        '/note.md': '/real/note.md',
        '/exports': '/real/exports',
      },
      {
        '/real/workspace': { dev: 7n, ino: 70n, kind: 'directory' },
        '/real/note.md': { dev: 7n, ino: 71n, kind: 'file' },
        '/real/exports': { dev: 7n, ino: 72n, kind: 'directory' },
      },
    );
    const grants = new FileGrants(fake.fs);
    await grants.grantWorkspace(WC, '/workspace');
    await grants.grantExistingFile(WC, '/note.md', 'conversion');
    await grants.grantSaveTarget(WC, '/exports/new.md');

    grants.release(WC);

    await expect(grants.authorizeWorkspace(WC, '/workspace')).resolves.toBeNull();
    await expect(grants.authorizeExistingFile(WC, '/note.md')).resolves.toBeNull();
    await expect(grants.authorizeWriteTarget(WC, '/exports/new.md')).resolves.toBeNull();
    await expect(grants.projectWizardRoots(WC)).resolves.toEqual([]);
  });
  it('fences a pending grant and a commit after release', async () => {
    const fake = makeFs(
      {
        '/notes/a.md': '/real/notes/a.md',
        '/real/notes': '/real/notes',
        '/real/notes/a.md': '/real/notes/a.md',
      },
      {
        '/real/notes/a.md': { dev: 8n, ino: 80n, kind: 'file' },
        '/real/notes': { dev: 8n, ino: 79n, kind: 'directory' },
      },
    );
    let unblockRealpath: (() => void) | null = null;
    let signalPendingRealpath!: () => void;
    let blockFirstDirectGrant = true;
    const pendingRealpathReached = new Promise<void>((resolve) => {
      signalPendingRealpath = resolve;
    });
    const originalRealpath = fake.fs.realpath;
    fake.fs.realpath = async (target) => {
      if (target === '/notes/a.md' && blockFirstDirectGrant) {
        blockFirstDirectGrant = false;
        signalPendingRealpath();
        await new Promise<void>((resolve) => {
          unblockRealpath = resolve;
        });
      }
      return originalRealpath(target);
    };
    const grants = new FileGrants(fake.fs);

    const pendingGrant = grants.grantExistingFile(WC, '/notes/a.md', 'open-dialog');
    await pendingRealpathReached;
    grants.release(WC);
    const currentGrant = await grants.grantExistingFile(WC, '/notes/a.md', 'open-dialog');
    const currentAuthorization = await grants.authorizeExistingFile(WC, '/notes/a.md');
    unblockRealpath!();

    await expect(pendingGrant).resolves.toBeNull();
    fake.fs.realpath = originalRealpath;
    expect(currentGrant).toMatchObject({ generation: 1 });
    expect(currentAuthorization).toEqual({ scope: 'direct', grant: currentGrant });
    await expect(grants.authorizeExistingFile(WC, '/notes/a.md')).resolves.toEqual({
      scope: 'direct',
      grant: currentGrant,
    });

    const authorization = await grants.authorizeWriteTarget(WC, '/notes/a.md');
    grants.release(WC);

    const committed = grants.commitSavedFile(WC, authorization!, {
      realpath: '/real/notes/.a.md.tmp',
      identity: '8:81' as CanonicalPathIdentity['identity'],
      kind: 'file',
    });

    expect(committed).toBeNull();
    await expect(grants.authorizeExistingFile(WC, '/notes/a.md')).resolves.toBeNull();
  });
  it('fences a deferred workspace grant after WC ID reuse', async () => {
    const fake = makeFs(
      {
        '/workspace': '/real/workspace',
        '/real/workspace': '/real/workspace',
      },
      {
        '/real/workspace': { dev: 11n, ino: 110n, kind: 'directory' },
      },
    );
    let unblockRealpath: (() => void) | null = null;
    let signalPendingRealpath!: () => void;
    let blockFirstWorkspaceGrant = true;
    const pendingRealpathReached = new Promise<void>((resolve) => {
      signalPendingRealpath = resolve;
    });
    const originalRealpath = fake.fs.realpath;
    fake.fs.realpath = async (target) => {
      if (target === '/workspace' && blockFirstWorkspaceGrant) {
        blockFirstWorkspaceGrant = false;
        signalPendingRealpath();
        await new Promise<void>((resolve) => {
          unblockRealpath = resolve;
        });
      }
      return originalRealpath(target);
    };
    const grants = new FileGrants(fake.fs);

    const pendingGrant = grants.grantWorkspace(WC, '/workspace');
    await pendingRealpathReached;
    grants.release(WC);
    const currentGrant = await grants.grantWorkspace(WC, '/workspace');
    unblockRealpath!();

    await expect(pendingGrant).resolves.toBeNull();
    fake.fs.realpath = originalRealpath;
    expect(currentGrant).toMatchObject({ generation: 1 });
    await expect(grants.authorizeWorkspace(WC, '/workspace')).resolves.toEqual(currentGrant);
    await expect(grants.projectWizardRoots(WC)).resolves.toEqual(['/real/workspace']);
  });
  it('fences a deferred save-target grant after WC ID reuse', async () => {
    const fake = makeFs(
      {
        '/exports': '/real/exports',
        '/real/exports': '/real/exports',
      },
      {
        '/real/exports': { dev: 12n, ino: 120n, kind: 'directory' },
      },
    );
    let unblockRealpath: (() => void) | null = null;
    let signalPendingRealpath!: () => void;
    let blockFirstSaveGrant = true;
    const pendingRealpathReached = new Promise<void>((resolve) => {
      signalPendingRealpath = resolve;
    });
    const originalRealpath = fake.fs.realpath;
    fake.fs.realpath = async (target) => {
      if (target === '/exports' && blockFirstSaveGrant) {
        blockFirstSaveGrant = false;
        signalPendingRealpath();
        await new Promise<void>((resolve) => {
          unblockRealpath = resolve;
        });
      }
      return originalRealpath(target);
    };
    const grants = new FileGrants(fake.fs);

    const pendingGrant = grants.grantSaveTarget(WC, '/exports/new.md');
    await pendingRealpathReached;
    grants.release(WC);
    const currentGrant = await grants.grantSaveTarget(WC, '/exports/new.md');
    const currentAuthorization = await grants.authorizeWriteTarget(WC, '/exports/new.md');
    unblockRealpath!();

    await expect(pendingGrant).resolves.toBeNull();
    fake.fs.realpath = originalRealpath;
    expect(currentGrant).toMatchObject({ generation: 1 });
    expect(currentAuthorization).toMatchObject({
      scope: 'save-target',
      generation: 1,
      saveTargetToken: currentGrant?.token,
    });
    await expect(grants.authorizeWriteTarget(WC, '/exports/new.md')).resolves.toEqual(
      currentAuthorization,
    );
  });
  it('fences a deferred workspace enumeration after WC ID reuse', async () => {
    const fake = makeFs(
      {
        '/workspace': '/real/workspace',
        '/real/workspace': '/real/workspace',
        '/workspace/docs/a.md': '/real/workspace/docs/a.md',
      },
      {
        '/real/workspace': { dev: 13n, ino: 130n, kind: 'directory' },
        '/real/workspace/docs/a.md': { dev: 13n, ino: 131n, kind: 'file' },
      },
    );
    let unblockRealpath: (() => void) | null = null;
    let signalPendingRealpath!: () => void;
    let blockFirstEnumeration = true;
    const pendingRealpathReached = new Promise<void>((resolve) => {
      signalPendingRealpath = resolve;
    });
    const originalRealpath = fake.fs.realpath;
    fake.fs.realpath = async (target) => {
      if (target === '/workspace/docs/a.md' && blockFirstEnumeration) {
        blockFirstEnumeration = false;
        signalPendingRealpath();
        await new Promise<void>((resolve) => {
          unblockRealpath = resolve;
        });
      }
      return originalRealpath(target);
    };
    const grants = new FileGrants(fake.fs);
    const generationZeroWorkspace = await grants.grantWorkspace(WC, '/workspace');

    const pendingEnumeration = grants.recordWorkspaceEnumeration(WC, generationZeroWorkspace!, [
      '/workspace/docs/a.md',
    ]);
    await pendingRealpathReached;
    grants.release(WC);
    const generationOneWorkspace = await grants.grantWorkspace(WC, '/workspace');
    const currentEnumeration = await grants.recordWorkspaceEnumeration(WC, generationOneWorkspace!, [
      '/workspace/docs/a.md',
    ]);
    const currentAuthorization = await grants.authorizeExistingFile(WC, '/workspace/docs/a.md');
    unblockRealpath!();

    await expect(pendingEnumeration).resolves.toEqual([]);
    fake.fs.realpath = originalRealpath;
    expect(generationOneWorkspace).toMatchObject({ generation: 1 });
    expect(currentEnumeration).toHaveLength(1);
    expect(currentEnumeration[0]).toMatchObject({ generation: 1 });
    expect(currentAuthorization).toEqual({
      scope: 'workspace-enumeration',
      grant: currentEnumeration[0],
    });
    await expect(grants.authorizeExistingFile(WC, '/workspace/docs/a.md')).resolves.toEqual(
      currentAuthorization,
    );
  });

  it('does not resurrect generation-zero direct or save authority after WC ID reuse', async () => {
    const fake = makeFs(
      {
        '/notes/a.md': '/real/notes/a.md',
        '/real/notes': '/real/notes',
        '/real/notes/a.md': '/real/notes/a.md',
        '/exports': '/real/exports',
        '/real/exports': '/real/exports',
      },
      {
        '/real/notes': { dev: 10n, ino: 100n, kind: 'directory' },
        '/real/notes/a.md': { dev: 10n, ino: 101n, kind: 'file' },
        '/real/exports': { dev: 10n, ino: 102n, kind: 'directory' },
      },
    );
    const grants = new FileGrants(fake.fs);

    const generationZeroDirectGrant = await grants.grantExistingFile(WC, '/notes/a.md', 'open-dialog');
    const generationZeroDirectAuthorization = await grants.authorizeWriteTarget(WC, '/notes/a.md');
    const generationZeroSaveGrant = await grants.grantSaveTarget(WC, '/exports/new.md');
    const generationZeroSaveAuthorization = await grants.authorizeWriteTarget(WC, '/exports/new.md');

    expect(generationZeroDirectGrant).toMatchObject({ generation: 0 });
    expect(generationZeroSaveGrant).toMatchObject({ generation: 0 });
    await expect(grants.validateWriteAuthorization(generationZeroDirectAuthorization!)).resolves.toBe(true);
    await expect(grants.validateWriteAuthorization(generationZeroSaveAuthorization!)).resolves.toBe(true);

    grants.release(WC);

    const generationOneDirectGrant = await grants.grantExistingFile(WC, '/notes/a.md', 'open-dialog');
    const generationOneDirectAuthorization = await grants.authorizeWriteTarget(WC, '/notes/a.md');
    const generationOneSaveGrant = await grants.grantSaveTarget(WC, '/exports/new.md');
    const generationOneSaveAuthorization = await grants.authorizeWriteTarget(WC, '/exports/new.md');

    expect(generationOneDirectGrant).toMatchObject({ generation: 1 });
    expect(generationOneSaveGrant).toMatchObject({ generation: 1 });
    expect(generationZeroSaveGrant?.token).not.toBe(generationOneSaveGrant?.token);

    await expect(grants.validateWriteAuthorization(generationZeroDirectAuthorization!)).resolves.toBe(false);
    expect(grants.commitSavedFile(WC, generationZeroDirectAuthorization!, {
      realpath: '/real/notes/.a.md.tmp',
      identity: '10:103' as CanonicalPathIdentity['identity'],
      kind: 'file',
    })).toBeNull();
    await expect(grants.validateWriteAuthorization(generationZeroSaveAuthorization!)).resolves.toBe(false);
    expect(grants.commitSavedFile(WC, generationZeroSaveAuthorization!, {
      realpath: '/real/exports/.new.md.tmp',
      identity: '10:104' as CanonicalPathIdentity['identity'],
      kind: 'file',
    })).toBeNull();

    await expect(grants.authorizeExistingFile(WC, '/notes/a.md')).resolves.toEqual({
      scope: 'direct',
      grant: generationOneDirectGrant,
    });
    await expect(grants.validateWriteAuthorization(generationOneDirectAuthorization!)).resolves.toBe(true);
    await expect(grants.validateWriteAuthorization(generationOneSaveAuthorization!)).resolves.toBe(true);
  });
  it('requires the live save-target token for validation and commit', async () => {
    const fake = makeFs(
      {
        '/exports': '/real/exports',
        '/real/exports': '/real/exports',
      },
      {
        '/real/exports': { dev: 9n, ino: 90n, kind: 'directory' },
      },
    );
    const grants = new FileGrants(fake.fs);

    const firstGrant = await grants.grantSaveTarget(WC, '/exports/new.md');
    const firstAuthorization = await grants.authorizeWriteTarget(WC, '/exports/new.md');
    const replacementGrant = await grants.grantSaveTarget(WC, '/exports/new.md');
    const replacementAuthorization = await grants.authorizeWriteTarget(WC, '/exports/new.md');

    expect(firstGrant?.token).not.toBe(replacementGrant?.token);
    await expect(grants.validateWriteAuthorization(firstAuthorization!)).resolves.toBe(false);
    expect(grants.commitSavedFile(WC, firstAuthorization!, {
      realpath: '/real/exports/.new.md.tmp',
      identity: '9:91' as CanonicalPathIdentity['identity'],
      kind: 'file',
    })).toBeNull();
    await expect(grants.validateWriteAuthorization(replacementAuthorization!)).resolves.toBe(true);
    expect(grants.commitSavedFile(WC, replacementAuthorization!, {
      realpath: '/real/exports/.new.md.tmp',
      identity: '9:92' as CanonicalPathIdentity['identity'],
      kind: 'file',
    })).toMatchObject({
      realpath: '/real/exports/new.md',
      identity: '9:92',
      source: 'atomic-save',
    });
    await expect(grants.validateWriteAuthorization(replacementAuthorization!)).resolves.toBe(false);
  });
});
