export type SessionSnapshotScheduler = {
  schedule: () => void;
  cancel: () => void;
};

const DEBOUNCE_MS = 1500;
const MAX_WAIT_MS = 5000;

/** Debounce snapshot writes without allowing ongoing edits to defer them indefinitely. */
export function createSessionSnapshotScheduler(write: () => void): SessionSnapshotScheduler {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;

  const run = () => {
    if (debounceTimer === null && maxWaitTimer === null) return;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    if (maxWaitTimer !== null) clearTimeout(maxWaitTimer);
    debounceTimer = null;
    maxWaitTimer = null;
    write();
  };

  return {
    schedule() {
      if (maxWaitTimer === null) maxWaitTimer = setTimeout(run, MAX_WAIT_MS);
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(run, DEBOUNCE_MS);
    },
    cancel() {
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      if (maxWaitTimer !== null) clearTimeout(maxWaitTimer);
      debounceTimer = null;
      maxWaitTimer = null;
    },
  };
}
