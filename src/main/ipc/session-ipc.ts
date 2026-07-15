import { BrowserWindow } from 'electron';
import { handleTrusted, onTrusted } from '../ipc-guard';
import { mutateSessionAggregate } from '../session-store';
import { upsertWindowSnapshot, removeWindowSnapshot, type SessionWindowSnapshot } from '../session-schema';
import { flushPendingOutbound, type WindowRegistry, type OutboundSink } from '../window-registry';

function toWindowSnapshot(id: string, currentPath: string | null | undefined, raw: unknown): SessionWindowSnapshot {
  const r = (raw ?? {}) as Record<string, unknown>;
  const view = r.view === 'split' || r.view === 'editor-only' || r.view === 'preview-only' ? r.view : undefined;
  const win: SessionWindowSnapshot = { id, path: currentPath ?? null, title: typeof r.title === 'string' ? r.title : null, doc: typeof r.doc === 'string' ? r.doc : '' };
  if (typeof r.savedAt === 'number') win.savedAt = r.savedAt;
  if (typeof r.splitRatio === 'number') win.splitRatio = r.splitRatio;
  if (view) win.view = view;
  if (Array.isArray(r.unifiedChatHistory)) win.unifiedChatHistory = r.unifiedChatHistory as SessionWindowSnapshot['unifiedChatHistory'];
  if (Array.isArray(r.chatHistory)) win.chatHistory = r.chatHistory as SessionWindowSnapshot['chatHistory'];
  if (typeof r.model === 'string') win.model = r.model;
  if (typeof r.dirty === 'boolean') win.dirty = r.dirty;
  return win;
}
export function registerSessionIpc({ registry, sinkFor, isSessionWriteFenced = () => false }: {
  registry: WindowRegistry;
  sinkFor: (win: BrowserWindow) => OutboundSink;
  isSessionWriteFenced?: (windowKey: string) => boolean;
}): void {
  const isCurrentWritableRecord = (webContentsId: number, record: ReturnType<WindowRegistry['getByWebContents']>) =>
    !!record && registry.getByWebContents(webContentsId) === record && !isSessionWriteFenced(record.windowKey);

  handleTrusted('session:get', async (event) => ({ snapshot: registry.getByWebContents(event.sender.id)?.restoreSnapshot ?? null }));
  handleTrusted('session:write', async (event, snap: unknown) => {
    const rec = registry.getByWebContents(event.sender.id); if (!rec || isSessionWriteFenced(rec.windowKey)) return;
    let written = false;
    const next = await mutateSessionAggregate((cur) => {
      if (!isCurrentWritableRecord(event.sender.id, rec)) return cur;
      const win = toWindowSnapshot(rec.windowKey, rec.currentPath, snap);
      rec.lastSnapshot = win;
      registry.syncSnapshotPath(rec.windowId, win);
      written = true;
      return { ...upsertWindowSnapshot(cur, win), cleanExit: false };
    });
    if (written) console.log(`[session] write key=${rec.windowKey} windows=${next.windows.length}`);
  });
  handleTrusted('session:clear', async (event) => {
    const rec = registry.getByWebContents(event.sender.id); if (!rec || isSessionWriteFenced(rec.windowKey)) return;
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
