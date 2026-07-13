/**
 * Renderer-safe protocol for the additive HTML export pipeline.
 * Artifact bytes remain main-process-only; renderer requests carry opaque IDs.
 */

export type HtmlExportStage = 'raw' | 'sanitized' | 'resolved' | 'finalized';

export const HTML_EXPORT_RAW_ARTIFACT_MAX_BYTES = 8 * 1024 * 1024;
export const HTML_EXPORT_STAGE_ARTIFACT_MAX_BYTES = 10 * 1024 * 1024;

export type HtmlExportPipelineErrorKind =
  | 'unknown-artifact'
  | 'stale-artifact'
  | 'wrong-sender'
  | 'attempt-superseded'
  | 'pipeline-oversize'
  | 'pipeline-reject';

export type HtmlExportPipelineError = {
  kind: HtmlExportPipelineErrorKind;
  detail: string;
};

export function createHtmlExportPipelineError(
  kind: HtmlExportPipelineErrorKind,
  detail = `HTML export pipeline error: ${kind}`,
): HtmlExportPipelineError {
  return { kind, detail };
}

export type HtmlExportPipelineResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: HtmlExportPipelineError };

declare const htmlExportArtifactStage: unique symbol;
declare const htmlExportAttempt: unique symbol;

/** Opaque, renderer-safe artifact ID. It is only meaningful to the main registry. */
export type HtmlExportArtifactId<Stage extends HtmlExportStage = HtmlExportStage> = string & {
  readonly [htmlExportArtifactStage]: Stage;
};

/** Opaque attempt ID scoped to the webContents that began it. */
export type HtmlExportAttemptId = string & {
  readonly [htmlExportAttempt]: true;
};
/**
 * Returns whether an untrusted value is a bounded, renderer-safe opaque pipeline ID.
 */
export function isOpaqueHtmlExportId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export type RawArtifactId = HtmlExportArtifactId<'raw'>;
export type SanitizedArtifactId = HtmlExportArtifactId<'sanitized'>;
export type ResolvedArtifactId = HtmlExportArtifactId<'resolved'>;
/**
 * Reserved for the main-owned S4 finalization gate. S1b deliberately exposes no
 * renderer finalization request; only the registry can represent this stage.
 */
export type FinalizedArtifactId = HtmlExportArtifactId<'finalized'>;

export type HtmlExportArtifactRef<Stage extends HtmlExportStage = HtmlExportStage> = {
  id: HtmlExportArtifactId<Stage>;
  attemptId: HtmlExportAttemptId;
  stage: Stage;
  sha256: string;
  byteLength: number;
};

export type BeginAttemptRequest = Record<string, never>;
export type BeginAttemptResult = HtmlExportPipelineResult<{ attemptId: HtmlExportAttemptId }>;

export type SanitizeRequest = {
  attemptId: HtmlExportAttemptId;
  rawArtifactId: RawArtifactId;
};
export type SanitizeResult = HtmlExportPipelineResult<{
  artifact: HtmlExportArtifactRef<'sanitized'>;
}>;

export type ResolveRequest = {
  attemptId: HtmlExportAttemptId;
  sanitizedCandidateId: SanitizedArtifactId;
};
export type ResolveResult = HtmlExportPipelineResult<{
  artifact: HtmlExportArtifactRef<'resolved'>;
}>;

export type CancelAttemptRequest = {
  attemptId: HtmlExportAttemptId;
};
export type CancelAttemptResult = HtmlExportPipelineResult<Record<string, never>>;

export type HtmlExportPipelineApi = {
  beginHtmlExportAttempt: (request: BeginAttemptRequest) => Promise<BeginAttemptResult>;
  sanitizeHtmlExport: (request: SanitizeRequest) => Promise<SanitizeResult>;
  resolveHtmlExport: (request: ResolveRequest) => Promise<ResolveResult>;
  cancelHtmlExportAttempt: (request: CancelAttemptRequest) => Promise<CancelAttemptResult>;
};
