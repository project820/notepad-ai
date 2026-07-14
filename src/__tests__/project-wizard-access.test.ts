import { describe, expect, it } from 'vitest';
import { FileGrants } from '../main/file-grants';
import {
  ProjectWizardRootStore,
  resolveGrantedProjectFolder,
  revalidateGrantedProjectFolder,
  type ProjectWizardAuthorization,
} from '../main/project-wizard/access';
import type { IdentityFs } from '../main/path-identity';

const WC = 7;

type FakeNode = {
  dev: bigint;
  ino: bigint;
  kind: 'file' | 'directory' | 'other';
};

function identityFs(
  realpaths: Record<string, string>,
  initialNodes: Record<string, FakeNode>,
): IdentityFs & { replace(realpath: string, node: FakeNode): void } {
  const nodes = new Map(Object.entries(initialNodes));
  return {
    async realpath(target: string): Promise<string> {
      const resolved = realpaths[target];
      if (!resolved) throw new Error(`ENOENT: ${target}`);
      return resolved;
    },
    async stat(target: string) {
      const node = nodes.get(target);
      if (!node) throw new Error(`ENOENT stat: ${target}`);
      return {
        dev: node.dev,
        ino: node.ino,
        isFile: () => node.kind === 'file',
        isDirectory: () => node.kind === 'directory',
      };
    },
    replace(realpath, node) {
      nodes.set(realpath, node);
    },
  };
}

describe('project wizard grant access', () => {
  it('rejects an absolute project folder without a canonical workspace grant', async () => {
    const fs = identityFs(
      { '/project': '/real/project' },
      { '/real/project': { dev: 1n, ino: 1n, kind: 'directory' } },
    );

    await expect(
      resolveGrantedProjectFolder(new FileGrants(fs), WC, '/project', fs),
    ).resolves.toBeNull();
  });

  it('rejects a folder beside a directly granted file until the user grants a workspace', async () => {
    const fs = identityFs(
      {
        '/workspace/project': '/real/workspace/project',
        '/workspace/project/note.md': '/real/workspace/project/note.md',
      },
      {
        '/real/workspace/project': { dev: 2n, ino: 20n, kind: 'directory' },
        '/real/workspace/project/note.md': { dev: 2n, ino: 21n, kind: 'file' },
      },
    );
    const grants = new FileGrants(fs);
    await grants.grantExistingFile(WC, '/workspace/project/note.md', 'open-dialog');

    await expect(
      resolveGrantedProjectFolder(grants, WC, '/workspace/project', fs),
    ).resolves.toBeNull();
  });

  it('allows a project folder inside a granted canonical workspace root', async () => {
    const fs = identityFs(
      {
        '/workspace': '/real/workspace',
        '/real/workspace': '/real/workspace',
        '/workspace/project': '/real/workspace/project',
      },
      {
        '/real/workspace': { dev: 3n, ino: 30n, kind: 'directory' },
        '/real/workspace/project': { dev: 3n, ino: 31n, kind: 'directory' },
      },
    );
    const grants = new FileGrants(fs);

    const workspace = await grants.grantWorkspace(WC, '/workspace');

    expect(workspace).toEqual({
      realpath: '/real/workspace',
      identity: '3:30',
      generation: 0,
      kind: 'directory',
    });
    await expect(grants.projectWizardRoots(WC)).resolves.toEqual(['/real/workspace']);
    await expect(resolveGrantedProjectFolder(grants, WC, '/workspace/project', fs)).resolves.toEqual({
      webContentsId: WC,
      project: {
        realpath: '/real/workspace/project',
        identity: '3:31',
        kind: 'directory',
      },
      workspaceRealpath: '/real/workspace',
      workspaceIdentity: '3:30',
      fileGrantsGeneration: 0,
    });
  });
  it('rejects a released authorization after regranting the same workspace and project identities', async () => {
    const fs = identityFs(
      {
        '/workspace': '/real/workspace',
        '/real/workspace': '/real/workspace',
        '/workspace/project': '/real/workspace/project',
        '/real/workspace/project': '/real/workspace/project',
      },
      {
        '/real/workspace': { dev: 4n, ino: 40n, kind: 'directory' },
        '/real/workspace/project': { dev: 4n, ino: 41n, kind: 'directory' },
      },
    );
    const grants = new FileGrants(fs);
    await grants.grantWorkspace(WC, '/workspace');
    const staleAuthorization = await resolveGrantedProjectFolder(
      grants,
      WC,
      '/workspace/project',
      fs,
    );

    grants.release(WC);
    await grants.grantWorkspace(WC, '/real/workspace');
    const currentAuthorization = await resolveGrantedProjectFolder(
      grants,
      WC,
      '/workspace/project',
      fs,
    );

    expect(currentAuthorization).toEqual({
      ...staleAuthorization!,
      fileGrantsGeneration: 1,
    });
    await expect(
      revalidateGrantedProjectFolder(grants, staleAuthorization!, fs),
    ).resolves.toBeNull();
    await expect(
      revalidateGrantedProjectFolder(grants, currentAuthorization!, fs),
    ).resolves.toBe('/real/workspace/project');
  });
  it('rejects a start authorization after its workspace root is replaced at the same path', async () => {
    const fs = identityFs(
      {
        '/workspace': '/real/workspace',
        '/real/workspace': '/real/workspace',
        '/workspace/project': '/real/workspace/project',
      },
      {
        '/real/workspace': { dev: 4n, ino: 40n, kind: 'directory' },
        '/real/workspace/project': { dev: 4n, ino: 41n, kind: 'directory' },
      },
    );
    const grants = new FileGrants(fs);
    await grants.grantWorkspace(WC, '/workspace');
    const authorization = await resolveGrantedProjectFolder(grants, WC, '/workspace/project', fs);
    const roots = new ProjectWizardRootStore();
    const record = roots.record(WC, authorization!);

    fs.replace('/real/workspace', { dev: 4n, ino: 42n, kind: 'directory' });

    await expect(
      revalidateGrantedProjectFolder(grants, record.authorization, fs),
    ).resolves.toBeNull();
  });

  it('rejects a start authorization after the project directory is replaced at the same path', async () => {
    const fs = identityFs(
      {
        '/workspace': '/real/workspace',
        '/real/workspace': '/real/workspace',
        '/workspace/project': '/real/workspace/project',
      },
      {
        '/real/workspace': { dev: 5n, ino: 50n, kind: 'directory' },
        '/real/workspace/project': { dev: 5n, ino: 51n, kind: 'directory' },
      },
    );
    const grants = new FileGrants(fs);
    await grants.grantWorkspace(WC, '/workspace');
    const authorization = await resolveGrantedProjectFolder(grants, WC, '/workspace/project', fs);
    const roots = new ProjectWizardRootStore();
    const record = roots.record(WC, authorization!);

    fs.replace('/real/workspace/project', { dev: 5n, ino: 52n, kind: 'directory' });

    await expect(
      revalidateGrantedProjectFolder(grants, record.authorization, fs),
    ).resolves.toBeNull();
  });


  it('rejects a symlink escape even when its textual path is inside a granted workspace', async () => {
    const fs = identityFs(
      {
        '/workspace': '/real/workspace',
        '/real/workspace': '/real/workspace',
        '/workspace/escape': '/outside/project',
      },
      {
        '/real/workspace': { dev: 4n, ino: 40n, kind: 'directory' },
        '/outside/project': { dev: 4n, ino: 41n, kind: 'directory' },
      },
    );
    const grants = new FileGrants(fs);
    await grants.grantWorkspace(WC, '/workspace');

    await expect(resolveGrantedProjectFolder(grants, WC, '/workspace/escape', fs)).resolves.toBeNull();
  });

  it('fences replaced authorizations by nonce before release', () => {
    const authorizationA = {
      webContentsId: WC,
      project: {
        realpath: '/real/workspace/project-a',
        identity: '6:61' as never,
        kind: 'directory',
      },
      workspaceRealpath: '/real/workspace',
      workspaceIdentity: '6:60' as never,
      fileGrantsGeneration: 0,
    } satisfies ProjectWizardAuthorization;
    const authorizationB = {
      webContentsId: WC,
      project: {
        realpath: '/real/workspace/project-b',
        identity: '6:62' as never,
        kind: 'directory',
      },
      workspaceRealpath: '/real/workspace',
      workspaceIdentity: '6:60' as never,
      fileGrantsGeneration: 0,
    } satisfies ProjectWizardAuthorization;
    const roots = new ProjectWizardRootStore();
    const recordA = roots.record(WC, authorizationA);
    const recordB = roots.record(WC, authorizationB);

    expect(recordA.ownerGeneration).toBe(recordB.ownerGeneration);
    expect(roots.isCurrent(WC, recordA)).toBe(false);
    expect(roots.isCurrent(WC, recordB)).toBe(true);
    expect(roots.get(WC)).toBe(recordB);

    roots.release(WC);

    expect(roots.isCurrent(WC, recordB)).toBe(false);
    expect(roots.get(WC)).toBeNull();
  });
});
