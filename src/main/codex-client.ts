import { forceRefreshAccessToken, getAccessToken } from './codex-auth';
import { classifyHttpError, type AiProviderErrorKind } from './ai/types';
import { readCappedText, STREAM_LIMITS } from './ai/stream-http';

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const DEFAULT_MODEL = 'gpt-5.5';

// Fixed, body-free sign-in copy for EVERY classified auth error (errorKind:'auth').
// The renderer keys its sign-in affordance off errorKind:'auth'; this string is only
// display copy and MUST NOT interpolate any raw provider/response body.
const AUTH_SIGN_IN_MESSAGE = 'Not signed in. Click the ⚡ pill to sign in.';

/**
 * Codex Responses API client — ported behaviorally from Hermes auxiliary_client.py.
 * Endpoint: POST {base}/responses with SSE streaming.
 * Required Cloudflare-friendly headers: User-Agent (codex_cli_rs-shaped),
 * originator: codex_cli_rs, ChatGPT-Account-ID (from JWT claim).
 */

type AuthHeaders = Record<string, string>;

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

function cloudflareHeaders(token: string): AuthHeaders {
  const headers: AuthHeaders = {
    Authorization: `Bearer ${token}`,
    'User-Agent': 'codex_cli_rs/0.0.0 (notepad-ai)',
    originator: 'codex_cli_rs',
  };
  const claims = decodeJwtPayload(token);
  const acctId =
    (claims?.['https://api.openai.com/auth'] as any)?.chatgpt_account_id ??
    (claims as any)?.chatgpt_account_id;
  if (typeof acctId === 'string' && acctId) {
    headers['ChatGPT-Account-ID'] = acctId;
  }
  return headers;
}

export type ChatTurn = { role: 'user' | 'assistant'; text: string };

export type ChatRequest = {
  instructions: string;
  history: ChatTurn[];
  userText: string;
  model?: string;
  signal?: AbortSignal;
  maxOutputTokens?: number;
};

export type ChatEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'done'; text: string }
  | { kind: 'error'; message: string; errorKind?: AiProviderErrorKind };

/**
 * Stream a chat completion from Codex. Calls `onEvent` for each delta/done/error.
 * The first delta latency includes both Cloudflare TLS + OpenAI cold start;
 * subsequent deltas land every ~50-200ms.
 */
export async function streamChat(req: ChatRequest, onEvent: (e: ChatEvent) => void): Promise<void> {
  const token = await getAccessToken();
  if (!token) {
    onEvent({ kind: 'error', message: AUTH_SIGN_IN_MESSAGE, errorKind: 'auth' });
    return;
  }

  // Build the Responses API input array: system instructions go via `instructions`,
  // and history/user message become typed input items.
  const inputItems: Array<{ type: 'message'; role: 'user' | 'assistant'; content: Array<{ type: 'input_text' | 'output_text'; text: string }> }> = [];
  for (const turn of req.history) {
    inputItems.push({
      type: 'message',
      role: turn.role,
      content: [{ type: turn.role === 'user' ? 'input_text' : 'output_text', text: turn.text }],
    });
  }
  inputItems.push({
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: req.userText }],
  });

  const body = {
    model: req.model ?? DEFAULT_MODEL,
    instructions: req.instructions,
    input: inputItems,
    store: false,
    stream: true,
    ...(req.maxOutputTokens ? { max_output_tokens: req.maxOutputTokens } : {}),
  };

  let currentToken = token;
  // A delta is the point of no return: once ANY text has been emitted, a later
  // (mid-stream) error is terminal and MUST NOT trigger a re-auth/retry.
  let deltaEmitted = false;

  // At most two attempts: the initial request plus ONE retry after a forced token
  // refresh on a pre-stream 401.
  for (let attempt = 0; attempt <= 1; attempt++) {
    if (req.signal?.aborted) {
      onEvent({ kind: 'error', message: 'Cancelled.', errorKind: 'cancelled' });
      return;
    }

    let resp: Response;
    try {
      resp = await fetch(`${CODEX_BASE_URL}/responses`, {
        method: 'POST',
        headers: {
          ...cloudflareHeaders(currentToken),
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
        // Never follow a redirect: a rejected token that 3xx-redirects could
        // otherwise forward the prompt/auth header off-host (SSRF parity with
        // stream-http.ts).
        redirect: 'error',
        signal: req.signal,
      });
    } catch (e: any) {
      if (req.signal?.aborted) {
        onEvent({ kind: 'error', message: 'Cancelled.', errorKind: 'cancelled' });
        return;
      }
      onEvent({ kind: 'error', message: `Network error: ${e?.message ?? e}`, errorKind: 'network' });
      return;
    }

    // Pre-stream 401: force ONE hard refresh + retry, but only before any delta.
    if (resp.status === 401 && attempt === 0 && !deltaEmitted && !req.signal?.aborted) {
      const refreshed = await forceRefreshAccessToken({ signal: req.signal });
      switch (refreshed.kind) {
        case 'ok':
          // Rebuild the auth header with the fresh token and retry ONCE.
          currentToken = refreshed.accessToken;
          void resp.body?.cancel().catch(() => {});
          continue;
        case 'invalidated':
        case 'missing_refresh_token':
        case 'stale_generation':
          // No usable token — surface a single classified auth error. NEVER leak
          // the raw 401 body; the renderer keys the sign-in affordance off 'auth'.
          void resp.body?.cancel().catch(() => {});
          onEvent({ kind: 'error', message: AUTH_SIGN_IN_MESSAGE, errorKind: 'auth' });
          return;
        case 'cancelled':
          void resp.body?.cancel().catch(() => {});
          onEvent({ kind: 'error', message: 'Cancelled.', errorKind: 'cancelled' });
          return;
        case 'transient_failure': {
          const detail = await readCappedText(resp, STREAM_LIMITS.errorBodyMax);
          const err = classifyHttpError('ChatGPT', resp.status, detail);
          onEvent({ kind: 'error', message: err.message, errorKind: err.errorKind });
          return;
        }
      }
    }

    if (!resp.ok) {
      if (resp.status === 401) {
        // 401 after the retry (or a 401 we could not refresh): fixed auth copy,
        // never the raw body.
        void resp.body?.cancel().catch(() => {});
        onEvent({ kind: 'error', message: AUTH_SIGN_IN_MESSAGE, errorKind: 'auth' });
        return;
      }
      const detail = await readCappedText(resp, STREAM_LIMITS.errorBodyMax);
      const err = classifyHttpError('ChatGPT', resp.status, detail);
      onEvent({ kind: 'error', message: err.message, errorKind: err.errorKind });
      return;
    }

    if (!resp.body) {
      onEvent({ kind: 'error', message: 'Empty response body.', errorKind: 'provider' });
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let assembled = '';

    try {
      while (true) {
        if (req.signal?.aborted) {
          onEvent({ kind: 'error', message: 'Cancelled.', errorKind: 'cancelled' });
          return;
        }
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Abusive-stream guard: an event with no separator can grow `buffer`
        // unbounded (Phase 3 STREAM_LIMITS parity with stream-http.ts).
        if (buffer.length > STREAM_LIMITS.bufferMax) {
          onEvent({ kind: 'error', message: `ChatGPT: stream frame exceeded ${STREAM_LIMITS.bufferMax} bytes.`, errorKind: 'provider' });
          return;
        }

        // SSE: separated by blank line "\n\n"
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 2);
          if (!raw) continue;
          const dataLines: string[] = [];
          for (const line of raw.split('\n')) {
            if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          }
          const data = dataLines.join('\n');
          if (!data || data === '[DONE]') continue;
          let evt: any;
          try {
            evt = JSON.parse(data);
          } catch {
            continue; // ignore malformed events
          }
          const type = evt.type ?? '';
          if (typeof type === 'string' && type.includes('output_text.delta')) {
            const delta = String(evt.delta ?? '');
            if (delta) {
              assembled += delta;
              // Runaway-output guard.
              if (assembled.length > STREAM_LIMITS.outputMax) {
                onEvent({ kind: 'error', message: `ChatGPT: response exceeded ${STREAM_LIMITS.outputMax} bytes.`, errorKind: 'provider' });
                return;
              }
              deltaEmitted = true;
              onEvent({ kind: 'delta', text: delta });
            }
          } else if (type === 'response.failed' || type === 'error' || type === 'response.error') {
            // Post-stream provider failure — classified, capped, and NEVER retried.
            const detail = sseErrorDetail(evt);
            onEvent({
              kind: 'error',
              message: detail ? `ChatGPT stream failed — ${detail}` : 'ChatGPT stream failed.',
              errorKind: 'provider',
            });
            return;
          } else if (type === 'response.completed' || type === 'response.done') {
            // Some servers send the final text in response.output[0].content[0].text
            const out = evt.response?.output;
            if (Array.isArray(out) && assembled.length === 0) {
              for (const item of out) {
                const parts = item?.content;
                if (Array.isArray(parts)) {
                  for (const p of parts) {
                    if (typeof p?.text === 'string') assembled += p.text;
                  }
                }
              }
              if (assembled.length > STREAM_LIMITS.outputMax) {
                onEvent({ kind: 'error', message: `ChatGPT: response exceeded ${STREAM_LIMITS.outputMax} bytes.`, errorKind: 'provider' });
                return;
              }
            }
          }
        }
      }
    } catch (e: any) {
      if (req.signal?.aborted) {
        onEvent({ kind: 'error', message: 'Cancelled.', errorKind: 'cancelled' });
        return;
      }
      onEvent({ kind: 'error', message: `Stream error: ${e?.message ?? e}`, errorKind: 'network' });
      return;
    }

    onEvent({ kind: 'done', text: assembled });
    return;
  }
}

/** Extract a short, capped human detail from an SSE `error` / `response.failed` event. */
function sseErrorDetail(evt: any): string {
  const err = evt?.response?.error ?? evt?.error ?? evt;
  const raw = err?.message ?? err?.code ?? '';
  return String(raw).slice(0, 200);
}
