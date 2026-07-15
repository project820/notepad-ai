import { createHash } from 'node:crypto';

import {
  createHtmlExportPipelineError,
  HTML_EXPORT_RAW_ARTIFACT_MAX_BYTES,
  HTML_EXPORT_STAGE_ARTIFACT_MAX_BYTES,
  type CancelAttemptResult,
  type HtmlExportArtifactRef,
  type HtmlExportAttemptId,
  type HtmlExportPipelineResult,
  type RawArtifactId,
  type SanitizedArtifactId,
  type ResolveResult,
  type SanitizeResult,
  type ResolvedArtifactId,
  type FinalizedArtifactId,
} from '../shared/html-export-pipeline';
import { HtmlExportAttemptRegistry } from './html-export-attempt-registry';
import { HtmlExportParseHost, type HtmlExportParseValue } from './html-export-parse-host';
import { HTML_SANITIZER_LIMITS, sanitizeHtmlExport } from './html-export-sanitize';

export const HTML_EXPORT_RAW_MODEL_OUTPUT_MAX_BYTES = HTML_EXPORT_RAW_ARTIFACT_MAX_BYTES;
export const HTML_EXPORT_PIPELINE_STAGE_MAX_BYTES = HTML_EXPORT_STAGE_ARTIFACT_MAX_BYTES;

type HtmlExportCounts = {
  nodeCount: number;
  maxDepth: number;
  attributeCount: number;
};

export type HtmlExportSanitizedPayload = {
  bodyHtml: string;
  documentHtml: string;
  contentCss: string;
  counts: HtmlExportCounts;
  /** Safe class tokens from source <html>/<body> for the shell content-root wrapper. */
  contentRootClass?: string;
  /** Safe id from source <body> (else <html>) for the shell content-root wrapper. */
  contentRootId?: string;
  /**
   * Safe inert root attributes (lang/dir/title/role) from source <html>/<body>
   * for the shell content-root wrapper. Body wins over html on conflict.
   */
  contentRootAttrs?: Record<string, string>;
};

export type HtmlExportResolver = (sanitizedPayload: HtmlExportSanitizedPayload) => Promise<string | Uint8Array>;

type HtmlExportPipelineDiagnostic = {
  boundary: 'parse-host' | 'resolver';
  causeName: string;
  causeMessage: string;
};

const HTML_EXPORT_PIPELINE_DIAGNOSTIC_CAP = 16;

type Registry = Pick<
  HtmlExportAttemptRegistry,
  'beginAttempt' | 'storeRaw' | 'transition' | 'read' | 'invalidateAttempt' | 'invalidateSender'
>;
type ParseHost = Pick<HtmlExportParseHost, 'parse'>;

export type HtmlExportPipelineServiceOptions = {
  registry?: Registry;
  parseHost?: ParseHost;
  resolver?: HtmlExportResolver;
};

function reject<T>(message: string): HtmlExportPipelineResult<T> {
  return { ok: false, error: createHtmlExportPipelineError('pipeline-reject', message) };
}

function oversize<T>(message: string): HtmlExportPipelineResult<T> {
  return { ok: false, error: createHtmlExportPipelineError('pipeline-oversize', message) };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sameCounts(left: HtmlExportCounts, right: HtmlExportCounts): boolean {
  return left.nodeCount === right.nodeCount
    && left.maxDepth === right.maxDepth
    && left.attributeCount === right.attributeCount;
}

function isCounts(value: unknown): value is HtmlExportCounts {
  if (typeof value !== 'object' || value === null) return false;
  const { nodeCount, maxDepth, attributeCount } = value as Partial<HtmlExportCounts>;
  return typeof nodeCount === 'number'
    && Number.isInteger(nodeCount)
    && nodeCount >= 1
    && nodeCount <= HTML_SANITIZER_LIMITS.maxNodes
    && typeof maxDepth === 'number'
    && Number.isInteger(maxDepth)
    && maxDepth >= 0
    && maxDepth <= HTML_SANITIZER_LIMITS.maxDepth
    && typeof attributeCount === 'number'
    && Number.isInteger(attributeCount)
    && attributeCount >= 0
    && attributeCount <= HTML_SANITIZER_LIMITS.maxAttributes;
}

function isPlainStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  // Fail-closed: every own enumerable value must be a string (keys are always strings).
  for (const [key, entry] of Object.entries(value)) {
    if (typeof key !== 'string' || typeof entry !== 'string') return false;
  }
  return true;
}

function isSanitizedPayload(value: unknown): value is HtmlExportSanitizedPayload {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as Partial<HtmlExportSanitizedPayload>;
  // contentRootClass/Id/Attrs are optional shape fields only — the sanitizer remains
  // the reserved-value gate. Reject non-string when present (fail-closed).
  const optionalRootString = (field: unknown): boolean =>
    field === undefined || typeof field === 'string';
  const optionalRootAttrs = (field: unknown): boolean =>
    field === undefined || isPlainStringRecord(field);
  return typeof payload.bodyHtml === 'string'
    && typeof payload.documentHtml === 'string'
    && typeof payload.contentCss === 'string'
    && isCounts(payload.counts)
    && optionalRootString(payload.contentRootClass)
    && optionalRootString(payload.contentRootId)
    && optionalRootAttrs(payload.contentRootAttrs);
}

/**
 * Main-process-only owner of the raw HTML export pipeline. Renderer-facing IPC
 * submits opaque artifact IDs; it never passes model or sanitized bytes here.
 */
export class HtmlExportPipelineService {
  private readonly registry: Registry;
  private readonly parseHost: ParseHost;
  private readonly resolver?: HtmlExportResolver;
  private readonly diagnostics: HtmlExportPipelineDiagnostic[] = [];

  constructor(options: HtmlExportPipelineServiceOptions = {}) {
    this.registry = options.registry ?? new HtmlExportAttemptRegistry();
    this.parseHost = options.parseHost ?? new HtmlExportParseHost();
    this.resolver = options.resolver;
  }

  beginAttempt(webContentsId: number): HtmlExportPipelineResult<{ attemptId: HtmlExportAttemptId }> {
    return this.registry.beginAttempt(webContentsId);
  }

  getDiagnostics(): readonly HtmlExportPipelineDiagnostic[] {
    return this.diagnostics.map((diagnostic) => ({ ...diagnostic }));
  }

  /**
   * The sole raw-byte ingress, reserved for a future main-process model transport.
   * It is deliberately not part of the renderer IPC surface. Finalized artifacts
   * likewise remain registry-reserved until the separate S4 main finalizer lands.
   */
  storeRawModelOutput(
    webContentsId: number,
    attemptId: HtmlExportAttemptId,
    html: string,
  ): HtmlExportPipelineResult<HtmlExportArtifactRef<'raw'>> {
    if (typeof html !== 'string') return reject('Raw HTML must be a string');
    if (Buffer.byteLength(html, 'utf8') > HTML_EXPORT_RAW_MODEL_OUTPUT_MAX_BYTES) {
      return oversize(`Raw HTML exceeds ${HTML_EXPORT_RAW_MODEL_OUTPUT_MAX_BYTES} bytes`);
    }
    return this.registry.storeRaw(webContentsId, attemptId, Buffer.from(html, 'utf8'));
  }

  async sanitize(
    webContentsId: number,
    attemptId: HtmlExportAttemptId,
    rawArtifactId: RawArtifactId,
  ): Promise<SanitizeResult> {
    const raw = this.registry.read(webContentsId, attemptId, rawArtifactId, 'raw');
    if (!raw.ok) return raw;
    if (!this.hasExpectedDigest(raw.value.ref, raw.value.bytes)) {
      return reject('Raw artifact digest or byte length does not match its registry metadata');
    }
    if (raw.value.bytes.byteLength > HTML_EXPORT_RAW_MODEL_OUTPUT_MAX_BYTES) {
      return oversize(`Raw HTML exceeds ${HTML_EXPORT_RAW_MODEL_OUTPUT_MAX_BYTES} bytes`);
    }

    let html: string;
    try {
      html = new TextDecoder('utf-8', { fatal: true }).decode(raw.value.bytes);
    } catch {
      return reject('Raw artifact is not valid UTF-8');
    }

    let parsed: HtmlExportPipelineResult<HtmlExportParseValue>;
    try {
      parsed = await this.parseHost.parse(html);
    } catch (error) {
      this.recordDiagnostic('parse-host', error);
      return reject('HTML parse worker failed');
    }
    if (!parsed.ok) return parsed;

    const sanitized = sanitizeHtmlExport({
      html,
      parse: () => parsed.value.document,
      // Fail-closed (#27): a non-HTML answer (model narration) must be rejected here,
      // never sanitized→finalized→saved as an export.
      requireStructuralDocument: true,
    });
    if (!sanitized.ok) return reject('HTML sanitizer rejected model output');
    if (!sameCounts(sanitized.counts, parsed.value.counts)) {
      return reject('HTML sanitizer counts do not match parse worker counts');
    }

    const payload: HtmlExportSanitizedPayload = {
      bodyHtml: sanitized.bodyHtml,
      documentHtml: sanitized.documentHtml,
      contentCss: sanitized.contentCss,
      counts: sanitized.counts,
      ...(sanitized.contentRootClass ? { contentRootClass: sanitized.contentRootClass } : {}),
      ...(sanitized.contentRootId ? { contentRootId: sanitized.contentRootId } : {}),
      ...(sanitized.contentRootAttrs && Object.keys(sanitized.contentRootAttrs).length > 0
        ? { contentRootAttrs: sanitized.contentRootAttrs }
        : {}),
    };
    const serializedPayload = JSON.stringify(payload);
    if (Buffer.byteLength(serializedPayload, 'utf8') > HTML_EXPORT_PIPELINE_STAGE_MAX_BYTES) {
      return oversize(`Pipeline payload exceeds ${HTML_EXPORT_PIPELINE_STAGE_MAX_BYTES} bytes`);
    }
    const verified = this.verifyCandidate(Buffer.from(serializedPayload, 'utf8'), HTML_EXPORT_PIPELINE_STAGE_MAX_BYTES);
    if (!verified.ok) return verified;

    const transitioned = this.registry.transition(webContentsId, attemptId, rawArtifactId, 'sanitized', verified.value.bytes);
    if (!transitioned.ok) return transitioned;
    const checked = this.verifyTransition(transitioned.value, verified.value);
    return checked.ok ? { ok: true, value: { artifact: checked.value } } : checked;
  }

  async resolve(
    webContentsId: number,
    attemptId: HtmlExportAttemptId,
    sanitizedCandidateId: SanitizedArtifactId,
  ): Promise<ResolveResult> {
    const sanitized = this.registry.read(webContentsId, attemptId, sanitizedCandidateId, 'sanitized');
    if (!sanitized.ok) return sanitized;
    if (!this.hasExpectedDigest(sanitized.value.ref, sanitized.value.bytes)) {
      return reject('Sanitized artifact digest or byte length does not match its registry metadata');
    }
    if (sanitized.value.bytes.byteLength > HTML_EXPORT_PIPELINE_STAGE_MAX_BYTES) {
      return oversize(`Sanitized payload exceeds ${HTML_EXPORT_PIPELINE_STAGE_MAX_BYTES} bytes`);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(sanitized.value.bytes));
    } catch {
      return reject('Sanitized payload is not valid UTF-8 JSON');
    }
    if (!isSanitizedPayload(payload)) return reject('Sanitized payload has an invalid shape');
    if (!this.resolver) return reject('No HTML export resolver is installed');

    let resolved: string | Uint8Array;
    try {
      resolved = await this.resolver(payload);
    } catch (error) {
      this.recordDiagnostic('resolver', error);
      return reject('HTML export resolver rejected sanitized payload');
    }
    if (typeof resolved !== 'string' && !(resolved instanceof Uint8Array)) {
      return reject('HTML export resolver returned an invalid payload');
    }
    const byteLength = typeof resolved === 'string'
      ? Buffer.byteLength(resolved, 'utf8')
      : resolved.byteLength;
    if (byteLength > HTML_EXPORT_PIPELINE_STAGE_MAX_BYTES) {
      return oversize(`Pipeline payload exceeds ${HTML_EXPORT_PIPELINE_STAGE_MAX_BYTES} bytes`);
    }
    const bytes = typeof resolved === 'string' ? Buffer.from(resolved, 'utf8') : Buffer.from(resolved);
    const verified = this.verifyCandidate(bytes, HTML_EXPORT_PIPELINE_STAGE_MAX_BYTES);
    if (!verified.ok) return verified;

    const transitioned = this.registry.transition(webContentsId, attemptId, sanitizedCandidateId, 'resolved', verified.value.bytes);
    if (!transitioned.ok) return transitioned;
    const checked = this.verifyTransition(transitioned.value, verified.value);
    return checked.ok ? { ok: true, value: { artifact: checked.value } } : checked;
  }

  /**
   * Quarantine-PASS finalization: store the exact resolved bytes as a
   * FinalizedArtifactId. Measure-only pool never finalizes; only this service
   * (invoked from IPC after PASS) may transition resolved -> finalized.
   */
  finalize(
    webContentsId: number,
    attemptId: HtmlExportAttemptId,
    resolvedArtifactId: ResolvedArtifactId,
  ): HtmlExportPipelineResult<{ artifact: HtmlExportArtifactRef<'finalized'> }> {
    const resolved = this.registry.read(webContentsId, attemptId, resolvedArtifactId, 'resolved');
    if (!resolved.ok) return resolved;
    if (!this.hasExpectedDigest(resolved.value.ref, resolved.value.bytes)) {
      return reject('Resolved artifact digest or byte length does not match its registry metadata');
    }
    if (resolved.value.bytes.byteLength > HTML_EXPORT_PIPELINE_STAGE_MAX_BYTES) {
      return oversize(`Resolved payload exceeds ${HTML_EXPORT_PIPELINE_STAGE_MAX_BYTES} bytes`);
    }

    const verified = this.verifyCandidate(
      Buffer.from(resolved.value.bytes),
      HTML_EXPORT_PIPELINE_STAGE_MAX_BYTES,
    );
    if (!verified.ok) return verified;

    const transitioned = this.registry.transition(
      webContentsId,
      attemptId,
      resolvedArtifactId,
      'finalized',
      verified.value.bytes,
    );
    if (!transitioned.ok) return transitioned;
    const checked = this.verifyTransition(transitioned.value, verified.value);
    return checked.ok ? { ok: true, value: { artifact: checked.value } } : checked;
  }

  /**
   * Read the immutable finalized bytes for a `FinalizedArtifactId` so the save
   * IPC (PR-M1d) can atomicWrite them. Re-verifies the registry digest and the
   * whole-document byte cap (defense-in-depth); the renderer never supplies
   * these bytes. Returns the digest so the caller can assert preview == save.
   */
  readFinalizedArtifact(
    webContentsId: number,
    attemptId: HtmlExportAttemptId,
    finalizedArtifactId: FinalizedArtifactId,
  ): HtmlExportPipelineResult<{ bytes: Buffer; sha256: string; byteLength: number }> {
    const finalized = this.registry.read(webContentsId, attemptId, finalizedArtifactId, 'finalized');
    if (!finalized.ok) return finalized;
    if (!this.hasExpectedDigest(finalized.value.ref, finalized.value.bytes)) {
      return reject('Finalized artifact digest or byte length does not match its registry metadata');
    }
    if (finalized.value.bytes.byteLength > HTML_EXPORT_PIPELINE_STAGE_MAX_BYTES) {
      return oversize(`Finalized payload exceeds ${HTML_EXPORT_PIPELINE_STAGE_MAX_BYTES} bytes`);
    }
    return {
      ok: true,
      value: {
        bytes: finalized.value.bytes,
        sha256: finalized.value.ref.sha256,
        byteLength: finalized.value.ref.byteLength,
      },
    };
  }

  invalidateAttempt(
    webContentsId: number,
    attemptId: HtmlExportAttemptId,
  ): CancelAttemptResult {
    return this.registry.invalidateAttempt(webContentsId, attemptId);
  }

  invalidateSender(webContentsId: number): void {
    this.registry.invalidateSender(webContentsId);
  }

  private recordDiagnostic(boundary: HtmlExportPipelineDiagnostic['boundary'], cause: unknown): void {
    let causeName = 'unknown';
    let causeMessage = 'Unavailable pipeline dependency failure';
    try {
      if (cause instanceof Error) {
        causeName = typeof cause.name === 'string' ? cause.name.slice(0, 64) : 'Error';
        causeMessage = typeof cause.message === 'string'
          ? cause.message.slice(0, 512)
          : 'Unavailable Error message';
      } else {
        causeName = typeof cause;
        causeMessage = typeof cause === 'string'
          ? cause.slice(0, 512)
          : 'Non-Error pipeline dependency failure';
      }
    } catch {
      // Hostile thrown values must not escape the dependency catch path.
    }
    this.diagnostics.push({ boundary, causeName, causeMessage });
    if (this.diagnostics.length > HTML_EXPORT_PIPELINE_DIAGNOSTIC_CAP) this.diagnostics.shift();
  }

  private hasExpectedDigest(ref: HtmlExportArtifactRef, bytes: Uint8Array): boolean {
    return ref.byteLength === bytes.byteLength && ref.sha256 === sha256(bytes);
  }

  private verifyCandidate(
    bytes: Buffer,
    maxBytes: number,
  ): HtmlExportPipelineResult<{ bytes: Buffer; sha256: string }> {
    if (bytes.byteLength > maxBytes) return oversize(`Pipeline payload exceeds ${maxBytes} bytes`);
    return { ok: true, value: { bytes, sha256: sha256(bytes) } };
  }

  private verifyTransition<Stage extends 'sanitized' | 'resolved' | 'finalized'>(
    ref: HtmlExportArtifactRef<Stage>,
    candidate: { bytes: Buffer; sha256: string },
  ): HtmlExportPipelineResult<HtmlExportArtifactRef<Stage>> {
    if (ref.byteLength !== candidate.bytes.byteLength || ref.sha256 !== candidate.sha256) {
      return reject('Registry transition returned mismatched artifact metadata');
    }
    return { ok: true, value: ref };
  }
}
