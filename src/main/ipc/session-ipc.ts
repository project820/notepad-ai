import { BrowserWindow } from 'electron';
import { handleTrusted, onTrusted } from '../ipc-guard';
import { mutateSessionAggregate } from '../session-store';
import { normalizeWindowSnapshot, upsertWindowSnapshot, removeWindowSnapshot } from '../session-schema';
import { flushPendingOutbound, type WindowRegistry, type OutboundSink } from '../window-registry';

export function registerSessionIpc({ registry, sinkFor, isSessionWriteFenced = () => false }: {
  registry: WindowRegistry;
  sinkFor: (win: BrowserWindow) => OutboundSink;
  isSessionWriteFenced?: (windowKey: string) => boolean;
}): void {
  const isCurrentWritableRecord = (webContentsId: number, record: ReturnType<WindowRegistry['getByWebContents']>) =>
    !!record && registry.getByWebContents(webContentsId) === record && !isSessionWriteFenced(record.windowKey);

  handleTrusted('session:get', async (event) => {
    const record = registry.getByWebContents(event.sender.id);
    return { snapshot: record?.restoreSnapshot ?? null, restoreReason: record?.restoreReason };
  });
  handleTrusted('session:write', async (event, snap: unknown) => {
    const rec = registry.getByWebContents(event.sender.id); if (!rec || isSessionWriteFenced(rec.windowKey)) return;
    let written = false;
    const next = await mutateSessionAggregate((cur) => {
      if (!isCurrentWritableRecord(event.sender.id, rec)) return cur;
      const win = normalizeWindowSnapshot(rec.windowKey, rec.currentPath, snap);
      rec.lastSnapshot = win;
      registry.syncSnapshotPath(rec.windowId, win);
      written = true;
      return { ...upsertWindowSnapshot(cur, win), cleanExit: false };
    });
    if (written) console.log(`[session] write key=${rec.windowKey} windows=${next.windows.length}`);
  });
  handleTrusted('session:clear', async (event) => {
    const rec = registry.getByWebContents(event.sender.id); if (!rec || isSessionWriteFenced(rec.windowKey)) return;
    // User declined the recovery banner — drop the in-memory pending snapshot so
    // a later shutdown cannot resurrect content they explicitly discarded.
    rec.restoreSnapshot = undefined;
    rec.restoreReason = undefined;
    await mutateSessionAggregate((cur) => isCurrentWritableRecord(event.sender.id, rec)
      ? removeWindowSnapshot(cur, rec.windowKey)
      : cur);
  });
  onTrusted('window:ready', (event) => {
    const rec = registry.markReady(event.sender.id); const win = BrowserWindow.fromWebContents(event.sender);
    if (!rec || !win) return;
    const flushed = flushPendingOutbound(rec, sinkFor(win));
    console.log(`[window] ready id=${rec.windowId} flushed=${flushed}`);
  });
}
