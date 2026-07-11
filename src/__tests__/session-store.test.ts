import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let userData = '';

vi.mock('electron', () => ({
  app: {
    getPath: () => userData,
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  if (userData) rmSync(userData, { recursive: true, force: true });
  userData = '';
});

describe('session-store corrupt recovery', () => {
  it('starts empty and quarantines malformed session input without throwing', async () => {
    userData = mkdtempSync(join(tmpdir(), 'notepad-ai-session-store-'));
    writeFileSync(join(userData, 'session.json'), '{not valid JSON', 'utf8');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { getSessionAggregate } = await import('../main/session-store');

    await expect(getSessionAggregate()).resolves.toEqual({ version: 2, windows: [] });
    const quarantined = readdirSync(userData).filter((name) => /^session\.json\.corrupt-\d+$/.test(name));
    expect(quarantined).toHaveLength(1);
    expect(error).toHaveBeenCalledWith(
      '[session] recovery read failed; starting with an empty session',
      expect.objectContaining({
        sessionPath: join(userData, 'session.json'),
        quarantinedPath: join(userData, quarantined[0]),
      }),
    );
  });
});
