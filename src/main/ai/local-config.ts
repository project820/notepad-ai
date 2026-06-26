/**
 * Local AI provider configuration (Ollama / LM Studio).
 *
 * Local providers are NOT a secret-bearing surface: the only setting is a base
 * URL, so this config is stored as plaintext JSON in userData (NOT via
 * safeStorage). Security is enforced by `normalizeLocalBaseUrl`, which accepts
 * only localhost http(s) origins and rejects remote hosts and `file:` URLs.
 *
 * Discovery requests (/api/tags, /api/show, /v1/models) all run under
 * `withLocalTimeout` (500ms hard timeout via AbortController + race) so a slow
 * or hung local server can never block the cloud model picker. Chat streaming is
 * generation, not discovery, so it is NOT subject to this timeout — it follows
 * the caller's cancel signal instead.
 */

/** Default Ollama server origin. */
export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
/** Default LM Studio server origin. */
export const DEFAULT_LMSTUDIO_BASE_URL = 'http://127.0.0.1:1234';
/** Hard timeout (ms) applied to every local DISCOVERY request. */
export const LOCAL_DISCOVERY_TIMEOUT_MS = 500;

/** Hostnames considered local. IPv6 brackets are stripped before comparison. */
const ALLOWED_LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Normalize and validate a local server base URL.
 *
 * Returns the canonical origin (`protocol//host[:port]`, no path / no trailing
 * slash) when the input is a localhost http(s) URL; otherwise `null`. Remote
 * hosts, `file:` URLs, non-http(s) schemes, and malformed input are rejected.
 */
export function normalizeLocalBaseUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (!ALLOWED_LOCAL_HOSTS.has(host)) return null;
  const portPart = url.port ? `:${url.port}` : '';
  return `${url.protocol}//${url.hostname}${portPart}`;
}

/** Local provider configuration: a base URL per local provider. */
export type LocalProviderConfig = {
  ollama: string;
  lmstudio: string;
};

/** The default local configuration. */
export function defaultLocalConfig(): LocalProviderConfig {
  return { ollama: DEFAULT_OLLAMA_BASE_URL, lmstudio: DEFAULT_LMSTUDIO_BASE_URL };
}

/**
 * Parse persisted config JSON into a validated {@link LocalProviderConfig}.
 * Invalid / remote / malformed URLs fall back to the supplied defaults. Pure.
 */
export function parseLocalConfig(raw: string, defaults: LocalProviderConfig = defaultLocalConfig()): LocalProviderConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...defaults };
  }
  if (!parsed || typeof parsed !== 'object') return { ...defaults };
  const obj = parsed as Record<string, unknown>;
  return {
    ollama: normalizeLocalBaseUrl(obj.ollama) ?? defaults.ollama,
    lmstudio: normalizeLocalBaseUrl(obj.lmstudio) ?? defaults.lmstudio,
  };
}

/** Injected persistence backend so the store is unit-testable without Electron. */
export interface LocalConfigBackend {
  readFile(): Promise<string | null>;
  writeFile(json: string): Promise<void>;
}

/**
 * Reads/writes the local provider config. Validates every URL through
 * `normalizeLocalBaseUrl` on write, so a remote / `file:` URL never reaches disk.
 */
export class LocalConfigStore {
  private loadPromise: Promise<void> | null = null;
  private config: LocalProviderConfig = defaultLocalConfig();
  /** Serializes set() so concurrent writes never clobber each other (H-26). */
  private mutationChain: Promise<unknown> = Promise.resolve();

  constructor(private backend: LocalConfigBackend) {}

  /** Single-flight load: concurrent callers share one read (no init race). */
  private load(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        const raw = await this.backend.readFile();
        if (raw) this.config = parseLocalConfig(raw);
      })();
    }
    return this.loadPromise;
  }

  async get(): Promise<LocalProviderConfig> {
    await this.load();
    return { ...this.config };
  }

  /**
   * Update one or both base URLs. Each provided URL must normalize to a valid
   * localhost http(s) origin; otherwise this throws and nothing is persisted.
   * Mutations are serialized and the runtime config is committed ONLY after the
   * durable write succeeds (a write failure never activates a half-applied URL).
   */
  set(partial: Partial<LocalProviderConfig>): Promise<LocalProviderConfig> {
    const run = this.mutationChain.then(async () => {
      await this.load();
      const next: LocalProviderConfig = { ...this.config };
      if (partial.ollama !== undefined) {
        const normalized = normalizeLocalBaseUrl(partial.ollama);
        if (!normalized) throw new Error('Ollama URL must be a localhost http(s) URL.');
        next.ollama = normalized;
      }
      if (partial.lmstudio !== undefined) {
        const normalized = normalizeLocalBaseUrl(partial.lmstudio);
        if (!normalized) throw new Error('LM Studio URL must be a localhost http(s) URL.');
        next.lmstudio = normalized;
      }
      await this.backend.writeFile(JSON.stringify(next));
      this.config = next;
      return { ...next };
    });
    this.mutationChain = run.catch(() => {});
    return run;
  }
}

/** Thrown by {@link withLocalTimeout} when the wrapped op exceeds its budget. */
export class LocalTimeoutError extends Error {
  constructor(ms: number) {
    super(`Local request timed out after ${ms}ms`);
    this.name = 'LocalTimeoutError';
  }
}

/**
 * Run `op` with a hard timeout. `op` receives an `AbortSignal` that fires on
 * timeout (so a well-behaved fetch is cancelled), but the returned promise is
 * ALSO raced against the timer — so even an op that ignores the signal (e.g. a
 * mocked fetch that never resolves) still rejects at `ms`. This guarantees local
 * discovery can never hang the caller.
 */
export function withLocalTimeout<T>(
  op: (signal: AbortSignal) => Promise<T>,
  ms: number = LOCAL_DISCOVERY_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new LocalTimeoutError(ms));
    }, ms);
    op(controller.signal).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** GET/POST a local JSON endpoint. Throws on non-OK status. Used for discovery. */
export async function getLocalJson<T = unknown>(
  url: string,
  signal: AbortSignal,
  init: RequestInit = {},
): Promise<T> {
  const resp = await fetch(url, {
    ...init,
    signal,
    // Discovery talks to a user-configured localhost server; never follow a
    // redirect off that host (SSRF guard, mirrors the streaming fetches).
    redirect: 'error',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return (await resp.json()) as T;
}

/** Electron-bound backend: plaintext JSON in userData (NOT a secret). */
export function createElectronLocalConfigBackend(): LocalConfigBackend {
  const { app } = require('electron') as typeof import('electron');
  const { promises: fsp } = require('node:fs') as typeof import('node:fs');
  const nodePath = require('node:path') as typeof import('node:path');
  const filePath = () => nodePath.join(app.getPath('userData'), 'local-ai-config.json');
  return {
    readFile: async () => {
      try {
        return await fsp.readFile(filePath(), 'utf-8');
      } catch {
        return null;
      }
    },
    writeFile: async (json) => {
      await fsp.mkdir(nodePath.dirname(filePath()), { recursive: true });
      await fsp.writeFile(filePath(), json, 'utf-8');
    },
  };
}
