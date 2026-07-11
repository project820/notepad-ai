/**
 * session-queue.ts — serialized authoritative session aggregate (Phase 0 safety net).
 *
 * The pre-existing `session:write` / `session:clear` / `markCleanExit` paths each
 * did an independent `read → modify → write` against `session.json`. With two
 * windows saving concurrently, both read the same on-disk aggregate and the last
 * writer dropped the other window's snapshot (lost update). The quit transaction
 * (`cleanExit: true`) could likewise be clobbered by a late renderer write.
 *
 * `SessionQueue` fixes both:
 *   - a single in-memory authoritative aggregate, loaded once (single-flight),
 *   - all mutations serialized through one promise chain so each builds on the
 *     latest in-memory state (never a stale disk read),
 *   - a quit transaction flag that drops late non-quit writes so the clean-exit
 *     marker wins the race.
 *
 * IO (load + atomic persist) is dependency-injected so the queue logic is
 * unit-testable without Electron or the filesystem.
 */

import type { SessionSnapshotV2 } from './session-schema';

export interface SessionQueueIO {
  /** Load the persisted aggregate (migrate-on-read). Called at most once. */
  load(): Promise<SessionSnapshotV2>;
  /** Atomically persist the aggregate. */
  persist(state: SessionSnapshotV2): Promise<void>;
}

export class SessionQueue {
  private loadPromise: Promise<SessionSnapshotV2> | null = null;
  private state: SessionSnapshotV2 | null = null;
  /** Serialization chain; each mutation awaits the previous one (success or failure). */
  private chain: Promise<unknown> = Promise.resolve();
  private quitting = false;

  constructor(private readonly io: SessionQueueIO) {}

  /** Single-flight load into the authoritative in-memory aggregate. */
  private async ensureLoaded(): Promise<SessionSnapshotV2> {
    if (this.state) return this.state;
    if (!this.loadPromise) this.loadPromise = this.io.load();
    this.state = await this.loadPromise;
    return this.state;
  }

  /**
   * Read the authoritative aggregate (loads once). Callers MUST treat the result
   * as read-only; mutations go through {@link mutate}.
   */
  read(): Promise<SessionSnapshotV2> {
    return this.ensureLoaded();
  }

  /**
   * Serialized read-modify-write. `mutator` receives the latest authoritative
   * aggregate and returns the next one, which is committed to memory and
   * persisted atomically. After {@link beginQuit}, a non-quit mutation is a
   * no-op (returns the current state) so the clean-exit transaction is not
   * overwritten by a late renderer write.
   */
  mutate(
    mutator: (current: SessionSnapshotV2) => SessionSnapshotV2,
    opts: { allowDuringQuit?: boolean } = {},
  ): Promise<SessionSnapshotV2> {
    const run = this.chain.then(async () => {
      const current = await this.ensureLoaded();
      if (this.quitting && !opts.allowDuringQuit) {
        return current;
      }
      const next = mutator(current);
      await this.io.persist(next);
      this.state = next;
      return next;
    });
    // Keep the chain alive even if this mutation rejects, so a single persist
    // failure does not wedge every later write.
    this.chain = run.catch(() => {});
    return run;
  }

  /** Begin the quit transaction: subsequent non-quit mutations become no-ops. */
  beginQuit(): void {
    this.quitting = true;
  }

  isQuitting(): boolean {
    return this.quitting;
  }
}
