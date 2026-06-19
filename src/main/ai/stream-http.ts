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

/** Re-export for providers that want to throw a classified auth error. */
export function missingKeyError(providerLabel: string): AiProviderError {
  return new AiProviderError(
    'auth',
    `${providerLabel} needs an API key. Add it in AI settings to use this model.`,
  );
}
