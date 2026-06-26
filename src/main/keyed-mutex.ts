/**
 * keyed-mutex.ts — per-key async serialization (Phase 2 file-ownership).
 *
 * The insane-review flagged that `file:save` checked the duplicate-path claim and
 * then wrote, with the claim only recorded AFTER the write — two windows racing
 * the same path could both pass the check and both write. A per-canonical-path
 * mutex serializes the reserve→write→commit sequence so only one save touches a
 * given file identity at a time.
 *
 * Minimal, dependency-free, and unit-testable.
 */

export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();

  /**
   * Run `fn` with exclusive access for `key`. Calls for the same key run strictly
   * one-at-a-time in arrival order; different keys run concurrently. The lock is
   * released even if `fn` rejects.
   */
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const result = prev.then(fn, fn);
    // Keep the chain alive regardless of fn's outcome; clean up when this is the tail.
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  /** Number of keys with an active/queued chain (for tests/diagnostics). */
  get activeKeys(): number {
    return this.tails.size;
  }
}
