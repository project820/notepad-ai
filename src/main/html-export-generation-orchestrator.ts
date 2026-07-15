/**
 * Main-process generation-attempt orchestrator (PR-M1b / AC-M1b).
 *
 * Drives ONE attempt through the main pipeline:
 *   begin -> generate -> storeRaw -> sanitize -> resolve -> quarantine? -> finalize
 *
 * Electron-free and dependency-injected. Unwired from main.ts / the live wizard;
 * transport and live activation are later goals. Consumes the existing pipeline
 * via injected seams and never re-implements pipeline stages.
 *
 * Renderer-safe metadata only (provider/model/transport); no secrets, no paths.
 */

import type {
  FinalizedArtifactId,
  HtmlExportAttemptId,
  HtmlExportArtifactRef,
  HtmlExportPipelineErrorKind,
  HtmlExportPipelineResult,
  HtmlExportQuarantineErrorKind,
  RawArtifactId,
  ResolvedArtifactId,
  SanitizedArtifactId,
} from '../shared/html-export-pipeline';

/** Renderer-safe route/model metadata (no secrets, no paths). */
export type GenerationRoute = {
  provider: string;
  model: string;
  transport: 'cli' | 'api';
};

/**
 * Terminal transport metadata for one generate invocation.
 * The orchestrator NEVER treats capped/truncated/!doneSeen or decodedBytes===0 as success.
 */
export type GenerationOutput = {
  html: string;
  route: GenerationRoute;
  decodedBytes: number;
  doneSeen: boolean;
  capped: boolean;
  truncated: boolean;
};

/** Injected model transport seam. Production wiring is a later goal. */
export type GenerateFn = (input: {
  attemptId: HtmlExportAttemptId;
  prompt: string;
  signal: AbortSignal;
}) => Promise<GenerationOutput>;

/**
 * Optional injected quarantine seam. Foundation mode omits it and proceeds to finalize.
 * Shape is intentionally narrow vs the full pool result (no measurement payload).
 */
export type QuarantineMeasureFn = (input: {
  webContentsId: number;
  attemptId: HtmlExportAttemptId;
  resolvedArtifactId: ResolvedArtifactId;
  signal: AbortSignal;
}) => Promise<{ ok: true } | { ok: false; kind: HtmlExportQuarantineErrorKind }>;

/**
 * Narrow structural Pick of HtmlExportPipelineService used by this orchestrator.
 * Keep this structural so unit tests can supply pure fakes.
 */
export type OrchestratorPipeline = {
  beginAttempt(webContentsId: number): HtmlExportPipelineResult<{ attemptId: HtmlExportAttemptId }>;
  storeRawModelOutput(
    webContentsId: number,
    attemptId: HtmlExportAttemptId,
    html: string,
  ): HtmlExportPipelineResult<HtmlExportArtifactRef<'raw'>>;
  sanitize(
    webContentsId: number,
    attemptId: HtmlExportAttemptId,
    rawArtifactId: RawArtifactId,
  ): Promise<HtmlExportPipelineResult<{ artifact: HtmlExportArtifactRef<'sanitized'> }>>;
  resolve(
    webContentsId: number,
    attemptId: HtmlExportAttemptId,
    sanitizedCandidateId: SanitizedArtifactId,
  ): Promise<HtmlExportPipelineResult<{ artifact: HtmlExportArtifactRef<'resolved'> }>>;
  finalize(
    webContentsId: number,
    attemptId: HtmlExportAttemptId,
    resolvedArtifactId: ResolvedArtifactId,
  ): HtmlExportPipelineResult<{ artifact: HtmlExportArtifactRef<'finalized'> }>;
  invalidateAttempt(webContentsId: number, attemptId: HtmlExportAttemptId): unknown;
};

type GenerationState =
  | 'generating'
  | 'sanitizing'
  | 'resolving'
  | 'quarantining'
  | 'finalizing'
  | 'final'
  | 'partial'
  | 'failed'
  | 'cancelled';

type GenerationFailedStage =
  | 'begin'
  | 'generate'
  | 'store-raw'
  | 'sanitize'
  | 'resolve'
  | 'quarantine'
  | 'finalize';

/**
 * Terminal result of one orchestrated attempt.
 * Intermediate GenerationState values are reserved for future progress surfaces.
 */
export type GenerationAttemptResult =
  | {
      state: 'final';
      attemptId: HtmlExportAttemptId;
      finalizedArtifactId: FinalizedArtifactId;
      resolvedArtifactId: ResolvedArtifactId;
      sanitizedArtifactId: SanitizedArtifactId;
      route: GenerationRoute;
      callCount: number;
    }
  | {
      state: 'partial';
      attemptId: HtmlExportAttemptId;
      resolvedArtifactId: ResolvedArtifactId;
      quarantineKind: HtmlExportQuarantineErrorKind;
      route: GenerationRoute;
      callCount: number;
    }
  | {
      state: 'failed';
      stage: GenerationFailedStage;
      kind: HtmlExportPipelineErrorKind | HtmlExportQuarantineErrorKind;
      route?: GenerationRoute;
      callCount?: number;
    }
  | {
      state: 'cancelled';
      route?: GenerationRoute;
      callCount?: number;
    };

export type HtmlExportGenerationOrchestratorDeps = {
  pipeline: OrchestratorPipeline;
  generate: GenerateFn;
  quarantine?: QuarantineMeasureFn;
};

/**
 * Drives a single generation attempt through the main pipeline with cooperative
 * cancellation and the frozen zero-decoded-byte same-route retry rule.
 */
export class HtmlExportGenerationOrchestrator {
  private readonly pipeline: OrchestratorPipeline;
  private readonly generate: GenerateFn;
  private readonly quarantine: QuarantineMeasureFn | undefined;

  constructor(deps: HtmlExportGenerationOrchestratorDeps) {
    this.pipeline = deps.pipeline;
    this.generate = deps.generate;
    this.quarantine = deps.quarantine;
  }

  async run(
    webContentsId: number,
    prompt: string,
    opts?: { signal?: AbortSignal },
  ): Promise<GenerationAttemptResult> {
    const signal = opts?.signal;
    if (signal?.aborted) {
      return { state: 'cancelled' };
    }

    let attemptId: HtmlExportAttemptId | undefined;
    let stage: GenerationFailedStage = 'begin';
    let route: GenerationRoute | undefined;
    let callCount = 0;

    const isAborted = (): boolean => Boolean(signal?.aborted);

    const invalidateBestEffort = (): void => {
      if (attemptId === undefined) return;
      try {
        this.pipeline.invalidateAttempt(webContentsId, attemptId);
      } catch {
        // best effort — pool/pipeline stays authoritative
      }
    };

    const cancelled = (): GenerationAttemptResult => {
      invalidateBestEffort();
      return route
        ? { state: 'cancelled', route, callCount }
        : callCount > 0
          ? { state: 'cancelled', callCount }
          : { state: 'cancelled' };
    };

    const failed = (
      failedStage: GenerationFailedStage,
      kind: HtmlExportPipelineErrorKind | HtmlExportQuarantineErrorKind,
    ): GenerationAttemptResult => {
      if (route) {
        return { state: 'failed', stage: failedStage, kind, route, callCount };
      }
      return callCount > 0
        ? { state: 'failed', stage: failedStage, kind, callCount }
        : { state: 'failed', stage: failedStage, kind };
    };

    try {
      // (b) begin
      stage = 'begin';
      const begun = this.pipeline.beginAttempt(webContentsId);
      if (!begun.ok) {
        return failed('begin', begun.error.kind);
      }
      attemptId = begun.value.attemptId;

      if (isAborted()) return cancelled();

      // (c) generate with frozen zero-byte retry
      stage = 'generate';

      const generation = await this.runGeneration(attemptId, prompt, signal);
      callCount = generation.callCount;
      if (generation.route) route = generation.route;

      if (generation.kind === 'cancelled') {
        return cancelled();
      }
      if (generation.kind === 'failed') {
        return failed('generate', generation.errorKind);
      }

      const html = generation.output.html;
      // route is already the sanitized route from runGeneration (never the raw
      // transport output) — do not re-read generation.output.route here.

      if (isAborted()) return cancelled();

      // (d) store raw
      stage = 'store-raw';
      const stored = this.pipeline.storeRawModelOutput(webContentsId, attemptId, html);
      if (!stored.ok) {
        return failed('store-raw', stored.error.kind);
      }
      const rawArtifactId = stored.value.id;

      if (isAborted()) return cancelled();

      // (e) sanitize
      stage = 'sanitize';
      const sanitized = await this.pipeline.sanitize(webContentsId, attemptId, rawArtifactId);
      if (!sanitized.ok) {
        return failed('sanitize', sanitized.error.kind);
      }
      const sanitizedArtifactId = sanitized.value.artifact.id;

      if (isAborted()) return cancelled();

      // (f) resolve
      stage = 'resolve';
      const resolved = await this.pipeline.resolve(webContentsId, attemptId, sanitizedArtifactId);
      if (!resolved.ok) {
        return failed('resolve', resolved.error.kind);
      }
      const resolvedArtifactId = resolved.value.artifact.id;

      if (isAborted()) return cancelled();

      // (h) optional quarantine
      if (this.quarantine) {
        stage = 'quarantine';
        const measured = await this.quarantine({
          webContentsId,
          attemptId,
          resolvedArtifactId,
          signal: signal ?? new AbortController().signal,
        });

        if (isAborted()) return cancelled();

        if (!measured.ok) {
          if (measured.kind === 'recoverable-failure') {
            // Artifact resolved but could not be behaviorally proven.
            return {
              state: 'partial',
              attemptId,
              resolvedArtifactId,
              quarantineKind: measured.kind,
              route: route!,
              callCount,
            };
          }
          return failed('quarantine', measured.kind);
        }
      }

      if (isAborted()) return cancelled();

      // (i) finalize
      stage = 'finalize';
      const finalized = this.pipeline.finalize(webContentsId, attemptId, resolvedArtifactId);
      if (!finalized.ok) {
        return failed('finalize', finalized.error.kind);
      }

      return {
        state: 'final',
        attemptId,
        finalizedArtifactId: finalized.value.artifact.id,
        resolvedArtifactId,
        sanitizedArtifactId,
        route: route!,
        callCount,
      };
    } catch {
      // Unexpected throw: invalidate best-effort and map to failed(pipeline-reject).
      invalidateBestEffort();
      return failed(stage, 'pipeline-reject');
    }
  }

  /**
   * Frozen generation contract:
   * - call generate once (callCount=1)
   * - zero decoded bytes ONLY may retry once on the SAME route/model (callCount=2)
   * - capped/truncated/!doneSeen are NEVER success and are NOT retried
   * - cooperative cancel between/after each generate
   */
  private async runGeneration(
    attemptId: HtmlExportAttemptId,
    prompt: string,
    signal: AbortSignal | undefined,
  ): Promise<
    | { kind: 'ok'; output: GenerationOutput; callCount: number; route: GenerationRoute }
    | { kind: 'failed'; errorKind: HtmlExportPipelineErrorKind; callCount: number; route?: GenerationRoute }
    | { kind: 'cancelled'; callCount: number; route?: GenerationRoute }
  > {
    const abortSignal = signal ?? new AbortController().signal;
    let callCount = 0;
    let lastRoute: GenerationRoute | undefined;

    const invoke = async (): Promise<
      | { kind: 'output'; output: GenerationOutput }
      | { kind: 'throw' }
      | { kind: 'cancelled' }
    > => {
      if (abortSignal.aborted) return { kind: 'cancelled' };
      callCount += 1;
      try {
        const output = await this.generate({ attemptId, prompt, signal: abortSignal });
        lastRoute = sanitizeRoute(output.route);
        return { kind: 'output', output };
      } catch {
        return { kind: 'throw' };
      }
    };

    const first = await invoke();
    if (first.kind === 'cancelled') {
      return { kind: 'cancelled', callCount, route: lastRoute };
    }
    if (first.kind === 'throw') {
      return { kind: 'failed', errorKind: 'pipeline-reject', callCount, route: lastRoute };
    }
    if (abortSignal.aborted) {
      return { kind: 'cancelled', callCount, route: lastRoute };
    }

    // Hard-failure metadata is NEVER a success and is NEVER retried — check this
    // BEFORE the zero-byte retry so a zero-byte + capped/truncated/!doneSeen output
    // fails immediately instead of being retried.
    const firstRoute = sanitizeRoute(first.output.route);
    const firstRejected = rejectNonSuccess(first.output);
    if (firstRejected) {
      return { kind: 'failed', errorKind: firstRejected, callCount, route: firstRoute };
    }

    // Clean zero decoded bytes ONLY may retry once, and only on the SAME route/model.
    if (first.output.decodedBytes === 0) {
      const second = await invoke();
      if (second.kind === 'cancelled') {
        return { kind: 'cancelled', callCount, route: lastRoute };
      }
      if (second.kind === 'throw') {
        return { kind: 'failed', errorKind: 'pipeline-reject', callCount, route: firstRoute };
      }
      if (abortSignal.aborted) {
        return { kind: 'cancelled', callCount, route: lastRoute };
      }
      const secondRoute = sanitizeRoute(second.output.route);
      if (!sameRoute(firstRoute, secondRoute)) {
        // The transport violated the same-route retry pin.
        return { kind: 'failed', errorKind: 'pipeline-reject', callCount, route: firstRoute };
      }
      const secondRejected = rejectNonSuccess(second.output);
      if (secondRejected) {
        return { kind: 'failed', errorKind: secondRejected, callCount, route: secondRoute };
      }
      if (second.output.decodedBytes === 0) {
        return { kind: 'failed', errorKind: 'pipeline-reject', callCount, route: secondRoute };
      }
      return { kind: 'ok', output: second.output, callCount, route: secondRoute };
    }

    return { kind: 'ok', output: first.output, callCount, route: firstRoute };
  }
}

/**
 * Non-zero outputs that are still hard failures (never retried).
 * capped/truncated -> pipeline-oversize; !doneSeen -> pipeline-reject.
 */
function rejectNonSuccess(output: GenerationOutput): HtmlExportPipelineErrorKind | undefined {
  if (output.capped || output.truncated) return 'pipeline-oversize';
  if (!output.doneSeen) return 'pipeline-reject';
  return undefined;
}

/**
 * Reduce a transport-supplied route to exactly the renderer-safe fields.
 * Any extra field (secrets, paths, byte dumps) is dropped — never passed through.
 */
function sanitizeRoute(raw: GenerationRoute): GenerationRoute {
  return {
    provider: String(raw?.provider ?? ''),
    model: String(raw?.model ?? ''),
    transport: raw?.transport === 'api' ? 'api' : 'cli',
  };
}

/** Whether two routes name the same provider/model/transport (zero-byte retry pin). */
function sameRoute(a: GenerationRoute, b: GenerationRoute): boolean {
  return a.provider === b.provider && a.model === b.model && a.transport === b.transport;
}
