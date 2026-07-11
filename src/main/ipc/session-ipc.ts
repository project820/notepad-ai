import { BrowserWindow } from 'electron';
import { handleTrusted, onTrusted } from '../ipc-guard';
import { mutateSessionAggregate } from '../session-store';
import { upsertWindowSnapshot, removeWindowSnapshot, type SessionWindowSnapshot } from '../session-schema';
import { flushPendingOutbound, type WindowRegistry, type OutboundSink } from '../window-registry';

function toWindowSnapshot(id: string, raw: unknown): SessionWindowSnapshot {
  const r = (raw ?? {}) as Record<string, unknown>;
  const view = r.view === 'split' || r.view === 'editor-only' || r.view === 'preview-only' ? r.view : undefined;
  const win: SessionWindowSnapshot = { id, path: typeof r.path === 'string' ? r.path : null, title: typeof r.title === 'string' ? r.title : null, doc: typeof r.doc === 'string' ? r.doc : '' };
  if (typeof r.savedAt === 'number') win.savedAt = r.savedAt;
  if (typeof r.splitRatio === 'number') win.splitRatio = r.splitRatio;
  if (view) win.view = view;
  if (Array.isArray(r.unifiedChatHistory)) win.unifiedChatHistory = r.unifiedChatHistory as SessionWindowSnapshot['unifiedChatHistory'];
  if (Array.isArray(r.chatHistory)) win.chatHistory = r.chatHistory as SessionWindowSnapshot['chatHistory'];
  if (typeof r.model === 'string') win.model = r.model;
  if (typeof r.dirty === 'boolean') win.dirty = r.dirty;
  return win;
}

export function registerSessionIpc({ registry, sinkFor }: { registry: WindowRegistry; sinkFor: (win: BrowserWindow) => OutboundSink }): void {
  handleTrusted('session:get', async (event) => ({ snapshot: registry.getByWebContents(event.sender.id)?.restoreSnapshot ?? null }));
  handleTrusted('session:write', async (event, snap: unknown) => {
    const rec = registry.getByWebContents(event.sender.id); if (!rec) return;
    const win = toWindowSnapshot(rec.windowKey, snap); rec.lastSnapshot = win; registry.syncSnapshotPath(rec.windowId, win);
    const next = await mutateSessionAggregate((cur) => ({ ...upsertWindowSnapshot(cur, win), cleanExit: false }));
    console.log(`[session] write key=${rec.windowKey} windows=${next.windows.length}`);
  });
  handleTrusted('session:clear', async (event) => {
    const rec = registry.getByWebContents(event.sender.id); if (!rec) return;
    await mutateSessionAggregate((cur) => removeWindowSnapshot(cur, rec.windowKey));
  });
  onTrusted('window:ready', (event) => {
    const rec = registry.markReady(event.sender.id); const win = BrowserWindow.fromWebContents(event.sender);
    if (!rec || !win) return;
    const flushed = flushPendingOutbound(rec, sinkFor(win));
    console.log(`[window] ready id=${rec.windowId} flushed=${flushed}`);
  });
}
