import type { FileGrants } from '../file-grants';
import { isRealpathWithinRoot, type IdentityFs } from '../path-identity';

/** Resolve an existing project folder only when it is inside this window's grants. */
export async function resolveGrantedProjectFolder(
  fileGrants: FileGrants,
  wcId: number,
  projectFolder: string,
  fs: IdentityFs,
): Promise<string | null> {
  for (const root of fileGrants.projectWizardRoots(wcId)) {
    if (await isRealpathWithinRoot(root, projectFolder, fs)) {
      try {
        return await fs.realpath(projectFolder);
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Main-process state tying an approved-draft save to the folder authorized at start. */
export class ProjectWizardRootStore {
  private roots = new Map<number, string>();

  record(wcId: number, canonicalRoot: string): void {
    this.roots.set(wcId, canonicalRoot);
  }

  get(wcId: number): string | null {
    return this.roots.get(wcId) ?? null;
  }

  release(wcId: number): void {
    this.roots.delete(wcId);
  }
}
