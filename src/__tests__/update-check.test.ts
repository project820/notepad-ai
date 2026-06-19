import { describe, it, expect, vi } from 'vitest';
import { parseVersion, isNewerVersion, checkForUpdate } from '../main/update-check';

describe('parseVersion', () => {
  it('parses semver with and without leading v', () => {
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3]);
    expect(parseVersion('v0.1.2')).toEqual([0, 1, 2]);
    expect(parseVersion('0.1.2-arm64')).toEqual([0, 1, 2]);
  });
  it('returns null for unparseable input', () => {
    expect(parseVersion('latest')).toBeNull();
    expect(parseVersion('')).toBeNull();
  });
});

describe('isNewerVersion', () => {
  it('detects a strictly newer version at each level', () => {
    expect(isNewerVersion('0.1.1', '0.1.2')).toBe(true);
    expect(isNewerVersion('0.1.1', 'v0.2.0')).toBe(true);
    expect(isNewerVersion('0.1.1', '1.0.0')).toBe(true);
  });
  it('is false for same or older', () => {
    expect(isNewerVersion('0.1.2', '0.1.2')).toBe(false);
    expect(isNewerVersion('0.1.2', 'v0.1.1')).toBe(false);
    expect(isNewerVersion('1.0.0', '0.9.9')).toBe(false);
  });
  it('is false when either side is unparseable (never nag wrongly)', () => {
    expect(isNewerVersion('0.1.1', 'nightly')).toBe(false);
    expect(isNewerVersion('dev', '9.9.9')).toBe(false);
  });
});

describe('checkForUpdate', () => {
  const ok = (body: unknown) =>
    vi.fn(async () => ({ ok: true, json: async () => body }) as unknown as Response);

  it('reports an available update from the latest release tag', async () => {
    const info = await checkForUpdate('0.1.1', ok({ tag_name: 'v0.1.2', html_url: 'https://github.com/x/y/releases/tag/v0.1.2' }));
    expect(info).not.toBeNull();
    expect(info!.updateAvailable).toBe(true);
    expect(info!.latestVersion).toBe('0.1.2');
    expect(info!.url).toContain('releases/tag/v0.1.2');
  });

  it('reports no update when already latest', async () => {
    const info = await checkForUpdate('0.1.2', ok({ tag_name: 'v0.1.2' }));
    expect(info!.updateAvailable).toBe(false);
  });

  it('returns null on non-ok response', async () => {
    const info = await checkForUpdate('0.1.1', vi.fn(async () => ({ ok: false }) as unknown as Response));
    expect(info).toBeNull();
  });

  it('returns null on fetch throw (offline)', async () => {
    const info = await checkForUpdate('0.1.1', vi.fn(async () => { throw new Error('offline'); }));
    expect(info).toBeNull();
  });

  it('returns null when tag is missing', async () => {
    const info = await checkForUpdate('0.1.1', ok({}));
    expect(info).toBeNull();
  });
});
