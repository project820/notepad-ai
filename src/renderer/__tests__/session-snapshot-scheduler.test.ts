import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionSnapshotScheduler } from '../session-snapshot-scheduler';

afterEach(() => {
  vi.useRealTimers();
});

describe('createSessionSnapshotScheduler', () => {
  it('writes the latest snapshot at each max-wait boundary during continuous edits', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    let document = '';
    const sessionWrite = vi.fn(() => ({ doc: document, at: Date.now() }));
    const scheduler = createSessionSnapshotScheduler(sessionWrite);

    document = 'edit-0';
    scheduler.schedule();
    for (let second = 1; second <= 12; second += 1) {
      vi.advanceTimersByTime(1000);
      document = `edit-${second}`;
      scheduler.schedule();
    }

    expect(sessionWrite).toHaveBeenCalledTimes(2);
    expect(sessionWrite.mock.results.map(({ value }) => value)).toEqual([
      { doc: 'edit-4', at: 5000 },
      { doc: 'edit-9', at: 10_000 },
    ]);
  });
});
