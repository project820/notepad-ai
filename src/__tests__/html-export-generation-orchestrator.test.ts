import { describe, expect, it, vi } from 'vitest';

import {
  createHtmlExportPipelineError,
  type FinalizedArtifactId,
  type HtmlExportArtifactRef,
  type HtmlExportAttemptId,
  type HtmlExportPipelineErrorKind,
  type HtmlExportPipelineResult,
  type HtmlExportQuarantineErrorKind,
  type RawArtifactId,
  type ResolvedArtifactId,
  type SanitizedArtifactId,
} from '../shared/html-export-pipeline';
import {
  HtmlExportGenerationOrchestrator,
  type GenerateFn,
  type GenerationOutput,
  type GenerationRoute,
  type OrchestratorPipeline,
  type QuarantineMeasureFn,
} from '../main/html-export-generation-orchestrator';

const ROUTE: GenerationRoute = {
  provider: 'claude',
  model: 'claude-sonnet',
  transport: 'cli',
};

const PROMPT = 'Write a complete self-contained HTML document.';
const WEB_CONTENTS_ID = 7;

function success<T>(value: T): HtmlExportPipelineResult<T> {
  return { ok: true, value };
}

function failure<T>(kind: HtmlExportPipelineErrorKind): HtmlExportPipelineResult<T> {
  return { ok: false, error: createHtmlExportPipelineError(kind) };
}

function attempt(id: string): HtmlExportAttemptId {
  return id as HtmlExportAttemptId;
}

function rawId(id: string): RawArtifactId {
  return id as RawArtifactId;
}

function sanitizedId(id: string): SanitizedArtifactId {
  return id as SanitizedArtifactId;
}

function resolvedId(id: string): ResolvedArtifactId {
  return id as ResolvedArtifactId;
}

function finalizedId(id: string): FinalizedArtifactId {
  return id as FinalizedArtifactId;
}

function artifactRef<Stage extends 'raw' | 'sanitized' | 'resolved' | 'finalized'>(
  stage: Stage,
  id: string,
  attemptId: HtmlExportAttemptId = attempt('attempt-1'),
): HtmlExportArtifactRef<Stage> {
  return {
    id: id as HtmlExportArtifactRef<Stage>['id'],
    attemptId,
    stage,
    sha256: 'a'.repeat(64),
    byteLength: 32,
  };
}

function okOutput(overrides: Partial<GenerationOutput> = {}): GenerationOutput {
  return {
    html: '<!doctype html><html><body><h1>ok</h1></body></html>',
    route: ROUTE,
    decodedBytes: 64,
    doneSeen: true,
    capped: false,
    truncated: false,
    ...overrides,
  };
}

type FakePipelineControls = {
  begin?: HtmlExportPipelineResult<{ attemptId: HtmlExportAttemptId }>;
  storeRaw?: HtmlExportPipelineResult<HtmlExportArtifactRef<'raw'>>;
  sanitize?: HtmlExportPipelineResult<{ artifact: HtmlExportArtifactRef<'sanitized'> }>;
  resolve?: HtmlExportPipelineResult<{ artifact: HtmlExportArtifactRef<'resolved'> }>;
  finalize?: HtmlExportPipelineResult<{ artifact: HtmlExportArtifactRef<'finalized'> }>;
};

function createFakePipeline(controls: FakePipelineControls = {}): OrchestratorPipeline & {
  invalidateAttempt: ReturnType<typeof vi.fn>;
  storeRawModelOutput: ReturnType<typeof vi.fn>;
  beginAttempt: ReturnType<typeof vi.fn>;
} {
  const attemptId = attempt('attempt-1');
  const beginAttempt = vi.fn(() => controls.begin ?? success({ attemptId }));
  const storeRawModelOutput = vi.fn(
    (_wc: number, _aid: HtmlExportAttemptId, _html: string) =>
      controls.storeRaw ?? success(artifactRef('raw', 'raw-1', attemptId)),
  );
  const sanitize = vi.fn(async () =>
    controls.sanitize ?? success({ artifact: artifactRef('sanitized', 'sanitized-1', attemptId) }),
  );
  const resolve = vi.fn(async () =>
    controls.resolve ?? success({ artifact: artifactRef('resolved', 'resolved-1', attemptId) }),
  );
  const finalize = vi.fn(
    () => controls.finalize ?? success({ artifact: artifactRef('finalized', 'finalized-1', attemptId) }),
  );
  const invalidateAttempt = vi.fn(() => success({}));

  return {
    beginAttempt,
    storeRawModelOutput,
    sanitize,
    resolve,
    finalize,
    invalidateAttempt,
  };
}

function createGenerate(
  outputs: Array<GenerationOutput | Error | 'throw'>,
): GenerateFn & { calls: Array<{ attemptId: HtmlExportAttemptId; prompt: string }> } {
  const queue = [...outputs];
  const calls: Array<{ attemptId: HtmlExportAttemptId; prompt: string }> = [];
  const generate: GenerateFn = async ({ attemptId, prompt, signal }) => {
    void signal;
    calls.push({ attemptId, prompt });
    const next = queue.shift();
    if (next === undefined) {
      throw new Error('generate called more times than scripted');
    }
    if (next === 'throw' || next instanceof Error) {
      throw next instanceof Error ? next : new Error('generate failed');
    }
    return next;
  };
  return Object.assign(generate, { calls });
}

function createOrchestrator(input: {
  pipeline?: ReturnType<typeof createFakePipeline>;
  generate?: GenerateFn;
  quarantine?: QuarantineMeasureFn;
}) {
  const pipeline = input.pipeline ?? createFakePipeline();
  const generate = input.generate ?? createGenerate([okOutput()]);
  return {
    pipeline,
    generate,
    orchestrator: new HtmlExportGenerationOrchestrator({
      pipeline,
      generate,
      quarantine: input.quarantine,
    }),
  };
}

describe('HtmlExportGenerationOrchestrator', () => {
  it('happy path reaches final with finalizedArtifactId, route, and callCount=1', async () => {
    const { orchestrator, pipeline, generate } = createOrchestrator({});
    const result = await orchestrator.run(WEB_CONTENTS_ID, PROMPT);

    expect(result).toEqual({
      state: 'final',
      attemptId: attempt('attempt-1'),
      finalizedArtifactId: finalizedId('finalized-1'),
      resolvedArtifactId: resolvedId('resolved-1'),
      sanitizedArtifactId: sanitizedId('sanitized-1'),
      route: ROUTE,
      callCount: 1,
    });
    expect(pipeline.beginAttempt).toHaveBeenCalledWith(WEB_CONTENTS_ID);
    expect(pipeline.storeRawModelOutput).toHaveBeenCalledTimes(1);
    expect(pipeline.invalidateAttempt).not.toHaveBeenCalled();
    expect((generate as ReturnType<typeof createGenerate>).calls).toHaveLength(1);
  });
  it('injects the selected slide runtime before quarantine and finalizes the same mode', async () => {
    const quarantine: QuarantineMeasureFn = vi.fn(async () => ({ ok: true as const }));
    const pipeline = createFakePipeline();
    const { orchestrator } = createOrchestrator({ pipeline, quarantine });

    const result = await orchestrator.run(WEB_CONTENTS_ID, PROMPT, { mode: 'slide', locale: 'ko' });

    expect(result.state).toBe('final');
    expect(pipeline.resolve).toHaveBeenCalledWith(
      WEB_CONTENTS_ID,
      attempt('attempt-1'),
      sanitizedId('sanitized-1'),
      'slide',
      'ko',
    );
    expect(quarantine).toHaveBeenCalledAfter(pipeline.resolve as ReturnType<typeof vi.fn>);
    expect(pipeline.finalize).toHaveBeenCalledWith(
      WEB_CONTENTS_ID,
      attempt('attempt-1'),
      resolvedId('resolved-1'),
      'slide',
      'ko',
    );
  });

  it('zero-decoded-byte first output retries exactly once on the same route then succeeds', async () => {
    const generate = createGenerate([
      okOutput({ html: '', decodedBytes: 0 }),
      okOutput({ html: '<html>retry</html>', decodedBytes: 42 }),
    ]);
    const { orchestrator, pipeline } = createOrchestrator({ generate });

    const result = await orchestrator.run(WEB_CONTENTS_ID, PROMPT);

    expect(result.state).toBe('final');
    if (result.state !== 'final') throw new Error('expected final');
    expect(result.callCount).toBe(2);
    expect(result.route).toEqual(ROUTE);
    expect(generate.calls).toHaveLength(2);
    expect(generate.calls[0]?.attemptId).toBe(generate.calls[1]?.attemptId);
    expect(generate.calls[0]?.prompt).toBe(PROMPT);
    expect(generate.calls[1]?.prompt).toBe(PROMPT);
    expect(pipeline.storeRawModelOutput).toHaveBeenCalledWith(
      WEB_CONTENTS_ID,
      attempt('attempt-1'),
      '<html>retry</html>',
    );
  });

  it('two consecutive zero-decoded-byte outputs fail generate with callCount=2 and no storeRaw', async () => {
    const generate = createGenerate([
      okOutput({ html: '', decodedBytes: 0 }),
      okOutput({ html: '', decodedBytes: 0 }),
    ]);
    const { orchestrator, pipeline } = createOrchestrator({ generate });

    const result = await orchestrator.run(WEB_CONTENTS_ID, PROMPT);

    expect(result).toEqual({
      state: 'failed',
      stage: 'generate',
      kind: 'pipeline-reject',
      route: ROUTE,
      callCount: 2,
    });
    expect(pipeline.storeRawModelOutput).not.toHaveBeenCalled();
    expect(generate.calls).toHaveLength(2);
  });

  it.each([
    {
      name: 'capped',
      output: okOutput({ capped: true, decodedBytes: 100 }),
      kind: 'pipeline-oversize' as const,
    },
    {
      name: 'truncated',
      output: okOutput({ truncated: true, decodedBytes: 100 }),
      kind: 'pipeline-oversize' as const,
    },
    {
      name: '!doneSeen',
      output: okOutput({ doneSeen: false, decodedBytes: 100 }),
      kind: 'pipeline-reject' as const,
    },
  ])('$name output is failed (never success) and not retried', async ({ output, kind }) => {
    const generate = createGenerate([output]);
    const { orchestrator, pipeline } = createOrchestrator({ generate });

    const result = await orchestrator.run(WEB_CONTENTS_ID, PROMPT);

    expect(result).toEqual({
      state: 'failed',
      stage: 'generate',
      kind,
      route: ROUTE,
      callCount: 1,
    });
    expect(generate.calls).toHaveLength(1);
    expect(pipeline.storeRawModelOutput).not.toHaveBeenCalled();
  });

  it('generate throw maps to failed(generate, pipeline-reject)', async () => {
    const generate = createGenerate(['throw']);
    const { orchestrator, pipeline } = createOrchestrator({ generate });

    const result = await orchestrator.run(WEB_CONTENTS_ID, PROMPT);

    expect(result).toEqual({
      state: 'failed',
      stage: 'generate',
      kind: 'pipeline-reject',
      callCount: 1,
    });
    expect(pipeline.storeRawModelOutput).not.toHaveBeenCalled();
  });

  it.each([
    {
      stage: 'begin' as const,
      controls: { begin: failure<{ attemptId: HtmlExportAttemptId }>('wrong-sender') },
      kind: 'wrong-sender' as const,
      expectStore: false,
    },
    {
      stage: 'store-raw' as const,
      controls: { storeRaw: failure<HtmlExportArtifactRef<'raw'>>('pipeline-oversize') },
      kind: 'pipeline-oversize' as const,
      expectStore: true,
    },
    {
      stage: 'sanitize' as const,
      controls: {
        sanitize: failure<{ artifact: HtmlExportArtifactRef<'sanitized'> }>('pipeline-reject'),
      },
      kind: 'pipeline-reject' as const,
      expectStore: true,
    },
    {
      stage: 'resolve' as const,
      controls: {
        resolve: failure<{ artifact: HtmlExportArtifactRef<'resolved'> }>('stale-artifact'),
      },
      kind: 'stale-artifact' as const,
      expectStore: true,
    },
    {
      stage: 'finalize' as const,
      controls: {
        finalize: failure<{ artifact: HtmlExportArtifactRef<'finalized'> }>('unknown-artifact'),
      },
      kind: 'unknown-artifact' as const,
      expectStore: true,
    },
  ])('pipeline error at $stage maps to failed with stage+kind', async ({ stage, controls, kind, expectStore }) => {
    const pipeline = createFakePipeline(controls);
    const { orchestrator } = createOrchestrator({ pipeline });

    const result = await orchestrator.run(WEB_CONTENTS_ID, PROMPT);

    if (stage === 'begin') {
      expect(result).toEqual({
        state: 'failed',
        stage: 'begin',
        kind,
      });
      expect(pipeline.storeRawModelOutput).not.toHaveBeenCalled();
      return;
    }

    expect(result).toEqual({
      state: 'failed',
      stage,
      kind,
      route: ROUTE,
      callCount: 1,
    });
    if (expectStore && stage !== 'store-raw') {
      expect(pipeline.storeRawModelOutput).toHaveBeenCalled();
    }
    if (stage === 'store-raw') {
      expect(pipeline.storeRawModelOutput).toHaveBeenCalled();
    }
  });

  it('quarantine recoverable-failure yields partial with resolvedArtifactId', async () => {
    const quarantine: QuarantineMeasureFn = vi.fn(async () => ({
      ok: false as const,
      kind: 'recoverable-failure' as HtmlExportQuarantineErrorKind,
    }));
    const pipeline = createFakePipeline();
    const { orchestrator } = createOrchestrator({ pipeline, quarantine });

    const result = await orchestrator.run(WEB_CONTENTS_ID, PROMPT);

    expect(result).toEqual({
      state: 'partial',
      attemptId: attempt('attempt-1'),
      resolvedArtifactId: resolvedId('resolved-1'),
      quarantineKind: 'recoverable-failure',
      route: ROUTE,
      callCount: 1,
    });
    expect(pipeline.finalize).not.toHaveBeenCalled();
    expect(quarantine).toHaveBeenCalledWith(
      expect.objectContaining({
        webContentsId: WEB_CONTENTS_ID,
        attemptId: attempt('attempt-1'),
        resolvedArtifactId: resolvedId('resolved-1'),
      }),
    );
  });

  it('non-recoverable quarantine kind yields failed(quarantine)', async () => {
    const quarantine: QuarantineMeasureFn = vi.fn(async () => ({
      ok: false as const,
      kind: 'quarantine-timeout' as HtmlExportQuarantineErrorKind,
    }));
    const pipeline = createFakePipeline();
    const { orchestrator } = createOrchestrator({ pipeline, quarantine });

    const result = await orchestrator.run(WEB_CONTENTS_ID, PROMPT);

    expect(result).toEqual({
      state: 'failed',
      stage: 'quarantine',
      kind: 'quarantine-timeout',
      route: ROUTE,
      callCount: 1,
    });
    expect(pipeline.finalize).not.toHaveBeenCalled();
  });

  it('no injected quarantine proceeds straight to finalize', async () => {
    const pipeline = createFakePipeline();
    const { orchestrator } = createOrchestrator({ pipeline });

    const result = await orchestrator.run(WEB_CONTENTS_ID, PROMPT);

    expect(result.state).toBe('final');
    expect(pipeline.finalize).toHaveBeenCalledWith(
      WEB_CONTENTS_ID,
      attempt('attempt-1'),
      resolvedId('resolved-1'),
    );
  });

  it('already-aborted signal returns cancelled before beginAttempt', async () => {
    const pipeline = createFakePipeline();
    const generate = createGenerate([okOutput()]);
    const { orchestrator } = createOrchestrator({ pipeline, generate });
    const controller = new AbortController();
    controller.abort();

    const result = await orchestrator.run(WEB_CONTENTS_ID, PROMPT, { signal: controller.signal });

    expect(result).toEqual({ state: 'cancelled' });
    expect(pipeline.beginAttempt).not.toHaveBeenCalled();
    expect(generate.calls).toHaveLength(0);
    expect(pipeline.invalidateAttempt).not.toHaveBeenCalled();
  });

  it('signal aborted mid-run returns cancelled and invalidates the attempt', async () => {
    const controller = new AbortController();
    const pipeline = createFakePipeline();
    const generate = createGenerate([okOutput()]);
    // Abort after generate returns, before storeRaw — simulate via storeRaw side effect.
    pipeline.storeRawModelOutput.mockImplementation(() => {
      controller.abort();
      return success(artifactRef('raw', 'raw-1'));
    });
    // Actually abort should be checked at stage boundaries. Abort during sanitize:
    pipeline.sanitize.mockImplementation(async () => {
      controller.abort();
      return success({ artifact: artifactRef('sanitized', 'sanitized-1') });
    });

    const { orchestrator } = createOrchestrator({ pipeline, generate });
    const result = await orchestrator.run(WEB_CONTENTS_ID, PROMPT, { signal: controller.signal });

    expect(result.state).toBe('cancelled');
    if (result.state !== 'cancelled') throw new Error('expected cancelled');
    expect(result.route).toEqual(ROUTE);
    expect(result.callCount).toBe(1);
    expect(pipeline.invalidateAttempt).toHaveBeenCalledWith(WEB_CONTENTS_ID, attempt('attempt-1'));
    expect(pipeline.resolve).not.toHaveBeenCalled();
  });

  it('signal aborted after generate (before store) cancels and invalidates', async () => {
    const controller = new AbortController();
    const pipeline = createFakePipeline();
    const generate: GenerateFn = async () => {
      controller.abort();
      return okOutput();
    };
    const { orchestrator } = createOrchestrator({ pipeline, generate });

    const result = await orchestrator.run(WEB_CONTENTS_ID, PROMPT, { signal: controller.signal });

    expect(result).toEqual({
      state: 'cancelled',
      route: ROUTE,
      callCount: 1,
    });
    expect(pipeline.storeRawModelOutput).not.toHaveBeenCalled();
    expect(pipeline.invalidateAttempt).toHaveBeenCalledWith(WEB_CONTENTS_ID, attempt('attempt-1'));
  });

  it('carries route/model metadata on every terminal result that ran a generation', async () => {
    const pipeline = createFakePipeline({
      sanitize: failure<{ artifact: HtmlExportArtifactRef<'sanitized'> }>('pipeline-reject'),
    });
    const { orchestrator } = createOrchestrator({ pipeline });

    const result = await orchestrator.run(WEB_CONTENTS_ID, PROMPT);

    expect(result.state).toBe('failed');
    if (result.state !== 'failed') throw new Error('expected failed');
    expect(result.route).toEqual(ROUTE);
    expect(result.callCount).toBe(1);
  });

  it('is deterministic given deterministic fakes', async () => {
    const make = () => {
      const pipeline = createFakePipeline();
      const generate = createGenerate([okOutput({ html: '<html>same</html>', decodedBytes: 12 })]);
      return new HtmlExportGenerationOrchestrator({ pipeline, generate });
    };

    const a = await make().run(WEB_CONTENTS_ID, PROMPT);
    const b = await make().run(WEB_CONTENTS_ID, PROMPT);

    expect(a).toEqual(b);
    expect(a).toEqual({
      state: 'final',
      attemptId: attempt('attempt-1'),
      finalizedArtifactId: finalizedId('finalized-1'),
      resolvedArtifactId: resolvedId('resolved-1'),
      sanitizedArtifactId: sanitizedId('sanitized-1'),
      route: ROUTE,
      callCount: 1,
    });
  });

  it('does not retry capped output even when decodedBytes is positive', async () => {
    const generate = createGenerate([
      okOutput({ capped: true, decodedBytes: 8 }),
      okOutput({ decodedBytes: 8 }), // would succeed if wrongly retried
    ]);
    const { orchestrator } = createOrchestrator({ generate });

    const result = await orchestrator.run(WEB_CONTENTS_ID, PROMPT);

    expect(result.state).toBe('failed');
    expect(generate.calls).toHaveLength(1);
  });

  it('passes the shared AbortSignal into generate and quarantine', async () => {
    const controller = new AbortController();
    const seen: AbortSignal[] = [];
    const generate: GenerateFn = async ({ signal }) => {
      seen.push(signal);
      return okOutput();
    };
    const quarantine: QuarantineMeasureFn = async ({ signal }) => {
      seen.push(signal);
      return { ok: true };
    };
    const { orchestrator } = createOrchestrator({ generate, quarantine });

    await orchestrator.run(WEB_CONTENTS_ID, PROMPT, { signal: controller.signal });

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(controller.signal);
    expect(seen[1]).toBe(controller.signal);
  });

  it('unexpected pipeline throw invalidates and returns failed(pipeline-reject)', async () => {
    const pipeline = createFakePipeline();
    pipeline.sanitize.mockImplementation(async () => {
      throw new Error('boom');
    });
    const { orchestrator } = createOrchestrator({ pipeline });

    const result = await orchestrator.run(WEB_CONTENTS_ID, PROMPT);

    expect(result).toEqual({
      state: 'failed',
      stage: 'sanitize',
      kind: 'pipeline-reject',
      route: ROUTE,
      callCount: 1,
    });
    expect(pipeline.invalidateAttempt).toHaveBeenCalledWith(WEB_CONTENTS_ID, attempt('attempt-1'));
  });
  it.each(['capped', 'truncated', 'doneSeen'] as const)(
    'never retries a zero-decoded-byte output that also has a hard-failure flag (%s)',
    async (flag) => {
      const zeroHardFail = okOutput(
        flag === 'doneSeen'
          ? { decodedBytes: 0, doneSeen: false }
          : { decodedBytes: 0, [flag]: true },
      );
      const generate = createGenerate([zeroHardFail, okOutput()]);
      const { orchestrator } = createOrchestrator({ generate });

      const result = await orchestrator.run(WEB_CONTENTS_ID, PROMPT);

      // Hard-failure flags are never success and never retried, even at zero bytes.
      expect(result.state).toBe('failed');
      if (result.state === 'failed') {
        expect(result.stage).toBe('generate');
        expect(result.callCount).toBe(1);
      }
      expect(generate.calls).toHaveLength(1);
    },
  );

  it('fails a zero-byte retry that returns a different route (same-route pin)', async () => {
    const generate = createGenerate([
      okOutput({ decodedBytes: 0 }),
      okOutput({ route: { provider: 'claude', model: 'other', transport: 'api' } }),
    ]);
    const { orchestrator, pipeline } = createOrchestrator({ generate });

    const result = await orchestrator.run(WEB_CONTENTS_ID, PROMPT);

    expect(result.state).toBe('failed');
    if (result.state === 'failed') {
      expect(result.stage).toBe('generate');
      expect(result.kind).toBe('pipeline-reject');
      expect(result.callCount).toBe(2);
      expect(result.route).toEqual(ROUTE);
    }
    expect(pipeline.storeRawModelOutput).not.toHaveBeenCalled();
  });

  it('sanitizes the route to provider/model/transport only — never leaks extra fields', async () => {
    const leaky = {
      provider: 'claude',
      model: 'claude-sonnet',
      transport: 'cli',
      apiKey: 'sk-secret',
      path: '/private/key.pem',
      decodedDump: 'AAAA',
    } as unknown as GenerationRoute;
    const generate = createGenerate([okOutput({ route: leaky })]);
    const { orchestrator } = createOrchestrator({ generate });

    const result = await orchestrator.run(WEB_CONTENTS_ID, PROMPT);

    expect(result.state).toBe('final');
    if (result.state === 'final') {
      expect(result.route).toEqual({ provider: 'claude', model: 'claude-sonnet', transport: 'cli' });
      expect(Object.keys(result.route).sort()).toEqual(['model', 'provider', 'transport']);
    }
    expect(JSON.stringify(result)).not.toMatch(/sk-secret|\/private\/key\.pem|decodedDump/);
  });
});
