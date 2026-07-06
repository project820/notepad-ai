import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Bug A: ChatGPT/Codex client 401 forced-refresh + classified auth errors.
 *
 * codex-auth is mocked so we drive getAccessToken / forceRefreshAccessToken
 * deterministically; global.fetch is mocked to shape the /responses reply. The
 * real ai/types (classifyHttpError) and ai/stream-http (readCappedText,
 * STREAM_LIMITS) are used — none of them touch Electron.
 */

// The exact fixed sign-in copy the client emits for EVERY classified auth error.
// The renderer keys its affordance off errorKind:'auth'; this string is the copy.
const AUTH_SIGN_IN_MESSAGE = 'Not signed in. Click the ⚡ pill to sign in.';

const auth = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
  forceRefreshAccessToken: vi.fn(),
}));

vi.mock('../main/codex-auth', () => ({
  getAccessToken: auth.getAccessToken,
  forceRefreshAccessToken: auth.forceRefreshAccessToken,
}));

type ChatEvt = { kind: string; text?: string; message?: string; errorKind?: string };

/** Build a text/event-stream Response from raw SSE frames. */
function sseResponse(frames: string[], status = 200): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

const sseFrame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

/** Contract invariant: every emitted error event MUST carry a classified errorKind. */
function assertAllErrorsClassified(events: ChatEvt[]) {
  for (const e of events) {
    if (e.kind === 'error') expect(typeof e.errorKind).toBe('string');
  }
}

const baseReq = () => ({ instructions: '', history: [] as never[], userText: 'q' });

beforeEach(() => {
  vi.resetModules();
  auth.getAccessToken.mockReset();
  auth.forceRefreshAccessToken.mockReset();
});

describe('codex-client pre-stream 401 forced refresh (Bug A)', () => {
  it('on a pre-stream 401, forces ONE refresh and retries once with the NEW bearer', async () => {
    auth.getAccessToken.mockResolvedValue('OLD_TOKEN');
    auth.forceRefreshAccessToken.mockResolvedValue({ kind: 'ok', accessToken: 'NEW_TOKEN' });

    const bearers: string[] = [];
    let call = 0;
    global.fetch = vi.fn(async (_url: unknown, init: { headers: Record<string, string> }) => {
      bearers.push(init.headers.Authorization);
      call++;
      if (call === 1) return new Response('unauthorized', { status: 401 });
      return sseResponse([
        sseFrame({ type: 'response.output_text.delta', delta: 'Hi' }),
        sseFrame({ type: 'response.completed' }),
      ]);
    }) as unknown as typeof fetch;

    const { streamChat } = await import('../main/codex-client');
    const events: ChatEvt[] = [];
    await streamChat(baseReq(), (e) => events.push(e));

    expect(auth.forceRefreshAccessToken).toHaveBeenCalledTimes(1);
    expect(call).toBe(2); // exactly one retry
    expect(bearers[0]).toBe('Bearer OLD_TOKEN');
    expect(bearers[1]).toBe('Bearer NEW_TOKEN'); // header rebuilt with the fresh token
    expect(events.some((e) => e.kind === 'delta' && e.text === 'Hi')).toBe(true);
    expect(events.at(-1)).toEqual({ kind: 'done', text: 'Hi' });
    assertAllErrorsClassified(events);
  });

  it('emits a single auth error (no retry loop) when the refresh token is invalidated', async () => {
    auth.getAccessToken.mockResolvedValue('OLD_TOKEN');
    auth.forceRefreshAccessToken.mockResolvedValue({ kind: 'invalidated', marker: 'invalid_grant' });

    let call = 0;
    global.fetch = vi.fn(async () => {
      call++;
      return new Response('raw unauthorized body', { status: 401 });
    }) as unknown as typeof fetch;

    const { streamChat } = await import('../main/codex-client');
    const events: ChatEvt[] = [];
    await streamChat(baseReq(), (e) => events.push(e));

    expect(call).toBe(1); // never retried
    expect(auth.forceRefreshAccessToken).toHaveBeenCalledTimes(1);
    const errs = events.filter((e) => e.kind === 'error');
    expect(errs).toHaveLength(1); // a SINGLE classified error, not a loop
    expect(errs[0].errorKind).toBe('auth');
    expect(errs[0].message).toBe(AUTH_SIGN_IN_MESSAGE);
    expect(errs[0].message).not.toContain('raw unauthorized body'); // never leak the body
    assertAllErrorsClassified(events);
  });

  it('emits a single auth error when there is no refresh token (env-token / missing_refresh_token)', async () => {
    auth.getAccessToken.mockResolvedValue('ENV_TOKEN');
    auth.forceRefreshAccessToken.mockResolvedValue({ kind: 'missing_refresh_token' });

    let call = 0;
    global.fetch = vi.fn(async () => {
      call++;
      return new Response('unauthorized', { status: 401 });
    }) as unknown as typeof fetch;

    const { streamChat } = await import('../main/codex-client');
    const events: ChatEvt[] = [];
    await streamChat(baseReq(), (e) => events.push(e));

    expect(call).toBe(1);
    const errs = events.filter((e) => e.kind === 'error');
    expect(errs).toHaveLength(1);
    expect(errs[0].errorKind).toBe('auth');
    expect(errs[0].message).toBe(AUTH_SIGN_IN_MESSAGE);
    assertAllErrorsClassified(events);
  });

  it('emits a cancelled error when the forced refresh reports cancellation (abort during refresh)', async () => {
    auth.getAccessToken.mockResolvedValue('OLD_TOKEN');
    auth.forceRefreshAccessToken.mockResolvedValue({ kind: 'cancelled' });

    let call = 0;
    global.fetch = vi.fn(async () => {
      call++;
      return new Response('unauthorized', { status: 401 });
    }) as unknown as typeof fetch;

    const { streamChat } = await import('../main/codex-client');
    const ac = new AbortController(); // not aborted at the 401 check → refresh runs
    const events: ChatEvt[] = [];
    await streamChat({ ...baseReq(), signal: ac.signal }, (e) => events.push(e));

    expect(call).toBe(1);
    const errs = events.filter((e) => e.kind === 'error');
    expect(errs).toHaveLength(1);
    expect(errs[0].errorKind).toBe('cancelled');
    assertAllErrorsClassified(events);
  });

  it('classifies a pre-stream 401 whose refresh failed transiently via classifyHttpError', async () => {
    auth.getAccessToken.mockResolvedValue('OLD_TOKEN');
    auth.forceRefreshAccessToken.mockResolvedValue({ kind: 'transient_failure', status: 500 });

    let call = 0;
    global.fetch = vi.fn(async () => {
      call++;
      return new Response('unauthorized', { status: 401 });
    }) as unknown as typeof fetch;

    const { streamChat } = await import('../main/codex-client');
    const events: ChatEvt[] = [];
    await streamChat(baseReq(), (e) => events.push(e));

    expect(call).toBe(1); // transient failure is not retried here
    const errs = events.filter((e) => e.kind === 'error');
    expect(errs).toHaveLength(1);
    // classifyHttpError('ChatGPT', 401, ...) → 'auth'
    expect(errs[0].errorKind).toBe('auth');
    assertAllErrorsClassified(events);
  });
});

describe('codex-client classified errors + streaming guards (Bug A)', () => {
  it('emits an auth error with errorKind when not signed in (no token, no fetch)', async () => {
    auth.getAccessToken.mockResolvedValue(null);
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { streamChat } = await import('../main/codex-client');
    const events: ChatEvt[] = [];
    await streamChat(baseReq(), (e) => events.push(e));

    expect(fetchSpy).not.toHaveBeenCalled();
    const errs = events.filter((e) => e.kind === 'error');
    expect(errs).toHaveLength(1);
    expect(errs[0].errorKind).toBe('auth');
    expect(errs[0].message).toBe(AUTH_SIGN_IN_MESSAGE);
    assertAllErrorsClassified(events);
  });

  it('classifies a non-401 HTTP error via classifyHttpError (no forced refresh)', async () => {
    auth.getAccessToken.mockResolvedValue('TOKEN');
    global.fetch = vi.fn(async () => new Response('server exploded', { status: 500 })) as unknown as typeof fetch;

    const { streamChat } = await import('../main/codex-client');
    const events: ChatEvt[] = [];
    await streamChat(baseReq(), (e) => events.push(e));

    expect(auth.forceRefreshAccessToken).not.toHaveBeenCalled(); // 500 is not a 401
    const errs = events.filter((e) => e.kind === 'error');
    expect(errs).toHaveLength(1);
    expect(errs[0].errorKind).toBe('provider'); // classifyHttpError(500) → provider
    assertAllErrorsClassified(events);
  });

  it('a non-401 auth status (403) uses fixed sign-in copy, never the raw body', async () => {
    auth.getAccessToken.mockResolvedValue('TOKEN');
    global.fetch = vi.fn(
      async () => new Response('{"error":{"message":"forbidden secret detail"}}', { status: 403 }),
    ) as unknown as typeof fetch;

    const { streamChat } = await import('../main/codex-client');
    const events: ChatEvt[] = [];
    await streamChat(baseReq(), (e) => events.push(e));

    const errs = events.filter((e) => e.kind === 'error');
    expect(errs).toHaveLength(1);
    expect(errs[0].errorKind).toBe('auth'); // classifyHttpError(403) → auth
    expect(errs[0].message).toBe(AUTH_SIGN_IN_MESSAGE); // fixed copy
    expect(errs[0].message).not.toContain('forbidden secret detail'); // no raw body
    assertAllErrorsClassified(events);
  });

  it('does NOT retry after a delta has been emitted (mid-stream error is terminal)', async () => {
    auth.getAccessToken.mockResolvedValue('TOKEN');
    let call = 0;
    global.fetch = vi.fn(async () => {
      call++;
      return sseResponse([
        sseFrame({ type: 'response.output_text.delta', delta: 'partial' }),
        sseFrame({ type: 'response.failed', response: { error: { message: 'boom' } } }),
      ]);
    }) as unknown as typeof fetch;

    const { streamChat } = await import('../main/codex-client');
    const events: ChatEvt[] = [];
    await streamChat(baseReq(), (e) => events.push(e));

    expect(call).toBe(1); // no retry after a delta
    expect(auth.forceRefreshAccessToken).not.toHaveBeenCalled();
    expect(events.some((e) => e.kind === 'delta' && e.text === 'partial')).toBe(true);
    const errs = events.filter((e) => e.kind === 'error');
    expect(errs).toHaveLength(1);
    expect(errs[0].errorKind).toBe('provider'); // SSE response.failed → classified provider error
    expect(errs[0].message).toContain('boom'); // capped detail surfaced
    expect(events.some((e) => e.kind === 'done')).toBe(false); // terminal, no done
    assertAllErrorsClassified(events);
  });

  it('maps an SSE `error` event to a classified provider error', async () => {
    auth.getAccessToken.mockResolvedValue('TOKEN');
    global.fetch = vi.fn(async () =>
      sseResponse([sseFrame({ type: 'error', error: { message: 'stream aborted upstream' } })]),
    ) as unknown as typeof fetch;

    const { streamChat } = await import('../main/codex-client');
    const events: ChatEvt[] = [];
    await streamChat(baseReq(), (e) => events.push(e));

    const errs = events.filter((e) => e.kind === 'error');
    expect(errs).toHaveLength(1);
    expect(errs[0].errorKind).toBe('provider');
    expect(events.some((e) => e.kind === 'done')).toBe(false);
    assertAllErrorsClassified(events);
  });

  it('maps an AUTH-shaped SSE failure to errorKind:auth (surfaces the sign-in affordance)', async () => {
    auth.getAccessToken.mockResolvedValue('TOKEN');
    global.fetch = vi.fn(async () =>
      sseResponse([
        sseFrame({ type: 'response.failed', response: { error: { code: 'token_invalidated', message: 'session ended' } } }),
      ]),
    ) as unknown as typeof fetch;

    const { streamChat } = await import('../main/codex-client');
    const events: ChatEvt[] = [];
    await streamChat(baseReq(), (e) => events.push(e));

    const errs = events.filter((e) => e.kind === 'error');
    expect(errs).toHaveLength(1);
    expect(errs[0].errorKind).toBe('auth'); // auth-shaped stream failure → affordance path
    expect(errs[0].message).not.toContain('session ended'); // raw body never surfaced for auth
    assertAllErrorsClassified(events);
  });

  it("uses redirect:'error' on the Codex fetch (SSRF parity)", async () => {
    auth.getAccessToken.mockResolvedValue('TOKEN');
    let seenInit: { redirect?: string } | undefined;
    global.fetch = vi.fn(async (_url: unknown, init: { redirect?: string }) => {
      seenInit = init;
      return sseResponse([sseFrame({ type: 'response.completed' })]);
    }) as unknown as typeof fetch;

    const { streamChat } = await import('../main/codex-client');
    await streamChat(baseReq(), () => {});

    expect(seenInit?.redirect).toBe('error');
  });

  it('a network throw before any response is classified as a network error', async () => {
    auth.getAccessToken.mockResolvedValue('TOKEN');
    global.fetch = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;

    const { streamChat } = await import('../main/codex-client');
    const events: ChatEvt[] = [];
    await streamChat(baseReq(), (e) => events.push(e));

    const errs = events.filter((e) => e.kind === 'error');
    expect(errs).toHaveLength(1);
    expect(errs[0].errorKind).toBe('network');
    assertAllErrorsClassified(events);
  });
});
