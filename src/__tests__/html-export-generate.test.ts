import { describe, expect, it, vi } from 'vitest';

import { createHtmlExportGenerator } from '../main/html-export-generate';
import type { OrchestratorPipeline } from '../main/html-export-generation-orchestrator';
import type { AiChatEvent, AiChatRequest } from '../main/ai/types';
import {
  type HtmlExportArtifactRef,
  type HtmlExportAttemptId,
  type HtmlExportPipelineResult,
} from '../shared/html-export-pipeline';

function attempt(id: string): HtmlExportAttemptId {
  return id as HtmlExportAttemptId;
}
function ok<T>(value: T): HtmlExportPipelineResult<T> {
  return { ok: true, value };
}
function artifactRef<S extends 'raw' | 'sanitized' | 'resolved' | 'finalized'>(stage: S, id: string): HtmlExportArtifactRef<S> {
  return { id: id as HtmlExportArtifactRef<S>['id'], attemptId: attempt('attempt-1'), stage, sha256: 'a'.repeat(64), byteLength: 32 };
}

function fakePipeline(): OrchestratorPipeline {
  return {
    beginAttempt: () => ok({ attemptId: attempt('attempt-1') }),
    storeRawModelOutput: () => ok(artifactRef('raw', 'raw-1')),
    sanitize: async () => ok({ artifact: artifactRef('sanitized', 'sanitized-1') }),
    resolve: async () => ok({ artifact: artifactRef('resolved', 'resolved-1') }),
    finalize: () => ok({ artifact: artifactRef('finalized', 'finalized-1') }),
    invalidateAttempt: () => ok({}),
  };
}

const MODEL = { provider: 'claude' as const, id: 'claude-sonnet' };

describe('createHtmlExportGenerator', () => {
  it('streams the model in main and drives the pipeline to a finalized artifact', async () => {
    const stream = vi.fn(async (req: AiChatRequest, onEvent: (e: AiChatEvent) => void) => {
      expect(req.surfaceMode).toBe('html');
      expect(req.model).toEqual(MODEL);
      onEvent({ kind: 'delta', text: '<!doctype html><html><body>ok</body></html>' });
      onEvent({ kind: 'done', text: '' });
    });
    const gen = createHtmlExportGenerator({
      pipeline: fakePipeline(),
      stream,
      quarantine: async () => ({ ok: true }),
      maxOutputTokens: () => 32_000,
    });

    const result = await gen.run(7, { prompt: 'Write a document.', model: MODEL });

    expect(result.state).toBe('final');
    if (result.state === 'final') {
      expect(result.finalizedArtifactId).toBe('finalized-1');
      expect(result.route).toEqual({ provider: 'claude', model: 'claude-sonnet', transport: 'cli' });
    }
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it('reports a partial when the pre-finalization quarantine cannot prove the layout', async () => {
    const stream = async (_req: AiChatRequest, onEvent: (e: AiChatEvent) => void) => {
      onEvent({ kind: 'delta', text: '<html>x</html>' });
      onEvent({ kind: 'done', text: '' });
    };
    const gen = createHtmlExportGenerator({
      pipeline: fakePipeline(),
      stream,
      quarantine: async () => ({ ok: false, kind: 'recoverable-failure' }),
    });

    const result = await gen.run(7, { prompt: 'p', model: MODEL });
    expect(result.state).toBe('partial');
  });

  it('supersedes an in-flight generation for the same sender', async () => {
    let firstAborted = false;
    const slowStream = (req: AiChatRequest, onEvent: (e: AiChatEvent) => void) =>
      new Promise<void>((resolve) => {
        req.signal?.addEventListener('abort', () => { firstAborted = true; resolve(); }, { once: true });
        // never emits on its own
        void onEvent;
      });
    const fastStream = async (_req: AiChatRequest, onEvent: (e: AiChatEvent) => void) => {
      onEvent({ kind: 'delta', text: '<html>ok</html>' });
      onEvent({ kind: 'done', text: '' });
    };
    let call = 0;
    const gen = createHtmlExportGenerator({
      pipeline: fakePipeline(),
      stream: (req, onEvent) => (++call === 1 ? slowStream(req, onEvent) : fastStream(req, onEvent)),
      quarantine: async () => ({ ok: true }),
    });

    const first = gen.run(7, { prompt: 'a', model: MODEL });
    const second = await gen.run(7, { prompt: 'b', model: MODEL });

    expect(firstAborted).toBe(true);
    await first; // resolves (aborted) without throwing
    expect(second.state).toBe('final');
  });

  it('cancel() aborts an in-flight generation', async () => {
    let aborted = false;
    const stream = (req: AiChatRequest, onEvent: (e: AiChatEvent) => void) =>
      new Promise<void>((resolve) => {
        req.signal?.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true });
        void onEvent;
      });
    const gen = createHtmlExportGenerator({ pipeline: fakePipeline(), stream, quarantine: async () => ({ ok: true }) });

    const running = gen.run(7, { prompt: 'a', model: MODEL });
    gen.cancel(7);
    const result = await running;

    expect(aborted).toBe(true);
    expect(result.state).toBe('cancelled');
  });

  it('uses resolveTransport when provided and falls back to the static route otherwise', async () => {
    const stream = async (_req: AiChatRequest, onEvent: (e: AiChatEvent) => void) => {
      onEvent({ kind: 'delta', text: '<html>ok</html>' });
      onEvent({ kind: 'done', text: '' });
    };
    const grokModel = { provider: 'grok' as const, id: 'grok-4.5' };

    const withOverride = createHtmlExportGenerator({
      pipeline: fakePipeline(),
      stream,
      quarantine: async () => ({ ok: true }),
      resolveTransport: async () => 'api',
    });
    const overridden = await withOverride.run(7, { prompt: 'p', model: grokModel });
    expect(overridden.state).toBe('final');
    if (overridden.state === 'final') {
      expect(overridden.route).toEqual({ provider: 'grok', model: 'grok-4.5', transport: 'api' });
    }

    const withoutOverride = createHtmlExportGenerator({
      pipeline: fakePipeline(),
      stream,
      quarantine: async () => ({ ok: true }),
    });
    const fallback = await withoutOverride.run(7, { prompt: 'p', model: grokModel });
    expect(fallback.state).toBe('final');
    if (fallback.state === 'final') {
      expect(fallback.route).toEqual({ provider: 'grok', model: 'grok-4.5', transport: 'cli' });
    }
  });

  it('forwards abort during quarantine to the injected seam', async () => {
    let quarantineSignal: AbortSignal | undefined;
    const quarantine = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      quarantineSignal = signal;
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { ok: false as const, kind: 'quarantine-cancelled' as const };
    });
    const stream = async (_req: AiChatRequest, onEvent: (e: AiChatEvent) => void) => {
      onEvent({ kind: 'delta', text: '<html>ok</html>' });
      onEvent({ kind: 'done', text: '' });
    };
    const gen = createHtmlExportGenerator({
      pipeline: fakePipeline(),
      stream,
      quarantine,
    });

    const running = gen.run(7, { prompt: 'p', model: MODEL });
    // Wait until quarantine is entered, then cancel.
    await vi.waitFor(() => expect(quarantine).toHaveBeenCalled());
    expect(quarantineSignal).toBeDefined();
    gen.cancel(7);
    const result = await running;

    expect(quarantineSignal?.aborted).toBe(true);
    expect(result.state).toBe('cancelled');
  });

  it('forwards the selected viewport into the quarantine seam', async () => {
    const quarantine = vi.fn(async () => ({ ok: true as const }));
    const stream = async (_req: AiChatRequest, onEvent: (e: AiChatEvent) => void) => {
      onEvent({ kind: 'delta', text: '<html>ok</html>' });
      onEvent({ kind: 'done', text: '' });
    };
    const gen = createHtmlExportGenerator({
      pipeline: fakePipeline(),
      stream,
      quarantine,
    });

    const viewport = { width: 720, height: 1280 };
    const result = await gen.run(7, { prompt: 'p', model: MODEL, viewport });
    expect(result.state).toBe('final');
    expect(quarantine).toHaveBeenCalledTimes(1);
    expect(quarantine.mock.calls[0][0].viewport).toEqual(viewport);
  });
});
