import { app, safeStorage, shell } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readCappedText, STREAM_LIMITS } from './ai/stream-http';

/**
 * OpenAI Codex device-code OAuth — ported from Hermes (auth.py).
 * Endpoints discovered:
 *   - POST https://auth.openai.com/api/accounts/deviceauth/usercode   (request user code)
 *   - POST https://auth.openai.com/api/accounts/deviceauth/token      (poll for authorization_code)
 *   - POST https://auth.openai.com/oauth/token                        (final code -> tokens)
 *
 * Tokens are stored under app userData, AES-encrypted via Electron safeStorage
 * (backed by macOS Keychain).
 */

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const ISSUER = 'https://auth.openai.com';
const DEVICE_PAGE = `${ISSUER}/codex/device`;
const USERCODE_URL = `${ISSUER}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${ISSUER}/api/accounts/deviceauth/token`;
const OAUTH_TOKEN_URL = `${ISSUER}/oauth/token`;
const REDIRECT_URI = `${ISSUER}/deviceauth/callback`;
const REFRESH_SKEW_SECONDS = 120;
const REFRESH_TIMEOUT_MS = 20_000;

export type AuthWarningCode = 'secure_storage_unavailable';

export type AuthSnapshot = {
  signedIn: boolean;
  email?: string;
  plan?: string;
  expiresAt?: number;
  /** True when tokens are persisted to encrypted disk; false = memory-only (session). Non-secret. */
  persisted?: boolean;
  /** Non-secret warning code surfaced to the renderer. */
  warning?: AuthWarningCode;
};

type StoredAuth = {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  obtained_at: number;
  email?: string;
  plan?: string;
};

function storePath() {
  return path.join(app.getPath('userData'), 'codex-auth.bin');
}

// In-memory token cache. When safeStorage is unavailable we keep tokens here for
// the current session only and NEVER write plaintext to disk (S2).
let memoryAuth: StoredAuth | null = null;
let persistedToDisk = false;
// Single-flight token refresh: concurrent callers (best-effort getAccessToken AND
// forced forceRefreshAccessToken) share ONE in-flight refresh instead of each
// racing their own writeStored (H-22).
let refreshPromise: Promise<RefreshOutcome> | null = null;
// Auth generation epoch: bumped on logout/login-cancel so a refresh that began
// before a logout cannot resurrect tokens by writing them back after sign-out.
let authGeneration = 0;

/** Main-process-only env credential source (read-only). Never written. */
function readEnvAuth(): StoredAuth | null {
  const at = process.env.NOTEPAD_AI_OPENAI_ACCESS_TOKEN;
  if (!at || at.trim().length === 0) return null;
  return {
    access_token: at.trim(),
    refresh_token: process.env.NOTEPAD_AI_OPENAI_REFRESH_TOKEN?.trim() || undefined,
    obtained_at: Math.floor(Date.now() / 1000),
  };
}

/**
 * Persist auth. Encrypted disk only when safeStorage is available; otherwise the
 * tokens are cached in memory for this session only (no plaintext fallback).
 * Returns whether the data was persisted to encrypted disk.
 */
async function writeStored(data: StoredAuth): Promise<{ persisted: boolean }> {
  if (safeStorage.isEncryptionAvailable()) {
    const buf = safeStorage.encryptString(JSON.stringify(data));
    await fs.mkdir(path.dirname(storePath()), { recursive: true });
    // Durable write FIRST; commit the in-memory token only after it succeeds so a
    // failed disk write never leaves a contradictory "signed-in" memory state (H-24).
    await fs.writeFile(storePath(), buf);
    memoryAuth = data;
    persistedToDisk = true;
    return { persisted: true };
  }
  // Secure storage unavailable: memory-only for this session, never plaintext on disk.
  memoryAuth = data;
  persistedToDisk = false;
  return { persisted: false };
}

async function readStored(): Promise<StoredAuth | null> {
  if (memoryAuth) return memoryAuth;
  // Encrypted disk is the only on-disk source; never read/trust plaintext.
  if (safeStorage.isEncryptionAvailable()) {
    try {
      const buf = await fs.readFile(storePath());
      const parsed = JSON.parse(safeStorage.decryptString(buf)) as StoredAuth;
      memoryAuth = parsed;
      persistedToDisk = true;
      return parsed;
    } catch {
      /* fall through to env */
    }
  }
  // Read-only env credential source (main process only).
  const envAuth = readEnvAuth();
  if (envAuth) {
    memoryAuth = envAuth;
    persistedToDisk = false;
    return envAuth;
  }
  return null;
}

async function deleteStored(): Promise<void> {
  memoryAuth = null;
  persistedToDisk = false;
  try {
    await fs.unlink(storePath());
  } catch {
    /* ignore */
  }
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const parts = jwt.split('.');
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(b64, 'base64').toString('utf-8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function extractEmailPlan(idToken?: string): { email?: string; plan?: string } {
  if (!idToken) return {};
  const payload = decodeJwtPayload(idToken);
  if (!payload) return {};
  const email =
    (payload['email'] as string | undefined) ??
    (payload['preferred_username'] as string | undefined);
  const plan =
    (payload['https://api.openai.com/auth'] as any)?.chatgpt_plan_type ??
    (payload as any)['chatgpt_plan_type'] ??
    undefined;
  return { email, plan: typeof plan === 'string' ? plan : undefined };
}

// ---------------------------------------------------------------
// Public: login flow
// ---------------------------------------------------------------

export type LoginErrorCode =
  | 'device_code_request_failed'
  | 'device_code_response_invalid'
  | 'cancelled'
  | 'polling_failed'
  | 'polling_status_error'
  | 'timeout_or_incomplete_response'
  | 'token_exchange_failed';

export type LoginUpdate =
  | { kind: 'usercode'; userCode: string; verificationUri: string }
  | { kind: 'success'; auth: AuthSnapshot }
  | { kind: 'error'; code: LoginErrorCode; detail?: string };

let activeLoginAbort: AbortController | null = null;

export async function startLogin(onUpdate: (u: LoginUpdate) => void): Promise<void> {
  if (activeLoginAbort) activeLoginAbort.abort();
  activeLoginAbort = new AbortController();
  const signal = activeLoginAbort.signal;

  let usercodeResp: any;
  let parsingUsercodeResponse = false;
  try {
    const r = await fetch(USERCODE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID }),
      signal,
    });
    if (!r.ok) throw new Error(`usercode HTTP ${r.status}`);
    parsingUsercodeResponse = true;
    usercodeResp = await r.json();
  } catch (e: any) {
    onUpdate({
      kind: 'error',
      code: signal.aborted
        ? 'cancelled'
        : parsingUsercodeResponse
          ? 'device_code_response_invalid'
          : 'device_code_request_failed',
      ...(signal.aborted ? {} : { detail: String(e.message ?? e) }),
    });
    return;
  }

  if (
    !usercodeResp ||
    typeof usercodeResp !== 'object' ||
    typeof usercodeResp.user_code !== 'string' ||
    usercodeResp.user_code.length === 0 ||
    typeof usercodeResp.device_auth_id !== 'string' ||
    usercodeResp.device_auth_id.length === 0
  ) {
    onUpdate({ kind: 'error', code: 'device_code_response_invalid' });
    return;
  }

  const userCode = usercodeResp.user_code;
  const deviceAuthId = usercodeResp.device_auth_id;
  // Clamp the server-supplied poll interval to a sane 3–30s window. `parseInt`
  // can return NaN (and `Math.max(3, NaN)` is NaN → setTimeout(…, NaN) would
  // hammer the endpoint with ~0ms polls); Number.isFinite guards against that (H-21).
  const parsedInterval = Number.parseInt(String(usercodeResp.interval ?? '5'), 10);
  const pollInterval = (Number.isFinite(parsedInterval) ? Math.min(Math.max(parsedInterval, 3), 30) : 5) * 1000;

  onUpdate({ kind: 'usercode', userCode, verificationUri: DEVICE_PAGE });
  // Open the device-auth page in the user's default browser.
  void shell.openExternal(DEVICE_PAGE);

  const deadline = Date.now() + 15 * 60 * 1000;
  let codeResp: { authorization_code?: string; code_verifier?: string } | null = null;

  while (Date.now() < deadline) {
    if (signal.aborted) return onUpdate({ kind: 'error', code: 'cancelled' });
    await new Promise((res) => setTimeout(res, pollInterval));
    if (signal.aborted) return onUpdate({ kind: 'error', code: 'cancelled' });
    let r: Response;
    try {
      r = await fetch(DEVICE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
        signal,
      });
    } catch (e: any) {
      // An abort is a user cancel, not a network error — emit a terminal cancel
      // so the renderer's login flow resolves instead of hanging (P1 login cancel).
      if (signal.aborted) return onUpdate({ kind: 'error', code: 'cancelled' });
      onUpdate({ kind: 'error', code: 'polling_failed', detail: String(e.message ?? e) });
      return;
    }
    if (r.status === 200) {
      try {
        codeResp = await r.json();
      } catch (e: any) {
        onUpdate({
          kind: 'error',
          code: signal.aborted ? 'cancelled' : 'timeout_or_incomplete_response',
          ...(signal.aborted ? {} : { detail: String(e.message ?? e) }),
        });
        return;
      }
      break;
    }
    if (r.status === 403 || r.status === 404) continue;
    onUpdate({ kind: 'error', code: 'polling_status_error', detail: `HTTP ${r.status}` });
    return;
  }

  if (!codeResp?.authorization_code || !codeResp?.code_verifier) {
    onUpdate({ kind: 'error', code: 'timeout_or_incomplete_response' });
    return;
  }

  let tokens: any;
  try {
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: codeResp.authorization_code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: codeResp.code_verifier,
    });
    const r = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal,
    });
    if (!r.ok) throw new Error(`token exchange HTTP ${r.status}: ${await r.text()}`);
    tokens = await r.json();
  } catch (e: any) {
    onUpdate({
      kind: 'error',
      code: signal.aborted ? 'cancelled' : 'token_exchange_failed',
      ...(signal.aborted ? {} : { detail: String(e.message ?? e) }),
    });
    return;
  }

  const { email, plan } = extractEmailPlan(tokens.id_token);
  const stored: StoredAuth = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    id_token: tokens.id_token,
    token_type: tokens.token_type,
    expires_in: tokens.expires_in,
    obtained_at: Math.floor(Date.now() / 1000),
    email,
    plan,
  };
  const { persisted } = await writeStored(stored);

  onUpdate({
    kind: 'success',
    auth: {
      signedIn: true,
      email,
      plan,
      expiresAt: stored.expires_in ? stored.obtained_at + stored.expires_in : undefined,
      persisted,
      ...(persisted ? {} : { warning: 'secure_storage_unavailable' }),
    },
  });
}

export function cancelLogin() {
  activeLoginAbort?.abort();
  activeLoginAbort = null;
}

// ---------------------------------------------------------------
// Public: status + access token retrieval with refresh
// ---------------------------------------------------------------

export async function getStatus(): Promise<AuthSnapshot> {
  const s = await readStored();
  if (!s) return { signedIn: false };
  return {
    signedIn: true,
    email: s.email,
    plan: s.plan,
    expiresAt: s.expires_in ? s.obtained_at + s.expires_in : undefined,
    persisted: persistedToDisk,
  };
}

export async function logout(): Promise<void> {
  cancelLogin();
  // Bump the epoch BEFORE deleting so any refresh already in flight sees the
  // change and refuses to write tokens back after sign-out (H-22 resurrection).
  authGeneration++;
  refreshPromise = null;
  await deleteStored();
}

/**
 * Result of a hard/forced refresh (Bug A: 401 forced refresh). Unlike the
 * best-effort getAccessToken path, the forced path NEVER hands back a stale
 * access token — a 401 means the current token is already rejected, so the caller
 * must get a genuinely fresh token or a classified failure it can surface
 * (invalidated → sign-in required; transient → keep the tokens and retry later).
 */
export type RefreshAccessResult =
  | { kind: 'ok'; accessToken: string }
  | { kind: 'missing_refresh_token' }
  | { kind: 'invalidated'; marker: 'invalid_grant' | 'token_invalidated' }
  | { kind: 'transient_failure'; status?: number }
  | { kind: 'cancelled' }
  | { kind: 'stale_generation' };

/**
 * Internal outcome of the single shared refresh round-trip. Richer than the
 * public RefreshAccessResult so BOTH the best-effort (getAccessToken) and forced
 * (forceRefreshAccessToken) callers can share ONE in-flight refresh and each map
 * it to their own contract. It carries the fetched/stale token for the
 * best-effort path, which the forced path deliberately drops.
 */
type RefreshOutcome =
  | { kind: 'ok'; accessToken: string }
  | { kind: 'invalidated'; marker: 'invalid_grant' | 'token_invalidated' }
  | { kind: 'transient_failure'; status?: number; staleToken: string }
  | { kind: 'stale_generation'; accessToken: string };

/** Sentinel for a per-caller abort that must NOT cancel the shared refresh. */
const REFRESH_CANCELLED = Symbol('refresh-cancelled');

/**
 * Await `promise`, but if `signal` aborts first resolve to REFRESH_CANCELLED
 * WITHOUT aborting the underlying promise — the shared network refresh keeps
 * running so other (non-cancelled) callers still receive their token. The shared
 * fetch is therefore never tied to any per-request signal.
 */
function abortableWait<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T | typeof REFRESH_CANCELLED> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve(REFRESH_CANCELLED);
  return new Promise<T | typeof REFRESH_CANCELLED>((resolve) => {
    const onAbort = () => resolve(REFRESH_CANCELLED);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      // refreshAccessToken never rejects (it catches internally); fail closed.
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve(REFRESH_CANCELLED);
      },
    );
  });
}

/**
 * Detect an explicit refresh-token invalidation marker in an OAuth error body.
 * Parses the (capped) JSON and inspects only STRUCTURED error fields — a raw
 * whole-body substring match would delete a user's tokens for a transient error
 * whose description merely mentions these strings (destroy-on-transient anti-goal).
 */
function detectInvalidationMarker(body: string): 'invalid_grant' | 'token_invalidated' | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null; // non-JSON / truncated body → transient, retain tokens
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const j = parsed as { error?: unknown; error_code?: unknown };
  // Only an explicit, canonical OAuth error CODE counts as a terminal invalidation.
  // Accept the top-level string `error`, an `error_code`, OR a nested structured
  // `error.code` / `error.type` (e.g. {"error":{"code":"token_invalidated"}}).
  // Deliberately NOT `error_description` — a transient error whose human-readable
  // description merely mentions "invalid_grant" must NOT delete the user's tokens
  // (destroy-on-transient anti-goal).
  let code = '';
  if (typeof j.error === 'string') code = j.error;
  else if (j.error && typeof j.error === 'object') {
    const e = j.error as { code?: unknown; type?: unknown };
    if (typeof e.code === 'string') code = e.code;
    else if (typeof e.type === 'string') code = e.type;
  }
  if (!code && typeof j.error_code === 'string') code = j.error_code;
  if (code === 'invalid_grant') return 'invalid_grant';
  if (code === 'token_invalidated') return 'token_invalidated';
  return null;
}

/**
 * Single-flight guard around refreshAccessToken. Concurrent callers share ONE
 * in-flight refresh. The finalizer is identity-guarded so an OLD refresh
 * completing cannot clear a NEWER in-flight refresh started after a logout +
 * re-login (H-22): it only nulls `refreshPromise` when it is still the active one.
 */
function sharedRefresh(s: StoredAuth): Promise<RefreshOutcome> {
  if (!refreshPromise) {
    const local = refreshAccessToken(s).finally(() => {
      if (refreshPromise === local) refreshPromise = null;
    });
    refreshPromise = local;
  }
  return refreshPromise;
}

export async function getAccessToken(): Promise<string | null> {
  const s = await readStored();
  if (!s) return null;
  const expiry = s.expires_in ? s.obtained_at + s.expires_in : 0;
  const now = Math.floor(Date.now() / 1000);
  if (expiry && now < expiry - REFRESH_SKEW_SECONDS) return s.access_token;
  if (!s.refresh_token) return s.access_token; // best effort
  // Best-effort local-expiry path: share the single-flight refresh, but on ANY
  // failure fall back to the (possibly stale) access token rather than signing
  // the user out — signing out on a 401 is the forced path's job, not this one.
  const outcome = await sharedRefresh(s);
  switch (outcome.kind) {
    case 'ok':
      return outcome.accessToken;
    case 'stale_generation':
      // A logout/login raced this refresh: the token was intentionally NOT
      // persisted (H-22). Do NOT hand it back — a caller must not continue as the
      // signed-out / previous account. Treat as signed out.
      return null;
    default:
      // transient_failure / invalidated → best-effort stale token (unchanged).
      return s.access_token;
  }
}

/**
 * Hard/forced refresh used when the API rejected the current token (401). Shares
 * the single-flight refresh with getAccessToken but maps to a classified result
 * and NEVER returns a stale token. On an explicit invalidation marker it deletes
 * the stored tokens; on any other failure it RETAINS them (transient).
 */
export async function forceRefreshAccessToken(
  opts?: { signal?: AbortSignal },
): Promise<RefreshAccessResult> {
  const s = await readStored();
  // Forced path: do NOT fall back to a stale access token (that is the forced-path
  // fix vs the best-effort getAccessToken behaviour).
  if (!s || !s.refresh_token) return { kind: 'missing_refresh_token' };
  const gen = authGeneration;
  // Share the single in-flight refresh; the shared fetch is NOT tied to the
  // per-request signal, so a cancelled caller never aborts other callers' refresh.
  const outcome = await abortableWait(sharedRefresh(s), opts?.signal);
  if (outcome === REFRESH_CANCELLED) return { kind: 'cancelled' };
  // Post-round-trip generation guard: a logout during the refresh means this
  // caller must NOT fire a request with a resurrected token (H-22). This is on top
  // of the on-disk resurrection guard inside refreshAccessToken.
  if (gen !== authGeneration) return { kind: 'stale_generation' };
  switch (outcome.kind) {
    case 'ok':
      return { kind: 'ok', accessToken: outcome.accessToken };
    case 'invalidated':
      // The refresh token is dead — sign the user out locally.
      await deleteStored();
      return { kind: 'invalidated', marker: outcome.marker };
    case 'stale_generation':
      return { kind: 'stale_generation' };
    case 'transient_failure':
      return { kind: 'transient_failure', status: outcome.status };
  }
}

async function refreshAccessToken(s: StoredAuth): Promise<RefreshOutcome> {
  const gen = authGeneration;
  try {
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: s.refresh_token!,
      client_id: CLIENT_ID,
    });
    const r = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      redirect: 'error',
      // Never tie the shared refresh to a per-request signal — its own timeout
      // bounds it so a cancelled caller cannot kill an in-flight shared refresh.
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
    const bodyText = await readCappedText(r, STREAM_LIMITS.errorBodyMax);
    if (!r.ok) {
      // Only an explicit invalidation marker kills the refresh token; every other
      // non-ok (generic 400/401, 5xx) is transient and RETAINS the tokens.
      const marker = detectInvalidationMarker(bodyText);
      if (marker) return { kind: 'invalidated', marker };
      return { kind: 'transient_failure', status: r.status, staleToken: s.access_token };
    }
    let j: {
      access_token?: string;
      refresh_token?: string;
      id_token?: string;
      expires_in?: number;
    } = {};
    let parsed = false;
    try {
      j = JSON.parse(bodyText);
      parsed = true;
    } catch {
      /* malformed / truncated 200 body */
    }
    // A 2xx with no usable access_token is NOT a successful refresh. NEVER hand back
    // (or persist) the stale token as 'ok' — the forced path would then retry the
    // already-rejected bearer and mark a dead token fresh on disk. Treat as transient
    // so the caller retains tokens (no timestamp bump) and surfaces a re-auth prompt.
    if (!parsed || typeof j.access_token !== 'string' || j.access_token.trim() === '') {
      return { kind: 'transient_failure', status: r.status, staleToken: s.access_token };
    }
    // If a logout/login happened while this refresh was in flight, do NOT
    // persist — that would resurrect tokens for a signed-out user (H-22).
    if (gen !== authGeneration) return { kind: 'stale_generation', accessToken: j.access_token };
    const next: StoredAuth = {
      ...s,
      access_token: j.access_token,
      refresh_token: j.refresh_token ?? s.refresh_token,
      id_token: j.id_token ?? s.id_token,
      expires_in: j.expires_in ?? s.expires_in,
      obtained_at: Math.floor(Date.now() / 1000),
    };
    await writeStored(next);
    return { kind: 'ok', accessToken: next.access_token };
  } catch {
    // Network error / timeout / redirect refusal → transient, retain tokens.
    return { kind: 'transient_failure', staleToken: s.access_token };
  }
}
