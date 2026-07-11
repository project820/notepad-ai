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

  it('writes once after the 1.5s trailing debounce when edits go quiet', () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const scheduler = createSessionSnapshotScheduler(write);

    scheduler.schedule();
    vi.advanceTimersByTime(1499);
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(write).toHaveBeenCalledTimes(1);

    // A quiet period leaves no lingering timer.
    vi.advanceTimersByTime(10_000);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('still writes (and then settles) when the debounce and max-wait deadlines coincide', () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const scheduler = createSessionSnapshotScheduler(write);

    // First edit arms max-wait at t=5000; a later edit at t=3500 arms debounce at t=5000 too.
    scheduler.schedule();
    vi.advanceTimersByTime(3500);
    scheduler.schedule();
    vi.advanceTimersByTime(1500);
    // A coincident-deadline tick must not starve the write; extra edits later start a fresh cycle.
    expect(write).toHaveBeenCalled();

    write.mockClear();
    vi.advanceTimersByTime(10_000);
    expect(write).not.toHaveBeenCalled();
  });

  it('does not write after cancel', () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const scheduler = createSessionSnapshotScheduler(write);

    scheduler.schedule();
    scheduler.cancel();
    vi.advanceTimersByTime(10_000);
    expect(write).not.toHaveBeenCalled();
  });

  it('starts a fresh cycle after cancel + reschedule (single write)', () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const scheduler = createSessionSnapshotScheduler(write);

    scheduler.schedule();
    vi.advanceTimersByTime(1000);
    scheduler.cancel();
    scheduler.schedule();
    vi.advanceTimersByTime(1500);
    expect(write).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(write).toHaveBeenCalledTimes(1);
  });
});
