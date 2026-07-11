import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { migrateSessionSnapshot, removeWindowSnapshot, type SessionSnapshotV2 } from './session-schema';
import { SessionQueue } from './session-queue';
import { atomicWrite as atomicWriteFile, nodeAtomicBackend } from './atomic-write';

/**
 * Session store — persists the crash/quit restore snapshot to
 * `userData/session.json`. The renderer sends updates (debounced) and reads the
 * versioned multi-window aggregate on launch to decide whether to offer a
 * restore. Writes are atomic so a process death mid-write cannot leave a torn
 * session file.
 *
 * SECURITY: snapshots never contain auth tokens or API keys (see session-schema).
 */

function sessionPath() {
  return path.join(app.getPath('userData'), 'session.json');
}

/** Read and migrate a persisted aggregate without hiding corrupt recovery state. */
async function readSessionV2(): Promise<SessionSnapshotV2> {
  const target = sessionPath();
  try {
    const buf = await fs.readFile(target, 'utf-8');
    return migrateSessionSnapshot(JSON.parse(buf));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 2, windows: [] };
    }

    const quarantined = `${target}.corrupt-${Date.now()}`;
    let quarantineError: unknown;
    try {
      await fs.rename(target, quarantined);
    } catch (renameError) {
      quarantineError = renameError;
    }
    console.error('[session] recovery read failed; starting with an empty session', {
      sessionPath: target,
      quarantinedPath: quarantineError ? null : quarantined,
      error: error instanceof Error ? error.message : String(error),
      quarantineError:
        quarantineError instanceof Error ? quarantineError.message : quarantineError ? String(quarantineError) : undefined,
    });
    return { version: 2, windows: [] };
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
 * Atomically persist the final quit aggregate and then fence late renderer
 * writes. Discarded windows and the clean-exit marker are one durable change.
 */
export async function markCleanExitQueued(windowKeys: readonly string[] = []): Promise<void> {
  await sessionQueue.beginQuit((state) => ({
    ...windowKeys.reduce(removeWindowSnapshot, state),
    cleanExit: true,
  }));
}

/** Reset the aggregate to a clean empty state (after a clean-exit restore check). */
export function resetSessionAggregate(): Promise<SessionSnapshotV2> {
  return sessionQueue.mutate(() => ({ version: 2, windows: [], cleanExit: false }));
}
