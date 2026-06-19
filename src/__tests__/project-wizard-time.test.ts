import { describe, it, expect, vi, afterEach } from 'vitest';
import { nowInSeoulIso } from '../main/project-wizard/time';

describe('nowInSeoulIso', () => {
  afterEach(() => vi.useRealTimers());

  it('formats local Seoul time with seconds and +09:00 offset', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-15T05:40:32.109Z'));

    expect(nowInSeoulIso()).toBe('2026-05-15T14:40:32+09:00');
  });
});
