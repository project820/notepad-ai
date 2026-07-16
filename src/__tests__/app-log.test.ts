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
  logError,
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
  it('redacts path edge forms without redacting ordinary HTTPS URLs', () => {
    const field = formatAppLogField('Error:/Users/x/private ~alice/Documents/private /Users/x/App  Support/y /Users/x/private) /Users/x/private` https://example.com/path');
    expect(field).toContain('Error:[REDACTED_PATH]');
    expect(field).toContain('[REDACTED_PATH]');
    expect(field).not.toContain('/Users/x/private');
    expect(field).not.toContain('~alice/Documents/private');
    expect(field).not.toContain('Support/y');
    expect(field).not.toContain('private)');
    expect(field).not.toContain('private`');
    expect(field).toContain('https://example.com/path');

    const normalUrl = 'HTTPS://EXAMPLE.COM/x?mode=preview';
    expect(formatAppLogField(normalUrl)).toBe(normalUrl);
    expect(formatAppLogField('https://host/upload?file=/Users/john/doc.md&mode=preview'))
      .toBe('https://host/upload?file=[REDACTED_PATH]&mode=preview');
    expect(formatAppLogField('https://host/upload?file=%2FUsers%2Fjohn%2Fdoc.md'))
      .toBe('https://host/upload?file=[REDACTED_PATH]');
  });
  it('redacts bare password-like assignments but preserves unrelated keys', () => {
    const field = formatAppLogField('password=hunter2 secret: abc credentials=xyz monkey=banana key=harmless');
    expect(field).toContain('password=[REDACTED_SECRET]');
    expect(field).toContain('secret:[REDACTED_SECRET]');
    expect(field).toContain('credentials=[REDACTED_SECRET]');
    expect(field).toContain('monkey=banana');
    expect(field).toContain('key=harmless');
    expect(field).not.toContain('hunter2');
    expect(field).not.toContain('abc');
    expect(field).not.toContain('xyz');
  });
  it('pre-caps large fields before redaction', () => {
    const field = formatAppLogField(`password=${'a'.repeat(5000)} TAIL`);
    expect(field).toContain('[REDACTED_SECRET]');
    expect(field).not.toContain('TAIL');
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
  it('redacts suffixed secret assignments case-insensitively', () => {
    const field = formatAppLogField('XAI_API_KEY=secret-xai GITHUB_TOKEN: secret-github MY_ACCESS_TOKEN=secret-access xAi_SeCrEt: secret-secret my_password=secret-password');
    expect(field).toContain('XAI_API_KEY=[REDACTED_SECRET]');
    expect(field).toContain('GITHUB_TOKEN:[REDACTED_SECRET]');
    expect(field).toContain('MY_ACCESS_TOKEN=[REDACTED_SECRET]');
    expect(field).toContain('xAi_SeCrEt:[REDACTED_SECRET]');
    expect(field).toContain('my_password=[REDACTED_SECRET]');
    expect(field).not.toContain('secret-xai');
    expect(field).not.toContain('secret-github');
    expect(field).not.toContain('secret-access');
    expect(field).not.toContain('secret-secret');
    expect(field).not.toContain('secret-password');
  });
  it('redacts token assignments and authorization values from persisted fields', async () => {
    const writes: string[] = [];
    const modelId = 'caller-model?token=secret-model-token';
    configureAppLog({
      logDir: () => 'logs',
      now: () => Date.parse('2026-07-16T12:00:00.000Z'),
      appendFile: async (_filePath, data) => {
        writes.push(data);
      },
      readdir: async () => [],
      unlink: async () => undefined,
      mkdir: async () => undefined,
    });

    await appLog('info', 'html-export', 'generate start', {
      model: modelId,
      detail: 'access_token=secret-access refresh_token=secret-refresh authorization: Basic secret-auth',
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]).not.toContain('token=secret');
    expect(writes[0]).not.toContain('secret-model-token');
    expect(writes[0]).not.toContain('secret-access');
    expect(writes[0]).not.toContain('secret-refresh');
    expect(writes[0]).not.toContain('secret-auth');
    expect(writes[0]).toContain('token=[REDACTED_SECRET]');
    expect(writes[0]).toContain('authorization: [REDACTED_SECRET]');
  });
  it('redacts file URLs and absolute paths with spaces', () => {
    const fileUrl = ['file:', '', '', 'Users', 'example', 'private'].join('/');
    const spacedPath = ['', 'Users', 'example', 'Library', 'Application Support', 'private'].join('/');
    const field = formatAppLogField(`failed at ${fileUrl} or ${spacedPath}`);

    expect(field).toContain('[REDACTED_PATH]');
    expect(field).not.toContain(fileUrl);
    expect(field).not.toContain(spacedPath);
    expect(field).not.toContain('Application Support');
  });
  it('redacts complete home-relative paths with spaces', () => {
    const homePath = ['~', 'Library', 'Application Support', 'private'].join('/');
    const field = formatAppLogField(`failed at ${homePath}`);

    expect(field).toContain('[REDACTED_PATH]');
    expect(field).not.toContain(homePath);
    expect(field).not.toContain('Application Support');
    expect(field).not.toContain('Support/private');
  });

  it('logs generate exceptions with fixed fields, not exception text', async () => {
    const writes: string[] = [];
    const error = new Error('token=abc authorization: Bearer sensitive-value');
    configureAppLog({
      logDir: () => 'logs',
      now: () => Date.parse('2026-07-16T12:00:00.000Z'),
      appendFile: async (_filePath, data) => {
        writes.push(data);
      },
      readdir: async () => [],
      unlink: async () => undefined,
      mkdir: async () => undefined,
    });

    await logError('html-export', 'generate threw', {
      webContentsId: 1,
      stage: 'generate',
      kind: 'exception',
      code: 'unknown_error',
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('stage=generate kind=exception code=unknown_error');
    expect(writes[0]).not.toContain(error.message);
    expect(writes[0]).not.toContain('token=abc');
    expect(writes[0]).not.toContain('Bearer sensitive-value');
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
  it('uses one clock value for the log line and file day', async () => {
    const writes: Array<{ path: string; data: string }> = [];
    const now = vi.fn()
      .mockReturnValueOnce(Date.parse('2026-07-16T23:59:59.999Z'))
      .mockReturnValue(Date.parse('2026-07-17T00:00:00.000Z'));
    configureAppLog({
      logDir: () => 'logs',
      now,
      appendFile: async (filePath, data) => {
        writes.push({ path: filePath, data });
      },
      readdir: async () => [],
      unlink: async () => undefined,
      mkdir: async () => undefined,
    });

    await appLog('info', 'boot', 'ready');

    expect(writes[0].data).toContain('2026-07-16T23:59:59.999Z');
    expect(writes[0].path).toBe('logs/app-2026-07-16.log');
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
  it('treats an already-unlinked expired file as a successful prune', async () => {
    const readdir = vi.fn(async () => ['app-2026-07-10.log']);
    configureAppLog({
      logDir: () => 'logs',
      now: () => Date.parse('2026-07-16T12:00:00.000Z'),
      appendFile: async () => undefined,
      readdir,
      unlink: async () => {
        throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      },
      mkdir: async () => undefined,
    });

    await appLog('info', 'boot', 'first write');
    await new Promise((r) => setTimeout(r, 0));
    await appLog('info', 'boot', 'second write');
    await new Promise((r) => setTimeout(r, 0));

    expect(readdir).toHaveBeenCalledTimes(1);
  });
  it('does not let a settled old prune clobber a new in-flight prune after reconfiguration', async () => {
    let resolveOldReaddir: (names: string[]) => void = () => undefined;
    const oldReaddir = vi.fn(() => new Promise<string[]>((resolve) => {
      resolveOldReaddir = resolve;
    }));
    configureAppLog({
      logDir: () => 'old-logs',
      now: () => Date.parse('2026-07-16T12:00:00.000Z'),
      appendFile: async () => undefined,
      readdir: oldReaddir,
      unlink: async () => undefined,
      mkdir: async () => undefined,
    });
    await appLog('info', 'boot', 'first write');

    const newReaddir = vi.fn(() => new Promise<string[]>(() => undefined));
    configureAppLog({
      logDir: () => 'new-logs',
      now: () => Date.parse('2026-07-16T12:00:00.000Z'),
      appendFile: async () => undefined,
      readdir: newReaddir,
      unlink: async () => undefined,
      mkdir: async () => undefined,
    });
    await appLog('info', 'boot', 'second write');

    resolveOldReaddir([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await appLog('info', 'boot', 'overlapping write');

    expect(oldReaddir).toHaveBeenCalledTimes(1);
    expect(newReaddir).toHaveBeenCalledTimes(1);
  });
  it('retries a failed prune after an overlapping write', async () => {
    let rejectFirstReaddir: (reason?: unknown) => void = () => undefined;
    const firstReaddir = new Promise<string[]>((_, reject) => {
      rejectFirstReaddir = reject;
    });
    const readdir = vi
      .fn()
      .mockReturnValueOnce(firstReaddir)
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
    await appLog('info', 'boot', 'overlapping write');
    rejectFirstReaddir(new Error('temporary failure'));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(readdir).toHaveBeenCalledTimes(2);
    expect(unlink).toHaveBeenCalledWith('logs/app-2026-07-10.log');
  });
});
