import type { FileGrants } from '../file-grants';
import {
  canonicalIdentity,
  isCanonicalPathWithinRoot,
  type CanonicalPathIdentity,
  type FileIdentity,
  type IdentityFs,
} from '../path-identity';

export interface ProjectWizardAuthorization {
  readonly webContentsId: number;
  readonly project: CanonicalPathIdentity;
  readonly workspaceRealpath: string;
  readonly workspaceIdentity: FileIdentity;
  readonly fileGrantsGeneration: number;
}

export interface ProjectWizardRootRecord {
  readonly authorization: ProjectWizardAuthorization;
  readonly ownerGeneration: number;
  readonly nonce: number;
}

/** Resolve an existing project folder only when it is inside this window's grants. */
export async function resolveGrantedProjectFolder(
  fileGrants: FileGrants,
  wcId: number,
  projectFolder: string,
  fs: IdentityFs,
): Promise<ProjectWizardAuthorization | null> {
  const project = await canonicalIdentity(projectFolder, fs);
  if (!project || project.kind !== 'directory') return null;

  for (const root of await fileGrants.projectWizardRoots(wcId)) {
    const workspace = await fileGrants.authorizeWorkspace(wcId, root);
    if (workspace && isCanonicalPathWithinRoot(workspace.realpath, project.realpath)) {
      return {
        webContentsId: wcId,
        project,
        workspaceRealpath: workspace.realpath,
        workspaceIdentity: workspace.identity,
        fileGrantsGeneration: workspace.generation,
      };
    }
  }
  return null;
}

/** Revalidate the project and workspace identities bound to a prior authorization. */
export async function revalidateGrantedProjectFolder(
  fileGrants: FileGrants,
  authorization: ProjectWizardAuthorization,
  fs: IdentityFs,
): Promise<string | null> {
  const workspace = await fileGrants.authorizeWorkspace(
    authorization.webContentsId,
    authorization.workspaceRealpath,
  );
  if (!matchesProjectWizardWorkspace(workspace, authorization)) return null;

  const project = await canonicalIdentity(authorization.project.realpath, fs);
  if (
    !project ||
    project.kind !== 'directory' ||
    project.realpath !== authorization.project.realpath ||
    project.identity !== authorization.project.identity
  ) {
    return null;
  }

  const reauthorizedWorkspace = await fileGrants.authorizeWorkspace(
    authorization.webContentsId,
    authorization.workspaceRealpath,
  );
  if (
    !matchesProjectWizardWorkspace(reauthorizedWorkspace, authorization) ||
    !isCanonicalPathWithinRoot(reauthorizedWorkspace.realpath, project.realpath)
  ) {
    return null;
  }
  return project.realpath;
}
function matchesProjectWizardWorkspace(
  workspace: Awaited<ReturnType<FileGrants['authorizeWorkspace']>>,
  authorization: ProjectWizardAuthorization,
): workspace is NonNullable<typeof workspace> {
  return (
    !!workspace &&
    workspace.realpath === authorization.workspaceRealpath &&
    workspace.identity === authorization.workspaceIdentity &&
    workspace.generation === authorization.fileGrantsGeneration
  );
}

/** Main-process state tying an approved-draft save to the authorization at start. */
export class ProjectWizardRootStore {
  private roots = new Map<number, ProjectWizardRootRecord>();
  private ownerGenerations = new Map<number, number>();
  private nextNonce = 0;

  private ownerGenerationFor(wcId: number): number {
    return this.ownerGenerations.get(wcId) ?? 0;
  }

  record(wcId: number, authorization: ProjectWizardAuthorization): ProjectWizardRootRecord {
    const record: ProjectWizardRootRecord = {
      authorization,
      ownerGeneration: this.ownerGenerationFor(wcId),
      nonce: ++this.nextNonce,
    };
    this.roots.set(wcId, record);
    return record;
  }

  get(wcId: number): ProjectWizardRootRecord | null {
    return this.roots.get(wcId) ?? null;
  }

  isCurrent(wcId: number, record: ProjectWizardRootRecord): boolean {
    return (
      record.authorization.webContentsId === wcId &&
      record.ownerGeneration === this.ownerGenerationFor(wcId) &&
      this.roots.get(wcId)?.nonce === record.nonce
    );
  }

  release(wcId: number): void {
    this.ownerGenerations.set(wcId, this.ownerGenerationFor(wcId) + 1);
    this.roots.delete(wcId);
  }
}
/** Revalidate the exact root record, including its owner generation and nonce. */
export async function revalidateCurrentProjectWizardRoot(
  fileGrants: FileGrants,
  roots: ProjectWizardRootStore,
  wcId: number,
  record: ProjectWizardRootRecord,
  fs: IdentityFs,
): Promise<string | null> {
  if (!roots.isCurrent(wcId, record)) return null;

  const projectFolder = await revalidateGrantedProjectFolder(fileGrants, record.authorization, fs);
  if (
    !projectFolder ||
    projectFolder !== record.authorization.project.realpath ||
    !roots.isCurrent(wcId, record)
  ) {
    return null;
  }

  return projectFolder;
}
