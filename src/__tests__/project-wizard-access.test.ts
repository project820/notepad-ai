import { describe, expect, it } from 'vitest';
import { FileGrants } from '../main/file-grants';
import { ProjectWizardRootStore, resolveGrantedProjectFolder } from '../main/project-wizard/access';
import type { IdentityFs } from '../main/path-identity';

const WC = 7;

function identityFs(realpaths: Record<string, string>): IdentityFs {
  return {
    async realpath(target: string): Promise<string> {
      const resolved = realpaths[target];
      if (!resolved) throw new Error(`ENOENT: ${target}`);
      return resolved;
    },
    async stat() {
      return { dev: 1, ino: 1 };
    },
  };
}

describe('project wizard grant access', () => {
  it('rejects an absolute project folder without a grant', async () => {
    await expect(
      resolveGrantedProjectFolder(new FileGrants(), WC, '/project', identityFs({ '/project': '/project' })),
    ).resolves.toBeNull();
  });

  it('rejects a folder beside a directly granted file until the user grants a workspace', async () => {
    const grants = new FileGrants();
    grants.grantFile(WC, '/workspace/project/note.md');

    await expect(
      resolveGrantedProjectFolder(
        grants,
        WC,
        '/workspace/project',
        identityFs({ '/workspace/project': '/workspace/project' }),
      ),
    ).resolves.toBeNull();
  });
  it('allows a project folder inside a granted workspace and returns its canonical root', async () => {
    const grants = new FileGrants();
    grants.grantWorkspace(WC, '/workspace');
    const fs = identityFs({
      '/workspace': '/real/workspace',
      '/workspace/project': '/real/workspace/project',
    });

    await expect(resolveGrantedProjectFolder(grants, WC, '/workspace/project', fs)).resolves.toBe(
      '/real/workspace/project',
    );
  });

  it('rejects a symlink escape even when its textual path is inside a granted workspace', async () => {
    const grants = new FileGrants();
    grants.grantWorkspace(WC, '/workspace');
    const fs = identityFs({
      '/workspace': '/real/workspace',
      '/workspace/escape': '/outside/project',
    });

    await expect(resolveGrantedProjectFolder(grants, WC, '/workspace/escape', fs)).resolves.toBeNull();
  });

  it('uses the canonical root recorded at start instead of a save payload path', () => {
    const roots = new ProjectWizardRootStore();
    roots.record(WC, '/real/workspace/project');

    expect(roots.get(WC)).toBe('/real/workspace/project');
    expect(roots.get(WC)).not.toBe('/attacker/replacement');
  });
});
