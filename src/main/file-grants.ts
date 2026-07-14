/** Per-window main-owned filesystem authority records. */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  canonicalIdentity,
  canonicalNewTarget,
  lookupCanonicalTarget,
  isCanonicalPathWithinRoot,
  type CanonicalPathIdentity,
  type FileIdentity,
  type IdentityFs,
} from './path-identity';

export type DirectDocumentGrantSource =
  | 'open-dialog'
  | 'os-open'
  | 'session-restore'
  | 'conversion';

type ExistingFileGrantSource =
  | DirectDocumentGrantSource
  | 'atomic-save'
  | 'workspace-enumeration';

export interface WorkspaceGrant extends CanonicalPathIdentity {
  readonly kind: 'directory';
  readonly generation: number;
}

export interface ExistingFileGrant extends CanonicalPathIdentity {
  readonly kind: 'file';
  readonly source: ExistingFileGrantSource;
  readonly generation: number;
  readonly workspaceRealpath?: string;
  readonly workspaceIdentity?: FileIdentity;
}

export interface ExplicitAssetFileGrant extends CanonicalPathIdentity {
  readonly kind: 'file';
  readonly source: 'asset-picker';
  readonly generation: number;
}

export interface SaveTargetGrant {
  readonly kind: 'save-target';
  readonly canonicalPath: string;
  readonly parentRealpath: string;
  readonly parentIdentity: FileIdentity;
  readonly expectedTarget: CanonicalPathIdentity | null;
  readonly generation: number;
  readonly token: string;
}

export interface ExistingFileAuthorization {
  readonly scope: 'direct' | 'workspace-enumeration';
  readonly grant: ExistingFileGrant;
}

export interface WriteAuthorization {
  readonly scope: 'direct' | 'workspace' | 'save-target';
  readonly canonicalTarget: string;
  readonly expectedTarget: CanonicalPathIdentity | null;
  readonly parentRealpath: string;
  readonly parentIdentity: FileIdentity;
  readonly webContentsId: number;
  readonly generation: number;
  readonly saveTargetToken?: string;
  readonly workspaceRealpath?: string;
  readonly workspaceIdentity?: FileIdentity;
}


/**
 * All grants are scoped to a webContents instance. Existing-file grants are
 * valid only for the precise canonical realpath and inode selected or observed
 * by main; hardlink aliases therefore never inherit a grant.
 */
export class FileGrants {
  private readonly workspaces = new Map<number, Map<string, WorkspaceGrant>>();
  private readonly files = new Map<number, Map<string, ExistingFileGrant>>();
  private readonly saveTargets = new Map<number, Map<string, SaveTargetGrant>>();
  // One current explicit asset selection per owner keeps this binding bounded.
  private readonly assetSelections = new Map<number, ExplicitAssetFileGrant>();
  private readonly generations = new Map<number, number>();

  constructor(private readonly fs: IdentityFs) {}

  private generationFor(wcId: number): number {
    return this.generations.get(wcId) ?? 0;
  }

  private isCurrentGeneration(wcId: number, generation: number): boolean {
    return this.generationFor(wcId) === generation;
  }

  private mapFor<T>(map: Map<number, Map<string, T>>, wcId: number): Map<string, T> {
    let entries = map.get(wcId);
    if (!entries) {
      entries = new Map<string, T>();
      map.set(wcId, entries);
    }
    return entries;
  }

  private recordFile(wcId: number, grant: ExistingFileGrant): ExistingFileGrant | null {
    if (!this.isCurrentGeneration(wcId, grant.generation)) return null;
    this.mapFor(this.files, wcId).set(grant.realpath, grant);
    return grant;
  }

  private authorizeAssetSelection(
    wcId: number,
    grant: ExplicitAssetFileGrant,
  ): ExplicitAssetFileGrant | null {
    return grant.generation === this.generationFor(wcId) && this.assetSelections.get(wcId) === grant
      ? grant
      : null;
  }
  private async createWriteAuthorization(
    wcId: number,
    generation: number,
    scope: WriteAuthorization['scope'],
    canonicalTarget: string,
    expectedTarget: CanonicalPathIdentity | null,
    workspace?: Pick<WorkspaceGrant, 'realpath' | 'identity'>,
  ): Promise<WriteAuthorization | null> {
    const parent = await canonicalIdentity(path.dirname(canonicalTarget), this.fs);
    if (
      !this.isCurrentGeneration(wcId, generation) ||
      !parent ||
      parent.kind !== 'directory' ||
      parent.realpath !== path.dirname(canonicalTarget)
    ) {
      return null;
    }
    return {
      scope,
      canonicalTarget,
      expectedTarget,
      parentRealpath: parent.realpath,
      parentIdentity: parent.identity,
      workspaceRealpath: workspace?.realpath,
      workspaceIdentity: workspace?.identity,
      webContentsId: wcId,
      generation,
    };
  }

  private writeAuthorizationFromSaveTarget(
    wcId: number,
    generation: number,
    grant: SaveTargetGrant,
  ): WriteAuthorization | null {
    if (
      !this.isCurrentGeneration(wcId, generation) ||
      grant.generation !== generation ||
      this.saveTargets.get(wcId)?.get(grant.canonicalPath) !== grant
    ) {
      return null;
    }
    return {
      scope: 'save-target',
      canonicalTarget: grant.canonicalPath,
      expectedTarget: grant.expectedTarget,
      parentRealpath: grant.parentRealpath,
      parentIdentity: grant.parentIdentity,
      webContentsId: wcId,
      generation,
      saveTargetToken: grant.token,
    };
  }
  private hasLiveSaveTargetToken(authorization: WriteAuthorization): boolean {
    if (authorization.scope !== 'save-target') return true;
    const liveGrant = this.saveTargets
      .get(authorization.webContentsId)
      ?.get(authorization.canonicalTarget);
    return Boolean(
      authorization.saveTargetToken &&
      liveGrant &&
      liveGrant.generation === authorization.generation &&
      liveGrant.token === authorization.saveTargetToken,
    );
  }



  async grantWorkspace(wcId: number, root: string): Promise<WorkspaceGrant | null> {
    const generation = this.generationFor(wcId);
    const identity = await canonicalIdentity(root, this.fs);
    if (
      !this.isCurrentGeneration(wcId, generation) ||
      !identity ||
      identity.kind !== 'directory'
    ) {
      return null;
    }
    const grant: WorkspaceGrant = { ...identity, kind: 'directory', generation };
    this.mapFor(this.workspaces, wcId).set(grant.realpath, grant);
    return grant;
  }

  async grantExistingFile(
    wcId: number,
    filePath: string,
    source: DirectDocumentGrantSource,
  ): Promise<ExistingFileGrant | null> {
    const generation = this.generationFor(wcId);
    const identity = await canonicalIdentity(filePath, this.fs);
    if (
      !this.isCurrentGeneration(wcId, generation) ||
      !identity ||
      identity.kind !== 'file'
    ) {
      return null;
    }
    return this.recordFile(wcId, { ...identity, kind: 'file', source, generation });
  }

  async grantAssetSelection(
    wcId: number,
    selectedPath: string,
  ): Promise<ExplicitAssetFileGrant | null> {
    const generation = this.generationFor(wcId);
    const identity = await canonicalIdentity(selectedPath, this.fs);
    if (
      !this.isCurrentGeneration(wcId, generation) ||
      !identity ||
      identity.kind !== 'file'
    ) {
      return null;
    }
    const grant: ExplicitAssetFileGrant = {
      ...identity,
      kind: 'file',
      source: 'asset-picker',
      generation,
    };
    this.assetSelections.set(wcId, grant);
    return this.authorizeAssetSelection(wcId, grant);
  }

  async grantSaveTarget(wcId: number, filePath: string): Promise<SaveTargetGrant | null> {
    const generation = this.generationFor(wcId);
    const requestedTarget = await canonicalNewTarget(filePath, this.fs);
    if (!this.isCurrentGeneration(wcId, generation) || !requestedTarget) return null;
    const targetLookup = await lookupCanonicalTarget(requestedTarget, this.fs);
    if (
      !this.isCurrentGeneration(wcId, generation) ||
      targetLookup.state === 'error' ||
      (targetLookup.state === 'present' && targetLookup.identity.kind !== 'file')
    ) {
      return null;
    }

    const expectedTarget = targetLookup.state === 'present' ? targetLookup.identity : null;
    const canonicalPath = expectedTarget?.realpath ?? requestedTarget;
    const parent = await canonicalIdentity(path.dirname(canonicalPath), this.fs);
    if (
      !this.isCurrentGeneration(wcId, generation) ||
      !parent ||
      parent.kind !== 'directory' ||
      parent.realpath !== path.dirname(canonicalPath)
    ) {
      return null;
    }

    const grant: SaveTargetGrant = {
      kind: 'save-target',
      canonicalPath,
      parentRealpath: parent.realpath,
      parentIdentity: parent.identity,
      expectedTarget,
      generation,
      token: randomUUID(),
    };
    this.mapFor(this.saveTargets, wcId).set(canonicalPath, grant);
    return grant;
  }

  async authorizeWorkspace(wcId: number, root: string): Promise<WorkspaceGrant | null> {
    const generation = this.generationFor(wcId);
    const identity = await canonicalIdentity(root, this.fs);
    if (
      !this.isCurrentGeneration(wcId, generation) ||
      !identity ||
      identity.kind !== 'directory'
    ) {
      return null;
    }
    const grant = this.workspaces.get(wcId)?.get(identity.realpath);
    if (
      !grant ||
      grant.generation !== generation ||
      grant.identity !== identity.identity
    ) {
      return null;
    }
    return grant;
  }

  async recordWorkspaceEnumeration(
    wcId: number,
    workspace: WorkspaceGrant,
    mainDerivedEntryPaths: readonly string[],
  ): Promise<readonly ExistingFileGrant[]> {
    const generation = this.generationFor(wcId);
    if (workspace.generation !== generation) return [];
    const currentWorkspace = await this.authorizeWorkspace(wcId, workspace.realpath);
    if (
      !this.isCurrentGeneration(wcId, generation) ||
      !currentWorkspace ||
      currentWorkspace.identity !== workspace.identity
    ) {
      return [];
    }

    const recorded: ExistingFileGrant[] = [];
    for (const entryPath of mainDerivedEntryPaths) {
      const identity = await canonicalIdentity(entryPath, this.fs);
      if (!this.isCurrentGeneration(wcId, generation)) return [];
      if (!identity || identity.kind !== 'file' || !isCanonicalPathWithinRoot(workspace.realpath, identity.realpath)) continue;
      const grant = this.recordFile(wcId, {
        ...identity,
        kind: 'file',
        source: 'workspace-enumeration',
        generation,
        workspaceRealpath: workspace.realpath,
        workspaceIdentity: workspace.identity,
      });
      if (grant) recorded.push(grant);
    }
    return this.isCurrentGeneration(wcId, generation) ? recorded : [];
  }

  async authorizeExistingFile(
    wcId: number,
    filePath: string,
  ): Promise<ExistingFileAuthorization | null> {
    const generation = this.generationFor(wcId);
    const identity = await canonicalIdentity(filePath, this.fs);
    if (
      !this.isCurrentGeneration(wcId, generation) ||
      !identity ||
      identity.kind !== 'file'
    ) {
      return null;
    }
    const grant = this.files.get(wcId)?.get(identity.realpath);
    if (
      !grant ||
      grant.generation !== generation ||
      grant.identity !== identity.identity
    ) {
      return null;
    }
    return {
      scope: grant.source === 'workspace-enumeration' ? 'workspace-enumeration' : 'direct',
      grant,
    };
  }

  async authorizeWriteTarget(
    wcId: number,
    filePath: string,
  ): Promise<WriteAuthorization | null> {
    const generation = this.generationFor(wcId);
    const current = await canonicalIdentity(filePath, this.fs);
    if (!this.isCurrentGeneration(wcId, generation)) return null;
    if (current?.kind === 'file') {
      const grant = this.files.get(wcId)?.get(current.realpath);
      if (grant?.generation === generation && grant.identity === current.identity) {
        return this.createWriteAuthorization(
          wcId,
          generation,
          grant.source === 'workspace-enumeration' ? 'workspace' : 'direct',
          grant.realpath,
          current,
          grant.source === 'workspace-enumeration' ? grant : undefined,
        );
      }
    }

    const canonicalTarget = await canonicalNewTarget(filePath, this.fs);
    if (!this.isCurrentGeneration(wcId, generation) || !canonicalTarget) return null;

    const targetLookup = await lookupCanonicalTarget(canonicalTarget, this.fs);
    if (!this.isCurrentGeneration(wcId, generation) || targetLookup.state === 'error') return null;
    const resolvedTarget = targetLookup.state === 'present'
      ? targetLookup.identity.realpath
      : canonicalTarget;

    const saveTarget = this.saveTargets.get(wcId)?.get(resolvedTarget);
    if (saveTarget) return this.writeAuthorizationFromSaveTarget(wcId, generation, saveTarget);

    if (targetLookup.state !== 'absent') return null;
    for (const workspace of this.workspaces.get(wcId)?.values() ?? []) {
      if (!this.isCurrentGeneration(wcId, generation)) return null;
      const currentWorkspace = await this.authorizeWorkspace(wcId, workspace.realpath);
      if (!this.isCurrentGeneration(wcId, generation)) return null;
      if (currentWorkspace && isCanonicalPathWithinRoot(currentWorkspace.realpath, canonicalTarget)) {
        return this.createWriteAuthorization(
          wcId,
          generation,
          'workspace',
          canonicalTarget,
          null,
          currentWorkspace,
        );
      }
    }
    return null;
  }

  async validateWriteAuthorization(authorization: WriteAuthorization): Promise<boolean> {
    if (
      !this.isCurrentGeneration(authorization.webContentsId, authorization.generation) ||
      !this.hasLiveSaveTargetToken(authorization)
    ) {
      return false;
    }

    const expectedParent = path.dirname(authorization.canonicalTarget);
    const parent = await canonicalIdentity(authorization.parentRealpath, this.fs);
    if (
      !this.isCurrentGeneration(authorization.webContentsId, authorization.generation) ||
      !parent ||
      parent.kind !== 'directory' ||
      parent.realpath !== expectedParent ||
      parent.realpath !== authorization.parentRealpath ||
      parent.identity !== authorization.parentIdentity
    ) {
      return false;
    }

    if (authorization.workspaceRealpath || authorization.workspaceIdentity) {
      if (!authorization.workspaceRealpath || !authorization.workspaceIdentity) return false;
      const workspace = await canonicalIdentity(authorization.workspaceRealpath, this.fs);
      if (
        !this.isCurrentGeneration(authorization.webContentsId, authorization.generation) ||
        !workspace ||
        workspace.kind !== 'directory' ||
        workspace.realpath !== authorization.workspaceRealpath ||
        workspace.identity !== authorization.workspaceIdentity ||
        !isCanonicalPathWithinRoot(workspace.realpath, parent.realpath) ||
        !isCanonicalPathWithinRoot(workspace.realpath, authorization.canonicalTarget)
      ) {
        return false;
      }
    }

    const targetLookup = await lookupCanonicalTarget(authorization.canonicalTarget, this.fs);
    if (
      !this.isCurrentGeneration(authorization.webContentsId, authorization.generation) ||
      !this.hasLiveSaveTargetToken(authorization) ||
      targetLookup.state === 'error'
    ) {
      return false;
    }
    if (!authorization.expectedTarget) return targetLookup.state === 'absent';
    return (
      targetLookup.state === 'present' &&
      targetLookup.identity.kind === 'file' &&
      targetLookup.identity.realpath === authorization.expectedTarget.realpath &&
      targetLookup.identity.identity === authorization.expectedTarget.identity
    );
  }

  /** Install an inode observed on the prepared temp file after its successful rename. */
  commitSavedFile(
    wcId: number,
    authorization: WriteAuthorization,
    preparedTempIdentity: CanonicalPathIdentity,
  ): ExistingFileGrant | null {
    if (
      authorization.webContentsId !== wcId ||
      !this.isCurrentGeneration(wcId, authorization.generation)
    ) {
      return null;
    }
    if (!this.hasLiveSaveTargetToken(authorization)) {
      return null;
    }
    if (authorization.scope === 'save-target') {
      this.saveTargets.get(wcId)?.delete(authorization.canonicalTarget);
    }
    return this.recordFile(wcId, {
      realpath: authorization.canonicalTarget,
      identity: preparedTempIdentity.identity,
      kind: 'file',
      source: 'atomic-save',
      generation: authorization.generation,
      workspaceRealpath: authorization.workspaceRealpath,
      workspaceIdentity: authorization.workspaceIdentity,
    });
  }

  release(wcId: number): void {
    this.generations.set(wcId, this.generationFor(wcId) + 1);
    this.workspaces.delete(wcId);
    this.files.delete(wcId);
    this.saveTargets.delete(wcId);
    this.assetSelections.delete(wcId);
  }

  /** Canonical workspace roots available to the project wizard for this window. */
  async projectWizardRoots(wcId: number): Promise<string[]> {
    const roots: string[] = [];
    for (const workspace of this.workspaces.get(wcId)?.values() ?? []) {
      const current = await this.authorizeWorkspace(wcId, workspace.realpath);
      if (current && current.identity === workspace.identity) roots.push(current.realpath);
    }
    return roots;
  }
}
