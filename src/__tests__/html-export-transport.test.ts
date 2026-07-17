import { describe, expect, it, vi } from 'vitest';

import type { AiChatEvent, AiChatRequest } from '../main/ai/types';
import {
  createHtmlExportTransport,
  HTML_TRANSPORT_LIMITS,
  type HtmlExportTransportDeps,
  type PinnedTransportStream,
  type StartTimer,
} from '../main/html-export-transport';
import {
  HtmlExportGenerationOrchestrator,
  type OrchestratorPipeline,
} from '../main/html-export-generation-orchestrator';
import {
  type HtmlExportArtifactRef,
  type HtmlExportAttemptId,
  type HtmlExportPipelineResult,
} from '../shared/html-export-pipeline';

const PROMPT = 'Write a complete self-contained HTML document.';

function attempt(id: string): HtmlExportAttemptId {
  return id as HtmlExportAttemptId;
}

/** Stream that emits a fixed script of events (respecting abort) then resolves. */
function scriptedStream(
  events: AiChatEvent[],
  opts: { throwAfter?: boolean } = {},
): PinnedTransportStream & { requests: AiChatRequest[] } {
  const requests: AiChatRequest[] = [];
  const stream: PinnedTransportStream = async (req, onEvent) => {
    requests.push(req);
    for (const event of events) {
      if (req.signal?.aborted) return;
      onEvent(event);
    }
    if (opts.throwAfter) throw new Error('transport boom');
  };
  return Object.assign(stream, { requests });
}

/** A stream that emits nothing and resolves only when its request signal aborts. */
function silentUntilAbortStream(): PinnedTransportStream & { requests: AiChatRequest[] } {
  const requests: AiChatRequest[] = [];
  const stream: PinnedTransportStream = (req, _onEvent) =>
    new Promise<void>((resolve) => {
      requests.push(req);
      if (req.signal?.aborted) return resolve();
      req.signal?.addEventListener('abort', () => resolve(), { once: true });
    });
  return Object.assign(stream, { requests });
}

/** Manual timer seam: tests fire the first-byte deadline explicitly. */
function manualTimer(): { start: StartTimer; fire: () => void } {
  const pending: Array<{ cb: () => void; cancelled: boolean }> = [];
  const start: StartTimer = (_ms, cb) => {
    const entry = { cb, cancelled: false };
    pending.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  return {
    start,
    fire: () => {
      for (const entry of pending) if (!entry.cancelled) entry.cb();
    },
  };
}

function transport(
  overrides: Partial<HtmlExportTransportDeps> & Pick<HtmlExportTransportDeps, 'stream'>,
) {
  return createHtmlExportTransport({
    model: { provider: 'claude', id: 'claude-sonnet' },
    transport: 'cli',
    ...overrides,
  });
}

function run(fn: ReturnType<typeof transport>, signal?: AbortSignal) {
  return fn({ attemptId: attempt('attempt-1'), prompt: PROMPT, signal: signal ?? new AbortController().signal });
}

describe('createHtmlExportTransport — happy path + pinned route', () => {
  it('assembles deltas, marks doneSeen, and pins provider/model/transport', async () => {
    const stream = scriptedStream([
      { kind: 'delta', text: '<!doctype html>' },
      { kind: 'delta', text: '<html><body>hi</body></html>' },
      { kind: 'done', text: '' },
    ]);
    const out = await run(transport({ stream }));

    expect(out.html).toBe('<!doctype html><html><body>hi</body></html>');
    expect(out.doneSeen).toBe(true);
    expect(out.capped).toBe(false);
    expect(out.truncated).toBe(false);
    expect(out.decodedBytes).toBe(out.html.length);
    expect(out.route).toEqual({ provider: 'claude', model: 'claude-sonnet', transport: 'cli' });
    expect(Object.keys(out.route).sort()).toEqual(['model', 'provider', 'transport']);
  });

  it('sends surfaceMode html, the pinned model, the prompt, and instructions', async () => {
    const stream = scriptedStream([{ kind: 'done', text: 'x' }]);
    await run(transport({ stream, instructions: 'SYSTEM RULES', maxOutputTokens: 32_000 }));

    const req = stream.requests[0]!;
    expect(req.surfaceMode).toBe('html');
    expect(req.model).toEqual({ provider: 'claude', id: 'claude-sonnet' });
    expect(req.userText).toBe(PROMPT);
    expect(req.instructions).toBe('SYSTEM RULES');
    expect(req.maxOutputTokens).toBe(32_000);
    expect(req.history).toEqual([]);
  });
  it('forwards GPT Fast reasoningEffort to the pinned provider request', async () => {
    const stream = scriptedStream([{ kind: 'done', text: 'x' }]);
    await run(transport({
      stream,
      model: { provider: 'chatgpt', id: 'gpt-5.6-sol' },
      transport: 'api',
      reasoningEffort: 'low',
    }));

    expect(stream.requests[0]!.reasoningEffort).toBe('low');
  });

  it('omits maxOutputTokens when not provided', async () => {
    const stream = scriptedStream([{ kind: 'done', text: 'x' }]);
    await run(transport({ stream }));
    expect('maxOutputTokens' in stream.requests[0]!).toBe(false);
  });

  it('counts decodedBytes as UTF-8 length, not UTF-16 char length', async () => {
    const stream = scriptedStream([
      { kind: 'delta', text: '가나다' }, // 3 chars, 9 UTF-8 bytes
      { kind: 'done', text: '' },
    ]);
    const out = await run(transport({ stream }));
    expect(out.html.length).toBe(3);
    expect(out.decodedBytes).toBe(9);
  });

  it('uses api transport when pinned to api', async () => {
    const stream = scriptedStream([{ kind: 'done', text: 'x' }]);
    const out = await run(transport({ stream, transport: 'api' }));
    expect(out.route.transport).toBe('api');
  });
});

describe('createHtmlExportTransport — zero-byte + rejection metadata', () => {
  it('clean done with no text is a retryable zero-byte completion', async () => {
    const stream = scriptedStream([{ kind: 'done', text: '' }]);
    const out = await run(transport({ stream }));

    expect(out.decodedBytes).toBe(0);
    expect(out.doneSeen).toBe(true);
    expect(out.capped).toBe(false);
    expect(out.truncated).toBe(false);
  });

  it('a pre-output error yields doneSeen:false with zero bytes (not truncated)', async () => {
    const stream = scriptedStream([{ kind: 'error', message: 'auth failed', errorKind: 'auth' }]);
    const out = await run(transport({ stream }));

    expect(out.decodedBytes).toBe(0);
    expect(out.doneSeen).toBe(false);
    expect(out.truncated).toBe(false);
  });

  it('a mid-stream error after deltas is a truncated cut output', async () => {
    const stream = scriptedStream([
      { kind: 'delta', text: '<html>partial' },
      { kind: 'error', message: 'network down', errorKind: 'network' },
    ]);
    const out = await run(transport({ stream }));

    expect(out.decodedBytes).toBeGreaterThan(0);
    expect(out.doneSeen).toBe(false);
    expect(out.truncated).toBe(true);
  });

  it('a thrown stream after deltas is a truncated cut output', async () => {
    const stream = scriptedStream([{ kind: 'delta', text: '<html>partial' }], { throwAfter: true });
    const out = await run(transport({ stream }));

    expect(out.doneSeen).toBe(false);
    expect(out.truncated).toBe(true);
    expect(out.decodedBytes).toBeGreaterThan(0);
  });

  it('a thrown stream before any output is a zero-byte non-truncated failure', async () => {
    const stream = scriptedStream([], { throwAfter: true });
    const out = await run(transport({ stream }));

    expect(out.decodedBytes).toBe(0);
    expect(out.doneSeen).toBe(false);
    expect(out.truncated).toBe(false);
  });

  it('a premature end (resolve without done) after deltas is truncated', async () => {
    const stream = scriptedStream([{ kind: 'delta', text: '<html>partial' }]);
    const out = await run(transport({ stream }));

    expect(out.doneSeen).toBe(false);
    expect(out.truncated).toBe(true);
    expect(out.decodedBytes).toBeGreaterThan(0);
  });

  it('a premature end with zero bytes is a retryable-shaped non-truncated failure', async () => {
    const stream = scriptedStream([]);
    const out = await run(transport({ stream }));

    expect(out.decodedBytes).toBe(0);
    expect(out.doneSeen).toBe(false);
    expect(out.truncated).toBe(false);
  });
});

describe('createHtmlExportTransport — done.text adoption', () => {
  it('adopts the done text when it carries more bytes than the deltas', async () => {
    const stream = scriptedStream([{ kind: 'done', text: '<html>full body</html>' }]);
    const out = await run(transport({ stream }));

    expect(out.html).toBe('<html>full body</html>');
    expect(out.doneSeen).toBe(true);
    expect(out.decodedBytes).toBe('<html>full body</html>'.length);
  });

  it('keeps the assembled deltas when done text is not longer', async () => {
    const stream = scriptedStream([
      { kind: 'delta', text: '<html>assembled long body</html>' },
      { kind: 'done', text: 'short' },
    ]);
    const out = await run(transport({ stream }));
    expect(out.html).toBe('<html>assembled long body</html>');
  });
});

describe('createHtmlExportTransport — 8 MiB cap', () => {
  it('marks capped when assembled deltas exceed the byte cap', async () => {
    const chunk = 'a'.repeat(4);
    const stream = scriptedStream([
      { kind: 'delta', text: chunk },
      { kind: 'delta', text: chunk },
      { kind: 'delta', text: chunk },
      { kind: 'done', text: '' },
    ]);
    const out = await run(transport({ stream, caps: { outputCapBytes: 8 } }));

    expect(out.capped).toBe(true);
    expect(out.doneSeen).toBe(false); // done after cap must not flip to success
    expect(out.decodedBytes).toBeGreaterThan(8);
  });

  it('marks capped when the done text alone exceeds the cap', async () => {
    const stream = scriptedStream([{ kind: 'done', text: 'x'.repeat(20) }]);
    const out = await run(transport({ stream, caps: { outputCapBytes: 8 } }));

    expect(out.capped).toBe(true);
    expect(out.doneSeen).toBe(false);
  });

  it('defaults the cap to the frozen 8 MiB value', () => {
    expect(HTML_TRANSPORT_LIMITS.outputCapBytes).toBe(8 * 1024 * 1024);
    expect(HTML_TRANSPORT_LIMITS.firstByteMs).toBe(240_000);
  });
});

describe('createHtmlExportTransport — deadlines + cancellation', () => {
  it('starts the first-byte timer at the 240s HTML cap', async () => {
    const start = vi.fn<StartTimer>(() => vi.fn());
    const stream = scriptedStream([{ kind: 'delta', text: 'hello' }, { kind: 'done', text: '' }]);

    await run(transport({ stream, startTimer: start }));

    expect(start).toHaveBeenCalledWith(240_000, expect.any(Function));
  });
  it('first-byte deadline aborts the stream as a zero-byte failure', async () => {
    const stream = silentUntilAbortStream();
    const timer = manualTimer();
    const fn = transport({ stream, startTimer: timer.start });
    const promise = run(fn);
    timer.fire();
    const out = await promise;

    expect(stream.requests[0]!.signal?.aborted).toBe(true);
    expect(out.decodedBytes).toBe(0);
    expect(out.doneSeen).toBe(false);
    expect(out.truncated).toBe(false);
  });

  it('does not fire the first-byte deadline once a delta arrives', async () => {
    const cancelSpy = vi.fn();
    const start: StartTimer = () => cancelSpy;
    const stream = scriptedStream([
      { kind: 'delta', text: 'hello' },
      { kind: 'done', text: '' },
    ]);
    const out = await run(transport({ stream, startTimer: start }));

    expect(cancelSpy).toHaveBeenCalled();
    expect(out.doneSeen).toBe(true);
  });

  it('an already-aborted external signal aborts the stream immediately', async () => {
    const stream = silentUntilAbortStream();
    const controller = new AbortController();
    controller.abort();
    const out = await run(transport({ stream }), controller.signal);

    expect(stream.requests[0]!.signal?.aborted).toBe(true);
    expect(out.decodedBytes).toBe(0);
  });

  it('an external abort mid-stream stops accumulation', async () => {
    const stream = silentUntilAbortStream();
    const controller = new AbortController();
    const promise = run(transport({ stream }), controller.signal);
    controller.abort();
    const out = await promise;

    expect(stream.requests[0]!.signal?.aborted).toBe(true);
    expect(out.doneSeen).toBe(false);
  });
});

describe('createHtmlExportTransport — fail-closed hardening (Grok QA D1/D2)', () => {
  it('D2: a mid-stream error followed by a done event is truncated, never a success', async () => {
    const stream = scriptedStream([
      { kind: 'delta', text: '<html>partial' },
      { kind: 'error', message: 'network down', errorKind: 'network' },
      { kind: 'done', text: '' },
    ]);
    const out = await run(transport({ stream }));

    expect(out.doneSeen).toBe(false);
    expect(out.truncated).toBe(true);
    expect(out.decodedBytes).toBeGreaterThan(0);
  });

  it('a done event followed by an error fails closed (no laundered success)', async () => {
    const stream = scriptedStream([
      { kind: 'delta', text: '<html>body</html>' },
      { kind: 'done', text: '' },
      { kind: 'error', message: 'late failure', errorKind: 'provider' },
    ]);
    const out = await run(transport({ stream }));

    expect(out.doneSeen).toBe(false);
    expect(out.truncated).toBe(true);
  });

  it('D1: a first-byte timeout freezes onEvent so a late delta+done cannot forge success', async () => {
    const timer = manualTimer();
    // A hung provider that ignores the abort signal and emits AFTER the deadline.
    const stream: PinnedTransportStream = async (_req, onEvent) => {
      timer.fire(); // deadline elapses before any output
      onEvent({ kind: 'delta', text: '<html>late body</html>' });
      onEvent({ kind: 'done', text: '' });
    };
    const out = await run(transport({ stream, startTimer: timer.start }));

    expect(out.doneSeen).toBe(false);
    expect(out.decodedBytes).toBe(0);
    expect(out.truncated).toBe(false);
    expect(out.html).toBe('');
  });

  it('D1: a first-byte timeout followed by a late empty done cannot fuel a zero-byte retry', async () => {
    const timer = manualTimer();
    const stream: PinnedTransportStream = async (_req, onEvent) => {
      timer.fire();
      onEvent({ kind: 'done', text: '' }); // late clean-looking done
    };
    const out = await run(transport({ stream, startTimer: timer.start }));

    // decodedBytes===0 && doneSeen===false → orchestrator rejects (pipeline-reject),
    // never the retryable zero-byte-clean-done shape.
    expect(out.doneSeen).toBe(false);
    expect(out.decodedBytes).toBe(0);
  });

  it('a post-done delta that exceeds the cap fails closed (capped, not a laundered success)', async () => {
    const stream = scriptedStream([
      { kind: 'done', text: 'ok' },
      { kind: 'delta', text: 'x'.repeat(50) },
    ]);
    const out = await run(transport({ stream, caps: { outputCapBytes: 8 } }));
    // Any post-done anomaly still degrades to failure: an oversize trailing delta
    // caps the output rather than standing as a clean success.
    expect(out.capped).toBe(true);
    expect(out.doneSeen).toBe(false);
  });

  it('an external abort freezes onEvent so late events cannot forge success', async () => {
    const controller = new AbortController();
    const stream: PinnedTransportStream = async (req, onEvent) => {
      controller.abort(); // caller cancels before any output
      void req;
      onEvent({ kind: 'delta', text: '<html>late</html>' });
      onEvent({ kind: 'done', text: '' });
    };
    const out = await run(transport({ stream }), controller.signal);

    expect(out.doneSeen).toBe(false);
    expect(out.decodedBytes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: the transport + orchestrator compose for the §5.3 retry rule.
// ---------------------------------------------------------------------------

function success<T>(value: T): HtmlExportPipelineResult<T> {
  return { ok: true, value };
}

function artifactRef<Stage extends 'raw' | 'sanitized' | 'resolved' | 'finalized'>(
  stage: Stage,
  id: string,
): HtmlExportArtifactRef<Stage> {
  return {
    id: id as HtmlExportArtifactRef<Stage>['id'],
    attemptId: attempt('attempt-1'),
    stage,
    sha256: 'a'.repeat(64),
    byteLength: 32,
  };
}

function fakePipeline(): OrchestratorPipeline {
  return {
    beginAttempt: () => success({ attemptId: attempt('attempt-1') }),
    storeRawModelOutput: () => success(artifactRef('raw', 'raw-1')),
    sanitize: async () => success({ artifact: artifactRef('sanitized', 'sanitized-1') }),
    resolve: async () => success({ artifact: artifactRef('resolved', 'resolved-1') }),
    finalize: () => success({ artifact: artifactRef('finalized', 'finalized-1') }),
    invalidateAttempt: () => success({}),
  };
}

describe('transport + orchestrator integration', () => {
  it('a clean zero-byte completion then real content reaches final with callCount=2', async () => {
    let call = 0;
    const stream: PinnedTransportStream = async (_req, onEvent) => {
      call += 1;
      if (call === 1) {
        onEvent({ kind: 'done', text: '' }); // clean zero-byte → retry
      } else {
        onEvent({ kind: 'delta', text: '<!doctype html><html><body>ok</body></html>' });
        onEvent({ kind: 'done', text: '' });
      }
    };
    const generate = createHtmlExportTransport({
      model: { provider: 'claude', id: 'claude-sonnet' },
      transport: 'cli',
      stream,
    });
    const orchestrator = new HtmlExportGenerationOrchestrator({ pipeline: fakePipeline(), generate });

    const result = await orchestrator.run(7, PROMPT);

    expect(result.state).toBe('final');
    if (result.state === 'final') {
      expect(result.callCount).toBe(2);
      expect(result.route).toEqual({ provider: 'claude', model: 'claude-sonnet', transport: 'cli' });
    }
    expect(call).toBe(2);
  });

  it('a mid-stream error (truncated) is rejected as pipeline-oversize without retry', async () => {
    let call = 0;
    const stream: PinnedTransportStream = async (_req, onEvent) => {
      call += 1;
      onEvent({ kind: 'delta', text: '<html>partial' });
      onEvent({ kind: 'error', message: 'network down', errorKind: 'network' });
    };
    const generate = createHtmlExportTransport({
      model: { provider: 'claude', id: 'claude-sonnet' },
      transport: 'cli',
      stream,
    });
    const orchestrator = new HtmlExportGenerationOrchestrator({ pipeline: fakePipeline(), generate });

    const result = await orchestrator.run(7, PROMPT);

    expect(result.state).toBe('failed');
    if (result.state === 'failed') {
      expect(result.stage).toBe('generate');
      expect(result.kind).toBe('pipeline-oversize');
    }
    expect(call).toBe(1); // never retried
  });
});
