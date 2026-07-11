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

    expect(token).toBeNull(); // logout raced the refresh → signed out, no bearer handed back
    expect(h.writeFile).not.toHaveBeenCalled(); // and nothing persisted back to disk (H-22)
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
    const updates: Array<{ kind: string; code?: string }> = [];
    await startLogin((u) => {
      updates.push(u);
      if (u.kind === 'usercode') cancelLogin(); // cancel the moment the code is shown
    });

    expect(updates.some((u) => u.kind === 'usercode')).toBe(true);
    // The flow must end with a terminal cancel — never hang the renderer's login.
    expect(updates.at(-1)).toEqual({ kind: 'error', code: 'cancelled' });
  });
  it('emits a terminal persistence error when encrypted storage throws', async () => {
    vi.useFakeTimers();
    try {
      h.writeFile.mockRejectedValueOnce(new Error('disk full'));
      global.fetch = vi.fn(async (url: unknown) => {
        const endpoint = String(url);
        if (endpoint.includes('usercode')) {
          return new Response(
            JSON.stringify({ user_code: 'ABC', device_auth_id: 'dev1', interval: '3' }),
            { status: 200 },
          );
        }
        if (endpoint.includes('deviceauth/token')) {
          return new Response(JSON.stringify({ authorization_code: 'code', code_verifier: 'verifier' }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({ access_token: 'ACCESS', expires_in: 3600 }), { status: 200 });
      }) as unknown as typeof fetch;

      const { startLogin } = await import('../main/codex-auth');
      const updates: Array<{ kind: string; code?: string; detail?: string }> = [];
      const login = startLogin((u) => updates.push(u));
      await vi.advanceTimersByTimeAsync(3_000);

      await expect(login).resolves.toBeUndefined();
      expect(updates.at(-1)).toEqual({ kind: 'error', code: 'persist_failed', detail: 'disk full' });
    } finally {
      vi.useRealTimers();
    }
  });
  it.each([
    ['null body', 'null'],
    ['empty object', '{}'],
    ['empty access_token', JSON.stringify({ access_token: '' })],
    ['non-string access_token', JSON.stringify({ access_token: 42 })],
    ['whitespace-only access_token', JSON.stringify({ access_token: '   ' })],
  ])('emits a terminal token_exchange_failed on a malformed 2xx token payload (%s)', async (_name, body) => {
    vi.useFakeTimers();
    try {
      global.fetch = vi.fn(async (url: unknown) => {
        const endpoint = String(url);
        if (endpoint.includes('usercode')) {
          return new Response(
            JSON.stringify({ user_code: 'ABC', device_auth_id: 'dev1', interval: '3' }),
            { status: 200 },
          );
        }
        if (endpoint.includes('deviceauth/token')) {
          return new Response(JSON.stringify({ authorization_code: 'code', code_verifier: 'verifier' }), {
            status: 200,
          });
        }
        return new Response(body, { status: 200 });
      }) as unknown as typeof fetch;

      const { startLogin } = await import('../main/codex-auth');
      const updates: Array<{ kind: string; code?: string; detail?: string }> = [];
      const login = startLogin((u) => updates.push(u));
      await vi.advanceTimersByTimeAsync(3_000);

      // The flow must terminate the login promise AND end on a terminal error —
      // a malformed 2xx grant must never hang or report a tokenless success.
      await expect(login).resolves.toBeUndefined();
      const last = updates.at(-1)!;
      expect(last.kind).toBe('error');
      expect(last.code).toBe('token_exchange_failed');
      expect(updates.some((u) => u.kind === 'success')).toBe(false);
      expect(h.writeFile).not.toHaveBeenCalled(); // nothing persisted for a bad grant
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('codex-auth forced refresh (Bug A: 401 hard refresh)', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const storedWithRefresh = () => ({
    access_token: 'OLD_ACCESS',
    refresh_token: 'REFRESH',
    id_token: 'ID',
    email: 'u@e.com',
    plan: 'pro',
    obtained_at: Math.floor(Date.now() / 1000) - 7200,
    expires_in: 3600, // expired → but forceRefreshAccessToken refreshes regardless
  });
  const primeStoredWithRefresh = () =>
    h.readFile.mockResolvedValue(Buffer.from(JSON.stringify(storedWithRefresh()), 'utf-8'));

  it('deletes stored tokens on an invalid_grant marker (invalidated)', async () => {
    primeStoredWithRefresh();
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    ) as unknown as typeof fetch;

    const { forceRefreshAccessToken } = await import('../main/codex-auth');
    const res = await forceRefreshAccessToken();

    expect(res).toEqual({ kind: 'invalidated', marker: 'invalid_grant' });
    expect(h.unlink).toHaveBeenCalled(); // stored tokens deleted → user is signed out
  });

  it('deletes stored tokens on a token_invalidated marker (invalidated)', async () => {
    primeStoredWithRefresh();
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify({ error: 'token_invalidated' }), { status: 401 }),
    ) as unknown as typeof fetch;

    const { forceRefreshAccessToken } = await import('../main/codex-auth');
    const res = await forceRefreshAccessToken();

    expect(res).toEqual({ kind: 'invalidated', marker: 'token_invalidated' });
    expect(h.unlink).toHaveBeenCalled();
  });

  it('deletes stored tokens on a NESTED structured marker ({error:{code:token_invalidated}})', async () => {
    primeStoredWithRefresh();
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify({ error: { code: 'token_invalidated' } }), { status: 401 }),
    ) as unknown as typeof fetch;

    const { forceRefreshAccessToken } = await import('../main/codex-auth');
    const res = await forceRefreshAccessToken();

    expect(res).toEqual({ kind: 'invalidated', marker: 'token_invalidated' });
    expect(h.unlink).toHaveBeenCalled();
  });

  it('RETAINS tokens on a transient body that only MENTIONS a marker in error_description', async () => {
    // The canonical `error` code is non-terminal; the marker string appears only in
    // the human-readable description. This must NOT sign the user out (destroy-on-
    // transient anti-goal): only the exact OAuth `error`/`error_code` counts.
    primeStoredWithRefresh();
    global.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: 'server_error',
            error_description: 'retry later; previous invalid_grant / token_invalidated diagnostics unavailable',
          }),
          { status: 400 },
        ),
    ) as unknown as typeof fetch;

    const { forceRefreshAccessToken } = await import('../main/codex-auth');
    const res = await forceRefreshAccessToken();

    expect(res).toEqual({ kind: 'transient_failure', status: 400 });
    expect(h.unlink).not.toHaveBeenCalled(); // tokens retained despite the description text
  });

  it('RETAINS tokens on a generic 400 with no marker (transient)', async () => {
    primeStoredWithRefresh();
    global.fetch = vi.fn(async () => new Response('bad request', { status: 400 })) as unknown as typeof fetch;

    const { forceRefreshAccessToken } = await import('../main/codex-auth');
    const res = await forceRefreshAccessToken();

    expect(res).toEqual({ kind: 'transient_failure', status: 400 });
    expect(h.unlink).not.toHaveBeenCalled(); // tokens retained, NOT deleted
  });

  it('RETAINS tokens on a generic 401 with no marker (transient)', async () => {
    primeStoredWithRefresh();
    global.fetch = vi.fn(async () => new Response('unauthorized', { status: 401 })) as unknown as typeof fetch;

    const { forceRefreshAccessToken } = await import('../main/codex-auth');
    const res = await forceRefreshAccessToken();

    expect(res).toEqual({ kind: 'transient_failure', status: 401 });
    expect(h.unlink).not.toHaveBeenCalled();
  });

  it('RETAINS tokens on a 5xx (transient)', async () => {
    primeStoredWithRefresh();
    global.fetch = vi.fn(async () => new Response('upstream boom', { status: 503 })) as unknown as typeof fetch;

    const { forceRefreshAccessToken } = await import('../main/codex-auth');
    const res = await forceRefreshAccessToken();

    expect(res).toEqual({ kind: 'transient_failure', status: 503 });
    expect(h.unlink).not.toHaveBeenCalled();
  });

  it('RETAINS tokens on a network/timeout throw (transient, no status)', async () => {
    primeStoredWithRefresh();
    global.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const { forceRefreshAccessToken } = await import('../main/codex-auth');
    const res = await forceRefreshAccessToken();

    expect(res.kind).toBe('transient_failure');
    expect((res as { status?: number }).status).toBeUndefined();
    expect(h.unlink).not.toHaveBeenCalled();
  });

  it('returns missing_refresh_token WITHOUT any network round-trip when there is no refresh token', async () => {
    // Stored auth exists but carries no refresh_token (e.g. env access token only).
    h.readFile.mockResolvedValue(
      Buffer.from(JSON.stringify({ access_token: 'ENV_ACCESS', obtained_at: 0 }), 'utf-8'),
    );
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { forceRefreshAccessToken } = await import('../main/codex-auth');
    const res = await forceRefreshAccessToken();

    expect(res).toEqual({ kind: 'missing_refresh_token' });
    expect(fetchSpy).not.toHaveBeenCalled(); // no-retry: never hits the network
  });

  it('returns missing_refresh_token when signed out (no stored auth)', async () => {
    h.readFile.mockRejectedValue(new Error('ENOENT'));
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { forceRefreshAccessToken } = await import('../main/codex-auth');
    const res = await forceRefreshAccessToken();

    expect(res).toEqual({ kind: 'missing_refresh_token' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('single-flights concurrent forced refreshes into one network round-trip', async () => {
    primeStoredWithRefresh();
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

    const { forceRefreshAccessToken } = await import('../main/codex-auth');
    const p1 = forceRefreshAccessToken();
    const p2 = forceRefreshAccessToken();
    release(null);
    const [a, b] = await Promise.all([p1, p2]);

    expect(calls).toBe(1); // both forced callers shared one in-flight refresh
    expect(a).toEqual({ kind: 'ok', accessToken: 'NEW_ACCESS' });
    expect(b).toEqual({ kind: 'ok', accessToken: 'NEW_ACCESS' });
  });

  it('a cancelled caller resolves cancelled while the shared refresh keeps running for others', async () => {
    primeStoredWithRefresh();
    let calls = 0;
    let release: (v: unknown) => void = () => {};
    const gate = new Promise((r) => {
      release = r;
    });
    const seenSignals: Array<AbortSignal | undefined> = [];
    global.fetch = vi.fn(async (_url: unknown, init: { signal?: AbortSignal }) => {
      calls++;
      seenSignals.push(init?.signal);
      await gate;
      return new Response(JSON.stringify({ access_token: 'NEW_ACCESS', expires_in: 3600 }), { status: 200 });
    }) as unknown as typeof fetch;

    const { forceRefreshAccessToken } = await import('../main/codex-auth');
    const ac = new AbortController();
    const pCancel = forceRefreshAccessToken({ signal: ac.signal });
    const pOther = forceRefreshAccessToken(); // shares the SAME in-flight refresh
    await tick();
    ac.abort(); // cancel ONLY the first caller

    expect(await pCancel).toEqual({ kind: 'cancelled' });

    // The shared network refresh is NOT aborted — the other caller still gets a token.
    release(null);
    expect(await pOther).toEqual({ kind: 'ok', accessToken: 'NEW_ACCESS' });
    expect(calls).toBe(1); // one shared fetch
    // The per-request signal is NEVER passed into the shared fetch (own timeout only).
    expect(seenSignals.every((s) => s !== ac.signal)).toBe(true);
  });

  it('logout during a forced refresh yields stale_generation and no usable token', async () => {
    primeStoredWithRefresh();
    let release: (v: unknown) => void = () => {};
    const gate = new Promise((r) => {
      release = r;
    });
    global.fetch = vi.fn(async () => {
      await gate;
      return new Response(JSON.stringify({ access_token: 'NEW_ACCESS', expires_in: 3600 }), { status: 200 });
    }) as unknown as typeof fetch;

    const { forceRefreshAccessToken, logout } = await import('../main/codex-auth');
    const p = forceRefreshAccessToken();
    await tick(); // let the refresh start (capture the generation epoch) BEFORE logout
    await logout(); // bumps the auth generation epoch + deletes stored auth
    h.writeFile.mockClear();
    release(null);
    const res = await p;

    expect(res).toEqual({ kind: 'stale_generation' }); // NOT a usable token
    expect(h.writeFile).not.toHaveBeenCalled(); // never persisted back to disk
  });

  it('identity-guard: an old refresh finalizer does not clear a newer in-flight refresh', async () => {
    primeStoredWithRefresh();
    let calls = 0;
    const gates: Array<(v: unknown) => void> = [];
    global.fetch = vi.fn(async () => {
      const i = calls++;
      await new Promise((r) => {
        gates[i] = r as (v: unknown) => void;
      });
      return new Response(JSON.stringify({ access_token: `TOKEN_${i}`, expires_in: 3600 }), { status: 200 });
    }) as unknown as typeof fetch;

    const { getAccessToken, logout } = await import('../main/codex-auth');

    // Refresh A starts and is left in flight.
    const pA = getAccessToken();
    await tick();
    expect(calls).toBe(1);

    // Logout nulls the shared refreshPromise (A is still in flight) + bumps the epoch.
    await logout();
    // Simulate a re-login: stored auth is readable again so a NEW refresh can start.
    primeStoredWithRefresh();

    // Refresh B is a brand-new single-flight (A's promise was nulled by logout).
    const pB = getAccessToken();
    await tick();
    expect(calls).toBe(2);

    // Let A finish FIRST. Its finalizer must NOT clear refreshPromise (=== B now).
    gates[0](null);
    await pA;
    await tick();

    // A third caller must still share B — proving A's finalizer left B intact.
    const pC = getAccessToken();
    await tick();
    expect(calls).toBe(2); // no third fetch → B was NOT cleared by A's finalizer

    gates[1](null);
    await Promise.all([pB, pC]);
  });
});
