import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  APP_LOG_RETENTION_DAYS,
  configureAppLog,
  formatAppLogField,
  formatAppLogLine,
  isExpiredAppLogDay,
  parseAppLogDayFromFileName,
  appLog,
  todayAppLogPath,
} from '../main/app-log';

describe('app-log', () => {
  beforeEach(() => {
    configureAppLog({
      logDir: () => '/tmp/notepad-ai-test-logs',
      now: () => Date.parse('2026-07-16T12:00:00.000Z'),
      appendFile: async () => undefined,
      readdir: async () => [],
      unlink: async () => undefined,
      mkdir: async () => undefined,
    });
  });

  it('parses day from file names and rejects junk', () => {
    expect(parseAppLogDayFromFileName('app-2026-07-16.log')).toBe('2026-07-16');
    expect(parseAppLogDayFromFileName('app-2026-7-16.log')).toBeNull();
    expect(parseAppLogDayFromFileName('other.log')).toBeNull();
  });

  it(`expires only days older than ${APP_LOG_RETENTION_DAYS} calendar days`, () => {
    const today = '2026-07-16';
    expect(isExpiredAppLogDay('2026-07-16', today)).toBe(false);
    expect(isExpiredAppLogDay('2026-07-13', today)).toBe(false); // age 3 — keep
    expect(isExpiredAppLogDay('2026-07-12', today)).toBe(true); // age 4 — drop
    expect(isExpiredAppLogDay('not-a-day', today)).toBe(false);
  });

  it('clamps field text and strips newlines', () => {
    expect(formatAppLogField('a\nb\tc')).toBe('a b c');
    expect(formatAppLogField('x'.repeat(600)).endsWith('…')).toBe(true);
  });
  it('redacts absolute paths and secret-like values from fields and messages', () => {
    const absolutePath = ['', 'Users', 'example', 'private'].join('/');
    const homePath = ['~', 'Library', 'private'].join('/');
    const field = formatAppLogField(`failed at ${absolutePath} or ${homePath} with Bearer token-value and api_key=example-secret sk-example-secret`);
    const line = formatAppLogLine('error', 'export', `failed at ${absolutePath}`, { detail: field });

    expect(field).toContain('[REDACTED_PATH]');
    expect(field).toContain('Bearer [REDACTED_SECRET]');
    expect(field).toContain('api_key=[REDACTED_SECRET]');
    expect(field).toContain('[REDACTED_SECRET]');
    expect(field).not.toContain(absolutePath);
    expect(field).not.toContain(homePath);
    expect(line).not.toContain(absolutePath);
  });

  it('formats a single-line structured record', () => {
    const line = formatAppLogLine(
      'error',
      'html-export',
      'generation failed',
      { stage: 'sanitize', kind: 'pipeline-reject', provider: 'claude' },
      Date.parse('2026-07-16T12:00:00.000Z'),
    );
    expect(line.endsWith('\n')).toBe(true);
    expect(line).toContain('ERROR [html-export] generation failed');
    expect(line).toContain('stage=sanitize');
    expect(line).toContain('kind=pipeline-reject');
    expect(line).not.toContain('\nstage');
  });

  it('writes through appendFile and reports today path', async () => {
    const writes: Array<{ path: string; data: string }> = [];
    configureAppLog({
      logDir: () => '/tmp/notepad-ai-test-logs',
      now: () => Date.parse('2026-07-16T12:00:00.000Z'),
      appendFile: async (filePath, data) => {
        writes.push({ path: filePath, data });
      },
      readdir: async () => ['app-2026-07-10.log', 'app-2026-07-15.log', 'notes.txt'],
      unlink: vi.fn(async () => undefined),
      mkdir: async () => undefined,
    });
    expect(todayAppLogPath()).toBe('/tmp/notepad-ai-test-logs/app-2026-07-16.log');
    await appLog('info', 'boot', 'ready', { version: '0.7.0' });
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe('/tmp/notepad-ai-test-logs/app-2026-07-16.log');
    expect(writes[0].data).toContain('INFO [boot] ready');
    expect(writes[0].data).toContain('version=0.7.0');
  });

  it('unlinks only expired app-*.log files during prune', async () => {
    const unlinked: string[] = [];
    configureAppLog({
      logDir: () => '/tmp/notepad-ai-test-logs',
      now: () => Date.parse('2026-07-16T12:00:00.000Z'),
      appendFile: async () => undefined,
      readdir: async () => ['app-2026-07-10.log', 'app-2026-07-13.log', 'app-2026-07-15.log', 'keep.txt'],
      unlink: async (filePath) => {
        unlinked.push(filePath);
      },
      mkdir: async () => undefined,
    });
    await appLog('info', 'boot', 'ready');
    // prune is scheduled fire-and-forget; wait a tick
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(unlinked.some((p) => p.endsWith('app-2026-07-10.log'))).toBe(true);
    expect(unlinked.some((p) => p.endsWith('app-2026-07-13.log'))).toBe(false);
    expect(unlinked.some((p) => p.endsWith('keep.txt'))).toBe(false);
  });
  it('retries pruning after a transient directory listing failure', async () => {
    const readdir = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(['app-2026-07-10.log']);
    const unlink = vi.fn(async () => undefined);
    configureAppLog({
      logDir: () => 'logs',
      now: () => Date.parse('2026-07-16T12:00:00.000Z'),
      appendFile: async () => undefined,
      readdir,
      unlink,
      mkdir: async () => undefined,
    });

    await appLog('info', 'boot', 'first write');
    await new Promise((r) => setTimeout(r, 0));
    await appLog('info', 'boot', 'second write');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(readdir).toHaveBeenCalledTimes(2);
    expect(unlink).toHaveBeenCalledWith('logs/app-2026-07-10.log');
  });
});
