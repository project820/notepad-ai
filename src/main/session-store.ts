import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  migrateSessionSnapshot,
  type LegacySessionSnapshot,
  type SessionSnapshotV2,
} from './session-schema';
import { SessionQueue } from './session-queue';
import { atomicWrite as atomicWriteFile, nodeAtomicBackend } from './atomic-write';

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
type SessionSnapshot = LegacySessionSnapshot;

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

async function readSession(): Promise<SessionSnapshot | null> {
  try {
    const buf = await fs.readFile(sessionPath(), 'utf-8');
    return JSON.parse(buf) as SessionSnapshot;
  } catch {
    return null;
  }
}

async function writeSession(snap: SessionSnapshot): Promise<void> {
  try {
    await atomicWrite(sessionPath(), JSON.stringify(snap, null, 2));
  } catch {
    /* ignore */
  }
}

async function markCleanExit(): Promise<void> {
  const cur = (await readSession()) ?? { savedAt: Date.now(), doc: '', currentPath: null, pendingTitle: null };
  cur.cleanExit = true;
  await writeSession(cur);
}

async function clearSession(): Promise<void> {
  try {
    await fs.unlink(sessionPath());
  } catch {
    /* ignore */
  }
}

/** Read the persisted session and migrate it into the v2 aggregate (migrate-on-read). */
async function readSessionV2(): Promise<SessionSnapshotV2> {
  try {
    const buf = await fs.readFile(sessionPath(), 'utf-8');
    return migrateSessionSnapshot(JSON.parse(buf));
  } catch {
    return { version: 2, windows: [] };
  }
}

/** Atomically persist the v2 aggregate (temp file + rename). */
async function writeSessionV2(state: SessionSnapshotV2): Promise<void> {
  try {
    await atomicWrite(sessionPath(), JSON.stringify(state, null, 2));
  } catch {
    /* ignore */
  }
}

// --- Serialized authoritative aggregate (Phase 0 safety net) --------------
// Every v2 session mutation routes through one in-memory authoritative
// aggregate plus a serialized mutation queue, so concurrent multi-window
// writes never drop a snapshot (lost update) and the before-quit cleanExit
// transaction is never clobbered by a late renderer write. Persistence uses the
// hardened atomic-write primitive (unique temp, 0o600, fsync, rename).
const sessionBackend = nodeAtomicBackend();
const sessionQueue = new SessionQueue({
  load: () => readSessionV2(),
  persist: (state) =>
    atomicWriteFile(sessionPath(), JSON.stringify(state, null, 2), { backend: sessionBackend }),
});

/** Read the authoritative aggregate (loads once from disk, then in-memory). */
export function getSessionAggregate(): Promise<SessionSnapshotV2> {
  return sessionQueue.read();
}

/** Serialized read-modify-write of the aggregate, persisted atomically. */
export function mutateSessionAggregate(
  mutator: (current: SessionSnapshotV2) => SessionSnapshotV2,
): Promise<SessionSnapshotV2> {
  return sessionQueue.mutate(mutator);
}

/**
 * Begin the quit transaction and persist `cleanExit: true`. After this, late
 * renderer `session:write` mutations are dropped so the clean-exit marker wins.
 */
export async function markCleanExitQueued(): Promise<void> {
  sessionQueue.beginQuit();
  await sessionQueue.mutate((s) => ({ ...s, cleanExit: true }), { allowDuringQuit: true });
}

/** Reset the aggregate to a clean empty state (after a clean-exit restore check). */
export function resetSessionAggregate(): Promise<SessionSnapshotV2> {
  return sessionQueue.mutate(() => ({ version: 2, windows: [], cleanExit: false }));
}
