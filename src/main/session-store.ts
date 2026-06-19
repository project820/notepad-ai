import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  migrateSessionSnapshot,
  type LegacySessionSnapshot,
  type SessionSnapshotV2,
} from './session-schema';

/**
 * Session store — persists the crash/quit restore snapshot to
 * `userData/session.json`. The renderer sends updates (debounced) and reads the
 * snapshot on launch to decide whether to offer a restore.
 *
 * v0.3 (G001): the on-disk format is migrating to the versioned multi-window
 * aggregate (`SessionSnapshotV2`). Reads can migrate via `migrateSessionSnapshot`,
 * and writes are atomic (temp file + rename) so a process death mid-write cannot
 * leave a torn `session.json`. The legacy single-snapshot `readSession` /
 * `writeSession` API is kept intact for the current `main.ts` call sites; G002
 * rewires them to the v2 helpers below.
 *
 * SECURITY: snapshots never contain auth tokens or API keys (see session-schema).
 */

/** Back-compat alias for the legacy single-snapshot shape (pre multi-window). */
export type SessionSnapshot = LegacySessionSnapshot;

function sessionPath() {
  return path.join(app.getPath('userData'), 'session.json');
}

/**
 * Write `data` to a sibling temp file, then atomically rename it over `target`.
 * Prevents a half-written `session.json` if the process dies during the write.
 */
async function atomicWrite(target: string, data: string): Promise<void> {
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `session.${process.pid}.${Date.now()}.tmp`);
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
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
    await atomicWrite(sessionPath(), JSON.stringify(snap, null, 2));
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

/** Read the persisted session and migrate it into the v2 aggregate (migrate-on-read). */
export async function readSessionV2(): Promise<SessionSnapshotV2> {
  try {
    const buf = await fs.readFile(sessionPath(), 'utf-8');
    return migrateSessionSnapshot(JSON.parse(buf));
  } catch {
    return { version: 2, windows: [] };
  }
}

/** Atomically persist the v2 aggregate (temp file + rename). */
export async function writeSessionV2(state: SessionSnapshotV2): Promise<void> {
  try {
    await atomicWrite(sessionPath(), JSON.stringify(state, null, 2));
  } catch {
    /* ignore */
  }
}
