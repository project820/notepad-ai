import { app, safeStorage, shell } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

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

export type AuthSnapshot = {
  signedIn: boolean;
  email?: string;
  plan?: string;
  expiresAt?: number;
  /** True when tokens are persisted to encrypted disk; false = memory-only (session). Non-secret. */
  persisted?: boolean;
  /** Non-secret warning surfaced to the renderer (e.g. secure storage unavailable). */
  warning?: string;
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
  memoryAuth = data;
  if (safeStorage.isEncryptionAvailable()) {
    const buf = safeStorage.encryptString(JSON.stringify(data));
    await fs.mkdir(path.dirname(storePath()), { recursive: true });
    await fs.writeFile(storePath(), buf);
    persistedToDisk = true;
    return { persisted: true };
  }
  // Secure storage unavailable: memory-only, never plaintext on disk.
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

export type LoginUpdate =
  | { kind: 'usercode'; userCode: string; verificationUri: string }
  | { kind: 'success'; auth: AuthSnapshot }
  | { kind: 'error'; message: string };

let activeLoginAbort: AbortController | null = null;

export async function startLogin(onUpdate: (u: LoginUpdate) => void): Promise<void> {
  if (activeLoginAbort) activeLoginAbort.abort();
  activeLoginAbort = new AbortController();
  const signal = activeLoginAbort.signal;

  let usercodeResp: any;
  try {
    const r = await fetch(USERCODE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID }),
      signal,
    });
    if (!r.ok) throw new Error(`usercode HTTP ${r.status}`);
    usercodeResp = await r.json();
  } catch (e: any) {
    onUpdate({ kind: 'error', message: `Couldn't request device code: ${e.message ?? e}` });
    return;
  }

  const userCode = usercodeResp.user_code as string;
  const deviceAuthId = usercodeResp.device_auth_id as string;
  const pollInterval = Math.max(3, parseInt(String(usercodeResp.interval ?? '5'), 10)) * 1000;

  if (!userCode || !deviceAuthId) {
    onUpdate({ kind: 'error', message: 'Device code response missing required fields.' });
    return;
  }

  onUpdate({ kind: 'usercode', userCode, verificationUri: DEVICE_PAGE });
  // Open the device-auth page in the user's default browser.
  void shell.openExternal(DEVICE_PAGE);

  const deadline = Date.now() + 15 * 60 * 1000;
  let codeResp: { authorization_code?: string; code_verifier?: string } | null = null;

  while (Date.now() < deadline) {
    if (signal.aborted) return;
    await new Promise((res) => setTimeout(res, pollInterval));
    if (signal.aborted) return;
    let r: Response;
    try {
      r = await fetch(DEVICE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
        signal,
      });
    } catch (e: any) {
      onUpdate({ kind: 'error', message: `Polling error: ${e.message ?? e}` });
      return;
    }
    if (r.status === 200) {
      codeResp = await r.json();
      break;
    }
    if (r.status === 403 || r.status === 404) continue;
    onUpdate({ kind: 'error', message: `Polling returned HTTP ${r.status}` });
    return;
  }

  if (!codeResp?.authorization_code || !codeResp?.code_verifier) {
    onUpdate({ kind: 'error', message: 'Login timed out or incomplete response.' });
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
    onUpdate({ kind: 'error', message: `Token exchange failed: ${e.message ?? e}` });
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
      ...(persisted
        ? {}
        : { warning: 'Secure storage is unavailable. Sign-in will last only until the app quits.' }),
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
  await deleteStored();
}

export async function getAccessToken(): Promise<string | null> {
  const s = await readStored();
  if (!s) return null;
  const expiry = s.expires_in ? s.obtained_at + s.expires_in : 0;
  const now = Math.floor(Date.now() / 1000);
  if (expiry && now < expiry - REFRESH_SKEW_SECONDS) return s.access_token;
  if (!s.refresh_token) return s.access_token; // best effort
  // refresh
  try {
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: s.refresh_token,
      client_id: CLIENT_ID,
    });
    const r = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (!r.ok) return s.access_token;
    const j = await r.json();
    const next: StoredAuth = {
      ...s,
      access_token: j.access_token ?? s.access_token,
      refresh_token: j.refresh_token ?? s.refresh_token,
      id_token: j.id_token ?? s.id_token,
      expires_in: j.expires_in ?? s.expires_in,
      obtained_at: Math.floor(Date.now() / 1000),
    };
    await writeStored(next);
    return next.access_token;
  } catch {
    return s.access_token;
  }
}
