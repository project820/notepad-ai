import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Session snapshot — survives crashes / forced quits.
 * Snapshots are persisted to userData/session.json every time the renderer
 * sends an update (debounced on the renderer side). On launch, the renderer
 * reads `session:get-last` and decides whether to prompt the user to restore.
 */

export type SessionSnapshot = {
  savedAt: number;
  doc: string;
  currentPath: string | null;
  pendingTitle: string | null;
  splitRatio?: number;
  viewMode?: 'split' | 'editor-only' | 'preview-only';
  chatHistory?: Array<{ role: 'user' | 'assistant'; text: string }>;
  /** v1 unified collaborator-chat thread (messages + legacy separators). */
  unifiedChatHistory?: Array<
    | { type: 'message'; role: 'user' | 'assistant'; text: string; legacySource?: 'bottom' | 'side' }
    | { type: 'separator'; label: string }
  >;
  model?: string;
  cleanExit?: boolean;
};

function sessionPath() {
  return path.join(app.getPath('userData'), 'session.json');
}

export async function readSession(): Promise<SessionSnapshot | null> {
  try {
    const buf = await fs.readFile(sessionPath(), 'utf-8');
    return JSON.parse(buf) as SessionSnapshot;
  } catch {
    return null;
  }
}

export async function writeSession(snap: SessionSnapshot): Promise<void> {
  try {
    await fs.mkdir(path.dirname(sessionPath()), { recursive: true });
    await fs.writeFile(sessionPath(), JSON.stringify(snap, null, 2));
  } catch {
    /* ignore */
  }
}

export async function markCleanExit(): Promise<void> {
  const cur = (await readSession()) ?? { savedAt: Date.now(), doc: '', currentPath: null, pendingTitle: null };
  cur.cleanExit = true;
  await writeSession(cur);
}

export async function clearSession(): Promise<void> {
  try {
    await fs.unlink(sessionPath());
  } catch {
    /* ignore */
  }
}
