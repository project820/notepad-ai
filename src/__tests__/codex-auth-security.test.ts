import { describe, it, expect, vi, beforeEach } from 'vitest';

// S1/S2: credential boundary. Mock electron + node:fs so we can drive
// codex-auth without network or a real Keychain.
const h = vi.hoisted(() => ({
  writeFile: vi.fn(),
  readFile: vi.fn(),
  mkdir: vi.fn(),
  unlink: vi.fn(),
  openExternal: vi.fn(),
  state: { encryptionAvailable: true },
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/notepad-ai-test-userdata' },
  safeStorage: {
    isEncryptionAvailable: () => h.state.encryptionAvailable,
    encryptString: (s: string) => Buffer.from(s, 'utf-8'),
    decryptString: (b: Buffer) => b.toString('utf-8'),
  },
  shell: { openExternal: h.openExternal },
}));

vi.mock('node:fs', () => ({
  promises: { writeFile: h.writeFile, readFile: h.readFile, mkdir: h.mkdir, unlink: h.unlink },
}));

beforeEach(() => {
  vi.resetModules();
  h.writeFile.mockReset();
  h.readFile.mockReset();
  h.mkdir.mockReset();
  h.unlink.mockReset();
  h.state.encryptionAvailable = true;
  delete process.env.NOTEPAD_AI_OPENAI_ACCESS_TOKEN;
  delete process.env.NOTEPAD_AI_OPENAI_REFRESH_TOKEN;
});

describe('codex-auth credential boundary (S1/S2)', () => {
  it('S1: getStatus exposes no token fields to the renderer', async () => {
    h.state.encryptionAvailable = true;
    const stored = {
      access_token: 'SECRET_ACCESS_TOKEN',
      refresh_token: 'SECRET_REFRESH_TOKEN',
      id_token: 'SECRET_ID_TOKEN',
      email: 'user@example.com',
      plan: 'pro',
      obtained_at: Math.floor(Date.now() / 1000),
      expires_in: 3600,
    };
    h.readFile.mockResolvedValue(Buffer.from(JSON.stringify(stored), 'utf-8'));

    const { getStatus } = await import('../main/codex-auth');
    const snap = await getStatus();

    expect(snap.signedIn).toBe(true);
    expect(snap.email).toBe('user@example.com');
    expect(snap.plan).toBe('pro');
    expect(snap.persisted).toBe(true);
    // No secret material may leak through the snapshot.
    expect((snap as Record<string, unknown>).accessToken).toBeUndefined();
    expect((snap as Record<string, unknown>).access_token).toBeUndefined();
    expect((snap as Record<string, unknown>).refreshToken).toBeUndefined();
    expect((snap as Record<string, unknown>).idToken).toBeUndefined();
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toContain('SECRET_ACCESS_TOKEN');
    expect(serialized).not.toContain('SECRET_REFRESH_TOKEN');
    expect(serialized).not.toContain('SECRET_ID_TOKEN');
  });

  it('S2: when safeStorage is unavailable, no plaintext is written and env is the read-only fallback', async () => {
    h.state.encryptionAvailable = false;
    process.env.NOTEPAD_AI_OPENAI_ACCESS_TOKEN = 'ENV_ACCESS_TOKEN';
    h.readFile.mockResolvedValue(Buffer.from('PLAINTEXT_SHOULD_NEVER_BE_READ', 'utf-8'));

    const { getStatus } = await import('../main/codex-auth');
    const snap = await getStatus();

    expect(snap.signedIn).toBe(true); // via env credential source
    expect(snap.persisted).toBe(false); // memory/env only, not persisted to disk
    expect(h.writeFile).not.toHaveBeenCalled(); // never write plaintext
    expect(JSON.stringify(snap)).not.toContain('ENV_ACCESS_TOKEN');
  });

  it('S2: no auth + no env + no encryption → signed out, no disk write', async () => {
    h.state.encryptionAvailable = false;
    h.readFile.mockRejectedValue(new Error('ENOENT'));

    const { getStatus } = await import('../main/codex-auth');
    const snap = await getStatus();

    expect(snap.signedIn).toBe(false);
    expect(h.writeFile).not.toHaveBeenCalled();
  });
});
describe('codex-auth token refresh lifecycle (H-21/H-22)', () => {
  const expiredStored = () => ({
    access_token: 'OLD_ACCESS',
    refresh_token: 'REFRESH',
    id_token: 'ID',
    email: 'u@e.com',
    plan: 'pro',
    obtained_at: Math.floor(Date.now() / 1000) - 7200,
    expires_in: 3600, // expired ~1h ago → forces a refresh
  });

  it('single-flights concurrent refreshes into one network round-trip', async () => {
    h.readFile.mockResolvedValue(Buffer.from(JSON.stringify(expiredStored()), 'utf-8'));
    let calls = 0;
    let release: (v: unknown) => void = () => {};
    const gate = new Promise((r) => {
      release = r;
    });
    global.fetch = vi.fn(async () => {
      calls++;
      await gate;
      return new Response(JSON.stringify({ access_token: 'NEW_ACCESS', expires_in: 3600 }), { status: 200 });
    }) as unknown as typeof fetch;

    const { getAccessToken } = await import('../main/codex-auth');
    const p1 = getAccessToken();
    const p2 = getAccessToken();
    release(null);
    const [a, b] = await Promise.all([p1, p2]);

    expect(calls).toBe(1); // both callers shared the same in-flight refresh
    expect(a).toBe('NEW_ACCESS');
    expect(b).toBe('NEW_ACCESS');
  });

  it('does not resurrect tokens when logout happens during an in-flight refresh', async () => {
    h.readFile.mockResolvedValue(Buffer.from(JSON.stringify(expiredStored()), 'utf-8'));
    let release: (v: unknown) => void = () => {};
    const gate = new Promise((r) => {
      release = r;
    });
    global.fetch = vi.fn(async () => {
      await gate;
      return new Response(JSON.stringify({ access_token: 'NEW_ACCESS', expires_in: 3600 }), { status: 200 });
    }) as unknown as typeof fetch;

    const { getAccessToken, logout } = await import('../main/codex-auth');
    const p = getAccessToken();
    // Let the refresh actually start (capture the generation epoch) BEFORE logout.
    await new Promise((r) => setTimeout(r, 0));
    await logout(); // bumps the auth generation epoch + deletes stored auth
    h.writeFile.mockClear();
    release(null);
    const token = await p;

    expect(token).toBe('NEW_ACCESS'); // best-effort token still returned to the caller
    expect(h.writeFile).not.toHaveBeenCalled(); // but it is NOT persisted back to disk
  });

  it('emits a terminal cancel update when login is cancelled mid-flight (P1)', async () => {
    h.state.encryptionAvailable = true;
    global.fetch = vi.fn(async (url: unknown) => {
      if (String(url).includes('usercode')) {
        return new Response(
          JSON.stringify({ user_code: 'ABC', device_auth_id: 'dev1', interval: '5' }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 403 });
    }) as unknown as typeof fetch;

    const { startLogin, cancelLogin } = await import('../main/codex-auth');
    const updates: Array<{ kind: string; message?: string }> = [];
    await startLogin((u) => {
      updates.push(u);
      if (u.kind === 'usercode') cancelLogin(); // cancel the moment the code is shown
    });

    expect(updates.some((u) => u.kind === 'usercode')).toBe(true);
    // The flow must end with a terminal cancel — never hang the renderer's login.
    expect(updates.at(-1)).toEqual({ kind: 'error', message: 'Login cancelled.' });
  });
});
