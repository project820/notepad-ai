import { getAccessToken } from './codex-auth';

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const DEFAULT_MODEL = 'gpt-5.5';

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
};

export type ChatEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'done'; text: string }
  | { kind: 'error'; message: string };

/**
 * Stream a chat completion from Codex. Calls `onEvent` for each delta/done/error.
 * The first delta latency includes both Cloudflare TLS + OpenAI cold start;
 * subsequent deltas land every ~50-200ms.
 */
export async function streamChat(req: ChatRequest, onEvent: (e: ChatEvent) => void): Promise<void> {
  const token = await getAccessToken();
  if (!token) {
    onEvent({ kind: 'error', message: 'Not signed in. Click the ⚡ pill to sign in.' });
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
  };

  let resp: Response;
  try {
    resp = await fetch(`${CODEX_BASE_URL}/responses`, {
      method: 'POST',
      headers: {
        ...cloudflareHeaders(token),
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });
  } catch (e: any) {
    onEvent({ kind: 'error', message: `Network error: ${e?.message ?? e}` });
    return;
  }

  if (!resp.ok) {
    let detail = '';
    try { detail = await resp.text(); } catch { /* ignore */ }
    onEvent({
      kind: 'error',
      message: `HTTP ${resp.status} — ${detail.slice(0, 200) || resp.statusText}`,
    });
    return;
  }

  if (!resp.body) {
    onEvent({ kind: 'error', message: 'Empty response body.' });
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let assembled = '';

  try {
    while (true) {
      if (req.signal?.aborted) {
        onEvent({ kind: 'error', message: 'Cancelled.' });
        return;
      }
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

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
        try {
          const evt = JSON.parse(data);
          const type = evt.type ?? '';
          if (typeof type === 'string' && type.includes('output_text.delta')) {
            const delta = String(evt.delta ?? '');
            if (delta) {
              assembled += delta;
              onEvent({ kind: 'delta', text: delta });
            }
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
            }
          }
        } catch {
          /* ignore malformed events */
        }
      }
    }
  } catch (e: any) {
    if (req.signal?.aborted) {
      onEvent({ kind: 'error', message: 'Cancelled.' });
      return;
    }
    onEvent({ kind: 'error', message: `Stream error: ${e?.message ?? e}` });
    return;
  }

  onEvent({ kind: 'done', text: assembled });
}
