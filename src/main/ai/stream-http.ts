/**
 * Generic HTTP SSE streaming used by the Claude and OpenRouter providers.
 *
 * The ChatGPT provider keeps its own ported Codex client (codex-client.ts) for
 * regression safety; this helper covers the two new OpenAI-/Anthropic-shaped
 * streaming endpoints.
 */

import { AiProviderError, classifyHttpError, type AiChatEvent } from './types';
import { splitSseEvents, sseDataPayload } from './sse';

export type SseMap = {
  /** Text to append (empty string for keep-alives / non-text events). */
  delta: string;
  /** True when this event terminates the stream successfully. */
  done?: boolean;
  /** Non-null when this event is a provider error inside the stream. */
  error?: string | null;
};

export type StreamSseArgs = {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  providerLabel: string;
  signal?: AbortSignal;
  /** Map one SSE `data:` payload to a delta/done/error. */
  mapEvent: (dataPayload: string) => SseMap;
};

export async function streamSseChat(
  args: StreamSseArgs,
  onEvent: (e: AiChatEvent) => void,
): Promise<void> {
  let resp: Response;
  try {
    resp = await fetch(args.url, {
      method: 'POST',
      headers: { ...args.headers, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(args.body),
      signal: args.signal,
    });
  } catch (e: unknown) {
    if (args.signal?.aborted) {
      onEvent({ kind: 'error', message: 'Cancelled.', errorKind: 'cancelled' });
      return;
    }
    const msg = e instanceof Error ? e.message : String(e);
    onEvent({
      kind: 'error',
      message: `${args.providerLabel} network error: ${msg}`,
      errorKind: 'network',
    });
    return;
  }

  if (!resp.ok) {
    let detail = '';
    try {
      detail = await resp.text();
    } catch {
      /* ignore */
    }
    const err = classifyHttpError(args.providerLabel, resp.status, detail);
    onEvent({ kind: 'error', message: err.message, errorKind: err.errorKind });
    return;
  }

  if (!resp.body) {
    onEvent({ kind: 'error', message: `${args.providerLabel} returned an empty body.`, errorKind: 'provider' });
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let assembled = '';

  try {
    while (true) {
      if (args.signal?.aborted) {
        onEvent({ kind: 'error', message: 'Cancelled.', errorKind: 'cancelled' });
        return;
      }
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = splitSseEvents(buffer);
      buffer = rest;
      for (const block of events) {
        const payload = sseDataPayload(block);
        if (!payload) continue;
        const mapped = args.mapEvent(payload);
        if (mapped.error) {
          onEvent({ kind: 'error', message: `${args.providerLabel}: ${mapped.error}`, errorKind: 'provider' });
          return;
        }
        if (mapped.delta) {
          assembled += mapped.delta;
          onEvent({ kind: 'delta', text: mapped.delta });
        }
        if (mapped.done) {
          onEvent({ kind: 'done', text: assembled });
          return;
        }
      }
    }
  } catch (e: unknown) {
    if (args.signal?.aborted) {
      onEvent({ kind: 'error', message: 'Cancelled.', errorKind: 'cancelled' });
      return;
    }
    const msg = e instanceof Error ? e.message : String(e);
    onEvent({ kind: 'error', message: `${args.providerLabel} stream error: ${msg}`, errorKind: 'network' });
    return;
  }

  onEvent({ kind: 'done', text: assembled });
}

export type NdjsonStreamArgs = {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  providerLabel: string;
  signal?: AbortSignal;
  /** Map one NDJSON line (already trimmed, non-empty) to a delta/done/error. */
  mapLine: (line: string) => SseMap;
};

/**
 * Generic newline-delimited-JSON streaming (Ollama `/api/chat`). Mirrors
 * {@link streamSseChat} error/cancel handling but frames the body by lines
 * instead of SSE event blocks. Network/abort failures surface as classified
 * `AiChatEvent`s (offline → `network`), never as auth errors.
 */
export async function streamNdjsonChat(
  args: NdjsonStreamArgs,
  onEvent: (e: AiChatEvent) => void,
): Promise<void> {
  let resp: Response;
  try {
    resp = await fetch(args.url, {
      method: 'POST',
      headers: { ...args.headers, 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
      body: JSON.stringify(args.body),
      signal: args.signal,
    });
  } catch (e: unknown) {
    if (args.signal?.aborted) {
      onEvent({ kind: 'error', message: 'Cancelled.', errorKind: 'cancelled' });
      return;
    }
    const msg = e instanceof Error ? e.message : String(e);
    onEvent({
      kind: 'error',
      message: `${args.providerLabel} network error: ${msg}`,
      errorKind: 'network',
    });
    return;
  }

  if (!resp.ok) {
    let detail = '';
    try {
      detail = await resp.text();
    } catch {
      /* ignore */
    }
    const err = classifyHttpError(args.providerLabel, resp.status, detail);
    onEvent({ kind: 'error', message: err.message, errorKind: err.errorKind });
    return;
  }

  if (!resp.body) {
    onEvent({ kind: 'error', message: `${args.providerLabel} returned an empty body.`, errorKind: 'provider' });
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let assembled = '';

  const handleLine = (line: string): boolean => {
    const mapped = args.mapLine(line);
    if (mapped.error) {
      onEvent({ kind: 'error', message: `${args.providerLabel}: ${mapped.error}`, errorKind: 'provider' });
      return true;
    }
    if (mapped.delta) {
      assembled += mapped.delta;
      onEvent({ kind: 'delta', text: mapped.delta });
    }
    if (mapped.done) {
      onEvent({ kind: 'done', text: assembled });
      return true;
    }
    return false;
  };

  try {
    while (true) {
      if (args.signal?.aborted) {
        onEvent({ kind: 'error', message: 'Cancelled.', errorKind: 'cancelled' });
        return;
      }
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        if (handleLine(line)) return;
      }
    }
    const tail = buffer.trim();
    if (tail && handleLine(tail)) return;
  } catch (e: unknown) {
    if (args.signal?.aborted) {
      onEvent({ kind: 'error', message: 'Cancelled.', errorKind: 'cancelled' });
      return;
    }
    const msg = e instanceof Error ? e.message : String(e);
    onEvent({ kind: 'error', message: `${args.providerLabel} stream error: ${msg}`, errorKind: 'network' });
    return;
  }

  onEvent({ kind: 'done', text: assembled });
}

/** Re-export for providers that want to throw a classified auth error. */
export function missingKeyError(providerLabel: string): AiProviderError {
  return new AiProviderError(
    'auth',
    `${providerLabel} needs an API key. Add it in AI settings to use this model.`,
  );
}
