/**
 * fallback-provider.ts — compose a primary and fallback stream source with a
 * strict policy: fall back to the secondary ONLY when the primary fails BEFORE
 * emitting any output (a pre-output unavailable/auth/startup error). Once any
 * delta has been emitted, a later primary error is forwarded and the fallback is
 * NEVER invoked (no duplicate output). User cancellation never falls back. The
 * primary's pre-output error is swallowed (held) so the renderer sees only the
 * fallback's stream. (G004)
 */

import type { AiChatEvent, AiChatRequest } from './types';

export interface StreamSource {
  streamChat(req: AiChatRequest, onEvent: (e: AiChatEvent) => void): Promise<void>;
}

export type FallbackRoute = 'primary' | 'fallback' | 'primary-error';

export class FallbackProvider implements StreamSource {
  constructor(
    private primary: StreamSource,
    private fallback: StreamSource,
    private opts: {
      shouldFallback?: (e: { errorKind?: AiChatEvent extends { errorKind?: infer K } ? K : string }) => boolean;
      onRoute?: (route: FallbackRoute) => void;
    } = {},
  ) {}

  async streamChat(req: AiChatRequest, onEvent: (e: AiChatEvent) => void): Promise<void> {
    let committed = false; // any delta/done already forwarded
    let pendingFallback = false;
    // Default: fall back on any pre-output error except an explicit user cancel.
    const shouldFallback = this.opts.shouldFallback ?? ((e) => e.errorKind !== 'cancelled');

    await this.primary.streamChat(req, (e) => {
      if (e.kind === 'delta' || e.kind === 'done') {
        committed = true;
        onEvent(e);
        return;
      }
      // e.kind === 'error'
      if (!committed && shouldFallback({ errorKind: e.errorKind as never })) {
        pendingFallback = true; // hold the primary error; the fallback owns the stream
        return;
      }
      onEvent(e);
    });

    if (pendingFallback && !committed) {
      this.opts.onRoute?.('fallback');
      await this.fallback.streamChat(req, onEvent);
      return;
    }
    this.opts.onRoute?.(committed ? 'primary' : 'primary-error');
  }
}
