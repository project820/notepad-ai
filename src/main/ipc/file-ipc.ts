import { dialog, shell, type BrowserWindow } from 'electron';
import { promises as fs } from 'node:fs';
import { nodeAssetReadFs, readFdBoundFile } from '../asset-file-reader';
import { handleTrusted } from '../ipc-guard';
import { FileGrants, type WriteAuthorization } from '../file-grants';
import { KeyedMutex } from '../keyed-mutex';
import {
  canonicalIdentity,
  identityFromStat,
  isCanonicalPathWithinRoot,
  type CanonicalPathIdentity,
  type IdentityFs,
} from '../path-identity';
import { saveDocumentAtomically } from '../document-save';
import type { DescriptorAtomicWriteBackend } from '../atomic-write';
import type { WindowRegistry, WindowRecord } from '../window-registry';
import { isSafeLocalAbsolutePath, listDirectory, openFileInCurrentWindow, type FileTreeEntry } from '../file-tree';

type FileIpcDeps = {
  registry: WindowRegistry;
  fileGrants: FileGrants;
  identityFs: IdentityFs;
  saveMutex: KeyedMutex;
  backend: DescriptorAtomicWriteBackend;
  windowFromRecord: (record: WindowRecord | null) => BrowserWindow | null;
  openFilePath: (filePath: string, win: BrowserWindow) => Promise<void>;
};

export function registerFileIpc({ registry, fileGrants, identityFs, saveMutex, backend, windowFromRecord, openFilePath }: FileIpcDeps): void {
  handleTrusted('file:save', async (event, args: { filePath: string | null; content: string }) => {
    const rec = registry.getByWebContents(event.sender.id);
    const win = windowFromRecord(rec);
    const target = args.filePath;
    let authorization: WriteAuthorization;
    let finalTarget: string;
    if (target && !isSafeLocalAbsolutePath(target)) return { saved: false as const, error: 'invalid-path' as const };
    if (!target) {
      if (!win) return { saved: false as const };
      const result = await dialog.showSaveDialog(win, { filters: [{ name: 'Markdown', extensions: ['md'] }], defaultPath: 'untitled.md' });
      if (result.canceled || !result.filePath) return { saved: false as const };
      const grant = await fileGrants.grantSaveTarget(event.sender.id, result.filePath);
      if (!grant) return { saved: false as const, error: 'not-authorized' as const };
      const writeAuthorization = await fileGrants.authorizeWriteTarget(event.sender.id, grant.canonicalPath);
      if (!writeAuthorization) return { saved: false as const, error: 'not-authorized' as const };
      authorization = writeAuthorization;
      finalTarget = authorization.canonicalTarget;
    } else {
      const writeAuthorization = await fileGrants.authorizeWriteTarget(event.sender.id, target);
      if (!writeAuthorization) return { saved: false as const, error: 'not-authorized' as const };
      authorization = writeAuthorization;
      finalTarget = authorization.canonicalTarget;
    }
    return saveMutex.run(finalTarget, async () => {
      const currentAuthorization = await fileGrants.authorizeWriteTarget(event.sender.id, finalTarget);
      if (!currentAuthorization) return { saved: false as const, error: 'not-authorized' as const };
      authorization = currentAuthorization;
      const priorClaim = rec?.currentPath ?? null;
      if (rec) {
        const decision = registry.resolvePathClaim(rec.windowId, finalTarget);
        if (decision.kind === 'focus-owner') {
          windowFromRecord(registry.get(decision.ownerWindowId))?.focus();
          console.log(`[file] duplicate-path blocked path=${finalTarget} owner=${decision.ownerWindowId} requester=${rec.windowId} focusOwner=true`);
          return { saved: false as const, error: 'already-open' as const, ownerWindowId: decision.ownerWindowId };
        }
        registry.claimPath(rec.windowId, finalTarget);
      }

      let preparedTempIdentity: CanonicalPathIdentity | null = null;
      try {
        await saveDocumentAtomically(finalTarget, args.content, {
          fs,
          backend,
          beforeWrite: async () => {
            if (!(await fileGrants.validateWriteAuthorization(authorization))) {
              throw new Error('not-authorized');
            }
          },
          beforeRename: async (temp) => {
            if (!(await fileGrants.validateWriteAuthorization(authorization))) {
              throw new Error('not-authorized');
            }
            const identity = await canonicalIdentity(temp.path, identityFs);
            if (
              !identity ||
              identity.kind !== 'file' ||
              identity.realpath !== temp.path ||
              identity.identity !== identityFromStat(temp.identity)
            ) {
              throw new Error('write-failed');
            }
            preparedTempIdentity = identity;
          },
        });
      } catch (e) {
        if (rec && priorClaim !== finalTarget) registry.restorePathClaim(rec.windowId, priorClaim);
        return { saved: false as const, error: e instanceof Error ? e.message : 'write-failed' };
      }

      fileGrants.commitSavedFile(event.sender.id, authorization, preparedTempIdentity!);
      return { saved: true as const, filePath: finalTarget };
    });
  });
  handleTrusted('file:open-path', async (event, filePath: unknown) => {
    if (!isSafeLocalAbsolutePath(filePath)) return { error: 'invalid-path' as const };
    const authorization = await fileGrants.authorizeExistingFile(event.sender.id, filePath);
    if (!authorization) return { error: 'not-authorized' as const };
    const read = await readFdBoundFile(authorization.grant, nodeAssetReadFs);
    return read.ok
      ? { filePath: authorization.grant.realpath, content: Buffer.from(read.bytes.buffer, read.bytes.byteOffset, read.bytes.byteLength).toString('utf-8') }
      : { error: 'read-failed' as const };
  });
  handleTrusted('workspace:open-folder', async (event) => {
    const parent = windowFromRecord(registry.getByWebContents(event.sender.id)) ?? windowFromRecord(registry.focusedOrLast());
    const opts: Electron.OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'] };
    const result = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
    if (result.canceled || result.filePaths.length === 0) return null;
    const workspace = await fileGrants.grantWorkspace(event.sender.id, result.filePaths[0]);
    return workspace?.realpath ?? null;
  });
  handleTrusted('workspace:list-dir', async (event, args: { rootPath: string; dirPath: string }) => {
    const workspace = await fileGrants.authorizeWorkspace(event.sender.id, args?.rootPath ?? '');
    if (!workspace) return { ok: false as const, entries: [] as FileTreeEntry[], error: 'workspace-not-authorized' };
    let dirPath: string;
    try {
      dirPath = await identityFs.realpath(args.dirPath);
    } catch {
      return { ok: false as const, entries: [] as FileTreeEntry[], error: 'path-escapes-root' };
    }
    if (!isCanonicalPathWithinRoot(workspace.realpath, dirPath)) {
      return { ok: false as const, entries: [] as FileTreeEntry[], error: 'path-escapes-root' };
    }
    try {
      const entries = await listDirectory({ rootPath: workspace.realpath, dirPath });
      await fileGrants.recordWorkspaceEnumeration(event.sender.id, workspace, entries.filter((entry) => !entry.isDir).map((entry) => entry.path));
      return { ok: true as const, entries };
    } catch (e: any) {
      return { ok: false as const, entries: [] as FileTreeEntry[], error: String(e?.message ?? e) };
    }
  });
  handleTrusted('file:open-in-current', async (event, target: unknown) => {
    const rec = registry.getByWebContents(event.sender.id); const win = windowFromRecord(rec);
    if (!rec || !win) return { opened: false as const, error: 'no-window' as const };
    if (typeof target !== 'string') return { opened: false as const, error: 'not-authorized' as const };
    const authorization = await fileGrants.authorizeExistingFile(event.sender.id, target);
    if (!authorization) return { opened: false as const, error: 'not-authorized' as const };
    return openFileInCurrentWindow(rec.windowId, authorization.grant.realpath, { ownerOfPath: (p) => registry.ownerOfPath(p), focusOwner: (id) => windowFromRecord(registry.get(id))?.focus(), openInRequester: (p) => openFilePath(p, win) });
  });
  handleTrusted('shell:open-path', async (event, filePath: unknown) => {
    if (!isSafeLocalAbsolutePath(filePath)) return { ok: false as const, error: 'invalid-path' as const };
    const authorization = await fileGrants.authorizeExistingFile(event.sender.id, filePath);
    if (!authorization) return { ok: false as const, error: 'not-authorized' as const };
    const result = await shell.openPath(authorization.grant.realpath);
    return result === '' ? { ok: true as const } : { ok: false as const, error: result };
  });
}
