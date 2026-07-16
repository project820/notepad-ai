/**
 * Pinned, no-fallback HTML-export transport executor (PR-M1c / §5.3).
 *
 * Produces a `GenerateFn` for the generation-attempt orchestrator that streams
 * ONE generation from a SINGLE pinned provider/model/transport and reports the
 * frozen §5.3 terminal-completeness metadata:
 *
 *   - route/model are pinned; the executor NEVER switches provider/model/transport
 *     and NEVER consults a `FallbackProvider` (structural no-fallback: a single
 *     injected stream seam). `surfaceMode: 'html'` is set as defense-in-depth so a
 *     provider that inspects the surface also suppresses paid-API/other-route fallback.
 *   - `doneSeen` is true ONLY on a clean `{kind:'done'}` event. A clean completion
 *     with zero decoded bytes (done + no text) is the ONLY output the orchestrator
 *     may retry once on the same route (cli-runner zero-byte exit-0 semantics).
 *   - `capped` when assembled bytes exceed the frozen 8 MiB raw cap.
 *   - `truncated` when output was produced (bytes > 0) but the stream ended without
 *     a clean done (mid-stream error / premature end) — a partial/cut output that is
 *     NEVER a success and is NEVER retried.
 *   - a pre-output error or a first-byte timeout yields `doneSeen:false` with zero
 *     bytes → the orchestrator rejects it (pipeline-reject), never a false success.
 *
 * Electron-free and dependency-injected. Foundation only: unwired from main.ts and
 * the live wizard; the real provider binding and live activation land at cutover.
 * Renderer-safe output only: the sole route fields are provider/model/transport;
 * no secrets, no paths, no prompt echo.
 */

import type { AiChatEvent, AiChatRequest, AiProviderId } from './ai/types';
import type { GenerateFn, GenerationOutput, GenerationRoute } from './html-export-generation-orchestrator';

/** Frozen §5.3 terminal-completeness limits (reused cli-runner values). */
export const HTML_TRANSPORT_LIMITS = {
  /** Max assembled model bytes (UTF-8) before the stream is force-closed as capped. */
  outputCapBytes: 8 * 1024 * 1024,
  /** Thinking models can exceed 60s to first HTML byte on ~18k-char prompts (#53). */
  firstByteMs: 240_000,
} as const;

/**
 * Injected direct-provider stream seam. Matches `AiProvider.streamChat`: the abort
 * signal is threaded through `req.signal`. MUST be a single, fallback-suppressed
 * provider stream — the executor never provides a second route.
 */
export type PinnedTransportStream = (
  req: AiChatRequest,
  onEvent: (event: AiChatEvent) => void,
) => Promise<void>;

/** Cancels a scheduled timer. */
type CancelTimer = () => void;
/** Injectable timer seam so the first-byte deadline is deterministic in tests. */
export type StartTimer = (ms: number, cb: () => void) => CancelTimer;

const defaultStartTimer: StartTimer = (ms, cb) => {
  const handle = setTimeout(cb, ms);
  return () => clearTimeout(handle);
};

export type HtmlExportTransportDeps = {
  /** Pinned model selection. `provider` doubles as the route provider. */
  model: { provider: AiProviderId; id: string };
  /** Pinned transport channel. */
  transport: 'cli' | 'api';
  /** Single, fallback-suppressed provider stream. */
  stream: PinnedTransportStream;
  /** System instructions for the HTML-authoring turn. */
  instructions?: string;
  /** Escalated output-token cap (HTML export). Omitted → provider default. */
  maxOutputTokens?: number;
  /** Override the frozen completeness limits (tests only). */
  caps?: { outputCapBytes?: number; firstByteMs?: number };
  /** Timer seam (tests only). */
  startTimer?: StartTimer;
};

const encoder = new TextEncoder();
function utf8Len(text: string): number {
  return encoder.encode(text).length;
}

/**
 * Build a pinned, no-fallback `GenerateFn`. Every invocation streams exactly one
 * generation from the pinned route and returns the §5.3 completeness metadata.
 */
export function createHtmlExportTransport(deps: HtmlExportTransportDeps): GenerateFn {
  const outputCapBytes = deps.caps?.outputCapBytes ?? HTML_TRANSPORT_LIMITS.outputCapBytes;
  const firstByteMs = deps.caps?.firstByteMs ?? HTML_TRANSPORT_LIMITS.firstByteMs;
  const startTimer = deps.startTimer ?? defaultStartTimer;

  // The pinned route is fixed at construction and returned verbatim on every
  // output — there is no path by which a different route can appear.
  const route: GenerationRoute = {
    provider: deps.model.provider,
    model: deps.model.id,
    transport: deps.transport,
  };

  return async ({ prompt, signal }): Promise<GenerationOutput> => {
    const controller = new AbortController();
    let settled = false;
    let firstByteSeen = false;
    let firstByteTimedOut = false;
    let sawDone = false;
    let capped = false;
    let sawError = false;
    let html = '';
    let bytes = 0;

    // Abort the stream if the caller cancels; the orchestrator observes the
    // external signal separately and maps that to a cancelled attempt.
    const onExternalAbort = (): void => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    const cancelFirstByteTimer = startTimer(firstByteMs, () => {
      if (firstByteSeen || settled) return;
      firstByteTimedOut = true;
      controller.abort();
    });

    const stopFirstByteTimer = (): void => {
      cancelFirstByteTimer();
    };

    const appendDelta = (text: string): void => {
      if (settled || capped || firstByteTimedOut || text.length === 0) return;
      if (!firstByteSeen) {
        firstByteSeen = true;
        stopFirstByteTimer();
      }
      html += text;
      bytes = utf8Len(html);
      if (bytes > outputCapBytes) {
        capped = true;
        // Hard failure regardless of any later event; stop the stream.
        controller.abort();
      }
    };

    const onEvent = (event: AiChatEvent): void => {
      // Once the stream has settled, been capped, blown the first-byte deadline,
      // or been cancelled, the outcome is frozen: ignore every later event so a
      // provider that does not honour the abort signal cannot forge a success or
      // fuel a spurious zero-byte retry with a late delta/done.
      if (settled || capped || firstByteTimedOut || controller.signal.aborted) return;
      switch (event.kind) {
        case 'delta':
          appendDelta(event.text);
          break;
        case 'done':
          // A provider may deliver the full text only on done; adopt it when it
          // carries more bytes than the assembled deltas.
          if (typeof event.text === 'string' && event.text.length > 0) {
            const doneBytes = utf8Len(event.text);
            if (doneBytes > bytes) {
              html = event.text;
              bytes = doneBytes;
              if (bytes > outputCapBytes) capped = true;
            }
          }
          sawDone = true;
          break;
        case 'error':
          sawError = true;
          break;
      }
    };

    const req: AiChatRequest = {
      instructions: deps.instructions ?? '',
      history: [],
      userText: prompt,
      model: { provider: deps.model.provider, id: deps.model.id },
      surfaceMode: 'html',
      signal: controller.signal,
      ...(deps.maxOutputTokens !== undefined ? { maxOutputTokens: deps.maxOutputTokens } : {}),
    };

    try {
      await deps.stream(req, onEvent);
    } catch {
      // A thrown stream (network/transport failure) is a hard failure, never a
      // false success. If it carried partial bytes it is a cut output.
      sawError = true;
    } finally {
      settled = true;
      stopFirstByteTimer();
      if (signal) signal.removeEventListener('abort', onExternalAbort);
    }

    // A clean success requires a done event AND no hard failure. capped, any
    // error (mid-stream, error-then-done, done-then-error, or a thrown stream),
    // and a first-byte timeout each fail closed — a done event can never launder
    // them into success.
    const hardFailure = capped || sawError || firstByteTimedOut;
    const doneSeen = sawDone && !hardFailure;

    // A stream that resolved without a done and without an error, yet produced
    // bytes, is a premature/incomplete termination.
    const prematureEnd = !sawDone && !sawError && !capped && !firstByteTimedOut && bytes > 0;

    // `truncated` marks a cut output: bytes were produced but the stream did not
    // reach a clean done. A clean zero-byte completion (done + no text) is NOT
    // truncated so the orchestrator may apply its single same-route retry.
    const truncated = !doneSeen && bytes > 0 && (sawError || prematureEnd);

    return {
      html,
      route,
      decodedBytes: bytes,
      doneSeen,
      capped,
      truncated,
    };
  };
}
