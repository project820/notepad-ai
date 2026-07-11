import { dialog, shell, type BrowserWindow } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { handleTrusted } from '../ipc-guard';
import { FileGrants } from '../file-grants';
import { KeyedMutex } from '../keyed-mutex';
import { canonicalNewTarget, isRealpathWithinRoot, type IdentityFs } from '../path-identity';
import { saveDocumentAtomically } from '../document-save';
import type { AtomicWriteBackend } from '../atomic-write';
import type { WindowRegistry, WindowRecord } from '../window-registry';
import { isSafeLocalAbsolutePath, listDirectory, openFileInCurrentWindow, type FileTreeEntry } from '../file-tree';

type FileIpcDeps = {
  registry: WindowRegistry;
  fileGrants: FileGrants;
  identityFs: IdentityFs;
  saveMutex: KeyedMutex;
  backend: AtomicWriteBackend;
  windowFromRecord: (record: WindowRecord | null) => BrowserWindow | null;
  openFilePath: (filePath: string, win: BrowserWindow) => Promise<void>;
};

export function registerFileIpc({ registry, fileGrants, identityFs, saveMutex, backend, windowFromRecord, openFilePath }: FileIpcDeps): void {
  handleTrusted('file:save', async (event, args: { filePath: string | null; content: string }) => {
    const rec = registry.getByWebContents(event.sender.id);
    const win = windowFromRecord(rec);
    let target = args.filePath;
    if (target && !isSafeLocalAbsolutePath(target)) return { saved: false as const, error: 'invalid-path' as const };
    if (!target) {
      if (!win) return { saved: false as const };
      const result = await dialog.showSaveDialog(win, { filters: [{ name: 'Markdown', extensions: ['md'] }], defaultPath: 'untitled.md' });
      if (result.canceled || !result.filePath) return { saved: false as const };
      target = result.filePath;
      fileGrants.grantFile(event.sender.id, target);
    }
    if (!fileGrants.isFileAllowed(event.sender.id, target)) return { saved: false as const, error: 'not-authorized' as const };
    const finalTarget = target;
    const saveKey = (await canonicalNewTarget(finalTarget, identityFs)) ?? path.resolve(finalTarget);
    return saveMutex.run(saveKey, async () => {
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
      try { await saveDocumentAtomically(finalTarget, args.content, { fs, backend }); }
      catch (e) {
        if (rec && priorClaim !== finalTarget) registry.restorePathClaim(rec.windowId, priorClaim);
        return { saved: false as const, error: e instanceof Error ? e.message : 'write-failed' };
      }
      return { saved: true as const, filePath: finalTarget };
    });
  });
  handleTrusted('file:open-path', async (event, filePath: unknown) => {
    if (!isSafeLocalAbsolutePath(filePath)) return { error: 'invalid-path' as const };
    if (!fileGrants.isFileAllowed(event.sender.id, filePath)) return { error: 'not-authorized' as const };
    try { return { filePath, content: await fs.readFile(filePath, 'utf-8') }; }
    catch (e) { return { error: e instanceof Error ? e.message : 'read-failed' }; }
  });
  handleTrusted('workspace:open-folder', async (event) => {
    const parent = windowFromRecord(registry.getByWebContents(event.sender.id)) ?? windowFromRecord(registry.focusedOrLast());
    const opts: Electron.OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'] };
    const result = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
    if (result.canceled || result.filePaths.length === 0) return null;
    fileGrants.grantWorkspace(event.sender.id, result.filePaths[0]);
    return result.filePaths[0];
  });
  handleTrusted('workspace:list-dir', async (event, args: { rootPath: string; dirPath: string }) => {
    if (!fileGrants.isWorkspaceGranted(event.sender.id, args?.rootPath ?? '')) return { ok: false as const, entries: [] as FileTreeEntry[], error: 'workspace-not-authorized' };
    if (!(await isRealpathWithinRoot(args.rootPath, args.dirPath, identityFs))) return { ok: false as const, entries: [] as FileTreeEntry[], error: 'path-escapes-root' };
    try { return { ok: true as const, entries: await listDirectory({ rootPath: args.rootPath, dirPath: args.dirPath }) }; }
    catch (e: any) { return { ok: false as const, entries: [] as FileTreeEntry[], error: String(e?.message ?? e) }; }
  });
  handleTrusted('file:open-in-current', async (event, target: unknown) => {
    const rec = registry.getByWebContents(event.sender.id); const win = windowFromRecord(rec);
    if (!rec || !win) return { opened: false as const, error: 'no-window' as const };
    if (typeof target !== 'string' || !fileGrants.isFileAllowed(event.sender.id, target)) return { opened: false as const, error: 'not-authorized' as const };
    return openFileInCurrentWindow(rec.windowId, target, { ownerOfPath: (p) => registry.ownerOfPath(p), focusOwner: (id) => windowFromRecord(registry.get(id))?.focus(), openInRequester: (p) => openFilePath(p, win) });
  });
  handleTrusted('shell:open-path', async (event, filePath: unknown) => {
    if (!isSafeLocalAbsolutePath(filePath)) return { ok: false as const, error: 'invalid-path' as const };
    if (!fileGrants.isFileAllowed(event.sender.id, filePath)) return { ok: false as const, error: 'not-authorized' as const };
    const result = await shell.openPath(path.resolve(filePath));
    return result === '' ? { ok: true as const } : { ok: false as const, error: result };
  });
}
