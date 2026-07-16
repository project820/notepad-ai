/**
 * Main-process rolling file log for field diagnosis.
 *
 * Writes under userData/logs/app-YYYY-MM-DD.log (UTC day). Retention is a hard
 * 3 calendar days so agents can inspect recent failures without dredging forever.
 *
 * Safety: never write secrets (API keys, tokens, full prompts). Callers pass
 * short structured fields only; values are stringified and hard-capped.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

export const APP_LOG_RETENTION_DAYS = 3;
const APP_LOG_LINE_MAX_CHARS = 4_000;
const APP_LOG_FIELD_MAX_CHARS = 512;
const REDACTED_PATH = '[REDACTED_PATH]';
const REDACTED_SECRET = '[REDACTED_SECRET]';

function redactAppLogText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/\-=]+/gi, `Bearer ${REDACTED_SECRET}`)
    .replace(/\bsk-[A-Za-z0-9_-]{4,}\b/g, REDACTED_SECRET)
    .replace(/\bapi[_-]?key\s*([=:])\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, (_match, separator: string) => `api_key${separator}${REDACTED_SECRET}`)
    .replace(/(^|[\s"'(=])(?:file:\/\/)?(?:~(?:\/[^\s"'`,;:()[\]{}\/]+(?: [^\s"'`,;:()[\]{}\/]+)*)+|(?:\/[^\s"'`,;:()[\]{}\/]+(?: [^\s"'`,;:()[\]{}\/]+)*(?=\/))*\/[^\s"'`,;:()[\]{}\/]+)/g, `$1${REDACTED_PATH}`);
}

export type AppLogLevel = 'info' | 'warn' | 'error';

export type AppLogFields = Record<string, string | number | boolean | null | undefined>;

type AppLogDeps = {
  /** Absolute directory for log files (created on demand). */
  logDir: () => string;
  /** Injectable clock (ms since epoch). */
  now?: () => number;
  /** Injectable append (tests). */
  appendFile?: (filePath: string, data: string) => Promise<void>;
  /** Injectable readdir (tests). */
  readdir?: (dir: string) => Promise<string[]>;
  /** Injectable unlink (tests). */
  unlink?: (filePath: string) => Promise<void>;
  /** Injectable mkdir (tests). */
  mkdir?: (dir: string) => Promise<void>;
};

let deps: AppLogDeps | null = null;
let pruneInFlight: Promise<void> | null = null;
let lastPruneDay = '';
let pruneRetryRequested = false;

function clock(): number {
  return deps?.now?.() ?? Date.now();
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function logFileName(day: string): string {
  return `app-${day}.log`;
}

function clampText(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

/** Serialize a field value for a single log line (no newlines, hard-capped). */
export function formatAppLogField(value: string | number | boolean | null | undefined): string {
  if (value === undefined) return '';
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  return clampText(redactAppLogText(value.replace(/[\r\n\t]+/g, ' ').trim()), APP_LOG_FIELD_MAX_CHARS);
}

export function formatAppLogLine(
  level: AppLogLevel,
  scope: string,
  message: string,
  fields?: AppLogFields,
  nowMs: number = clock(),
): string {
  const ts = new Date(nowMs).toISOString();
  const parts = [`${ts} ${level.toUpperCase()} [${clampText(scope, 64)}] ${formatAppLogField(message)}`];
  if (fields) {
    for (const [key, raw] of Object.entries(fields)) {
      if (raw === undefined) continue;
      const safeKey = clampText(key.replace(/[^\w.-]/g, '_'), 64);
      parts.push(`${safeKey}=${formatAppLogField(raw)}`);
    }
  }
  return clampText(parts.join(' '), APP_LOG_LINE_MAX_CHARS) + '\n';
}

/** Days strictly older than (todayUTC - retentionDays) are expired. */
export function isExpiredAppLogDay(day: string, todayUtc: string, retentionDays = APP_LOG_RETENTION_DAYS): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{4}-\d{2}-\d{2}$/.test(todayUtc)) return false;
  const dayMs = Date.parse(`${day}T00:00:00.000Z`);
  const todayMs = Date.parse(`${todayUtc}T00:00:00.000Z`);
  if (!Number.isFinite(dayMs) || !Number.isFinite(todayMs)) return false;
  const ageDays = Math.floor((todayMs - dayMs) / 86_400_000);
  return ageDays > retentionDays;
}

export function parseAppLogDayFromFileName(name: string): string | null {
  const m = /^app-(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
  return m ? m[1] : null;
}

/**
 * Configure the process-global logger. Safe to call once at startup after
 * userData path is set. Subsequent calls replace deps (tests).
 */
export function configureAppLog(next: AppLogDeps): void {
  deps = next;
  lastPruneDay = '';
  pruneRetryRequested = false;
}

async function ensureDir(): Promise<string | null> {
  if (!deps) return null;
  const dir = deps.logDir();
  const mkdir = deps.mkdir ?? ((d: string) => fs.mkdir(d, { recursive: true }).then(() => undefined));
  try {
    await mkdir(dir);
    return dir;
  } catch {
    return null;
  }
}

async function pruneExpired(dir: string): Promise<boolean> {
  if (!deps) return true;
  const today = utcDay(clock());
  if (lastPruneDay === today) return true;
  const readdir = deps.readdir ?? ((d: string) => fs.readdir(d));
  const unlink = deps.unlink ?? ((p: string) => fs.unlink(p).then(() => undefined));
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return false;
  }
  const pruneSucceeded = await Promise.all(
    names.map(async (name) => {
      const day = parseAppLogDayFromFileName(name);
      if (!day || !isExpiredAppLogDay(day, today)) return true;
      try {
        await unlink(path.join(dir, name));
      } catch {
        return false;
      }
      return true;
    }),
  );
  if (pruneSucceeded.every(Boolean)) {
    lastPruneDay = today;
    return true;
  }
  return false;
}

function schedulePrune(dir: string, retryAfterFailure = true): void {
  if (pruneInFlight) {
    pruneRetryRequested = true;
    return;
  }
  const finish = (pruneSucceeded: boolean) => {
    pruneInFlight = null;
    const retry = pruneRetryRequested || (!pruneSucceeded && retryAfterFailure);
    pruneRetryRequested = false;
    if (retry) schedulePrune(dir, false);
  };
  pruneInFlight = pruneExpired(dir).then(finish, () => finish(false));
}

/**
 * Append one structured log line. Never throws to callers.
 * Fire-and-forget by default; returns the write promise for tests.
 */
export function appLog(
  level: AppLogLevel,
  scope: string,
  message: string,
  fields?: AppLogFields,
): Promise<void> {
  if (!deps) return Promise.resolve();
  const line = formatAppLogLine(level, scope, message, fields, clock());
  const day = utcDay(clock());
  const write = (async () => {
    const dir = await ensureDir();
    if (!dir) return;
    schedulePrune(dir);
    const filePath = path.join(dir, logFileName(day));
    const append = deps!.appendFile ?? ((p: string, data: string) => fs.appendFile(p, data, 'utf8'));
    try {
      await append(filePath, line);
    } catch {
      // Logging must never break product paths.
    }
  })();
  return write;
}

export const logInfo = (scope: string, message: string, fields?: AppLogFields) => appLog('info', scope, message, fields);
export const logWarn = (scope: string, message: string, fields?: AppLogFields) => appLog('warn', scope, message, fields);
export const logError = (scope: string, message: string, fields?: AppLogFields) => appLog('error', scope, message, fields);

/** Absolute path of today's log file (for diagnostics messages). */
export function todayAppLogPath(): string | null {
  if (!deps) return null;
  return path.join(deps.logDir(), logFileName(utcDay(clock())));
}
