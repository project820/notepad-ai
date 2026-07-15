import { createHash, randomUUID } from 'node:crypto';

import {
  createHtmlExportPipelineError,
  HTML_EXPORT_RAW_ARTIFACT_MAX_BYTES,
  HTML_EXPORT_STAGE_ARTIFACT_MAX_BYTES,
  type CancelAttemptResult,
  type HtmlExportArtifactId,
  type HtmlExportArtifactRef,
  type HtmlExportAttemptId,
  type HtmlExportPipelineErrorKind,
  type HtmlExportPipelineResult,
  type HtmlExportStage,
} from '../shared/html-export-pipeline';

export type HtmlExportUuidFactory = () => string;

type AttemptStatus = 'active' | 'invalidated' | 'superseded';

type AttemptRecord = {
  webContentsId: number;
  status: AttemptStatus;
  artifacts: Partial<Record<HtmlExportStage, HtmlExportArtifactId>>;
};

type ArtifactRecord = {
  ref: HtmlExportArtifactRef;
  webContentsId: number;
  bytes?: Buffer;
};

const transitionSources: Record<HtmlExportStage, HtmlExportStage | null> = {
  raw: null,
  sanitized: 'raw',
  resolved: 'sanitized',
  finalized: 'resolved',
};

const EXPIRED_ATTEMPT_TOMBSTONE_CAP = 64;

function success<T>(value: T): HtmlExportPipelineResult<T> {
  return { ok: true, value };
}

function failure<T>(kind: HtmlExportPipelineErrorKind): HtmlExportPipelineResult<T> {
  return { ok: false, error: createHtmlExportPipelineError(kind) };
}

function copyRef<Stage extends HtmlExportStage>(ref: HtmlExportArtifactRef<Stage>): HtmlExportArtifactRef<Stage> {
  return { ...ref };
}

/**
 * Main-process authority for an HTML export attempt. The renderer receives only
 * copied metadata and opaque IDs; artifact bytes never leave this registry.
 */
export class HtmlExportAttemptRegistry {
  private readonly attempts = new Map<HtmlExportAttemptId, AttemptRecord>();
  private readonly artifacts = new Map<HtmlExportArtifactId, ArtifactRecord>();
  private readonly activeAttempts = new Map<number, HtmlExportAttemptId>();
  private readonly expiredAttemptIds: HtmlExportAttemptId[] = [];
  private readonly uuidFactory: HtmlExportUuidFactory;

  constructor({ uuidFactory = randomUUID }: { uuidFactory?: HtmlExportUuidFactory } = {}) {
    this.uuidFactory = uuidFactory;
  }

  beginAttempt(webContentsId: number): HtmlExportPipelineResult<{ attemptId: HtmlExportAttemptId }> {
    const attemptId = this.nextAttemptId();
    const priorAttemptId = this.activeAttempts.get(webContentsId);
    if (priorAttemptId) {
      this.expireAttempt(priorAttemptId, 'superseded');
    }

    this.attempts.set(attemptId, { webContentsId, status: 'active', artifacts: {} });
    this.activeAttempts.set(webContentsId, attemptId);
    return success({ attemptId });
  }

  storeRaw(
    webContentsId: number,
    attemptId: HtmlExportAttemptId,
    bytes: Uint8Array,
  ): HtmlExportPipelineResult<HtmlExportArtifactRef<'raw'>> {
    const attempt = this.validateAttempt(webContentsId, attemptId);
    if (!attempt.ok) {
      return attempt;
    }

    if (attempt.value.artifacts.raw) return failure('pipeline-reject');
    if (bytes.byteLength > HTML_EXPORT_RAW_ARTIFACT_MAX_BYTES) return failure('pipeline-oversize');
    return success(this.storeArtifact(webContentsId, attemptId, 'raw', bytes));
  }

  transition<TargetStage extends Exclude<HtmlExportStage, 'raw'>>(
    webContentsId: number,
    attemptId: HtmlExportAttemptId,
    priorId: HtmlExportArtifactId,
    targetStage: TargetStage,
    bytes: Uint8Array,
  ): HtmlExportPipelineResult<HtmlExportArtifactRef<TargetStage>> {
    const artifact = this.validateArtifact(webContentsId, attemptId, priorId);
    if (!artifact.ok) {
      return artifact;
    }

    if (
      transitionSources[targetStage] !== artifact.value.ref.stage
      || this.attempts.get(attemptId)?.artifacts[targetStage] !== undefined
    ) {
      return failure('pipeline-reject');
    }

    if (bytes.byteLength > HTML_EXPORT_STAGE_ARTIFACT_MAX_BYTES) return failure('pipeline-oversize');

    return success(this.storeArtifact(webContentsId, attemptId, targetStage, bytes));
  }

  read(
    webContentsId: number,
    attemptId: HtmlExportAttemptId,
    artifactId: HtmlExportArtifactId,
  ): HtmlExportPipelineResult<{ ref: HtmlExportArtifactRef; bytes: Buffer }>;
  read<Stage extends HtmlExportStage>(
    webContentsId: number,
    attemptId: HtmlExportAttemptId,
    artifactId: HtmlExportArtifactId<Stage>,
    expectedStage: Stage,
  ): HtmlExportPipelineResult<{ ref: HtmlExportArtifactRef<Stage>; bytes: Buffer }>;
  read<Stage extends HtmlExportStage>(
    webContentsId: number,
    attemptId: HtmlExportAttemptId,
    artifactId: HtmlExportArtifactId,
    expectedStage?: Stage,
  ): HtmlExportPipelineResult<{ ref: HtmlExportArtifactRef<Stage>; bytes: Buffer }> {
    const artifact = this.validateArtifact(webContentsId, attemptId, artifactId);
    if (!artifact.ok) {
      return artifact;
    }

    if (expectedStage !== undefined && artifact.value.ref.stage !== expectedStage) {
      return failure('pipeline-reject');
    }

    const bytes = artifact.value.bytes;
    if (!bytes) return failure('stale-artifact');

    return success({
      ref: copyRef(artifact.value.ref as HtmlExportArtifactRef<Stage>),
      bytes: Buffer.from(bytes),
    });
  }

  invalidateAttempt(
    webContentsId: number,
    attemptId: HtmlExportAttemptId,
  ): CancelAttemptResult {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) return failure('stale-artifact');
    if (attempt.webContentsId !== webContentsId) return failure('wrong-sender');
    if (attempt.status === 'superseded') return failure('attempt-superseded');
    if (attempt.status !== 'active' || this.activeAttempts.get(webContentsId) !== attemptId) {
      return failure('stale-artifact');
    }

    this.activeAttempts.delete(webContentsId);
    this.expireAttempt(attemptId, 'invalidated');
    return success({});
  }

  invalidateSender(webContentsId: number): void {
    const activeAttemptId = this.activeAttempts.get(webContentsId);
    if (activeAttemptId) {
      this.invalidateAttempt(webContentsId, activeAttemptId);
    }
  }

  getActiveAttempt(webContentsId: number): HtmlExportAttemptId | undefined {
    return this.activeAttempts.get(webContentsId);
  }

  private nextAttemptId(): HtmlExportAttemptId {
    const id = this.uuidFactory() as HtmlExportAttemptId;
    if (!id || this.attempts.has(id)) {
      throw new Error('HTML export UUID factory returned a duplicate or empty attempt ID');
    }
    return id;
  }

  private nextArtifactId(): HtmlExportArtifactId {
    const id = this.uuidFactory() as HtmlExportArtifactId;
    if (!id || this.artifacts.has(id)) {
      throw new Error('HTML export UUID factory returned a duplicate or empty artifact ID');
    }
    return id;
  }

  private storeArtifact<Stage extends HtmlExportStage>(
    webContentsId: number,
    attemptId: HtmlExportAttemptId,
    stage: Stage,
    bytes: Uint8Array,
  ): HtmlExportArtifactRef<Stage> {
    const storedBytes = Buffer.from(bytes);
    const ref: HtmlExportArtifactRef<Stage> = {
      id: this.nextArtifactId() as HtmlExportArtifactId<Stage>,
      attemptId,
      stage,
      sha256: createHash('sha256').update(storedBytes).digest('hex'),
      byteLength: storedBytes.byteLength,
    };
    this.artifacts.set(ref.id, { ref, webContentsId, bytes: storedBytes });
    const attempt = this.attempts.get(attemptId);
    if (attempt) attempt.artifacts[stage] = ref.id;
    return copyRef(ref);
  }

  private expireAttempt(attemptId: HtmlExportAttemptId, status: Exclude<AttemptStatus, 'active'>): void {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.status !== 'active') return;

    attempt.status = status;
    for (const artifactId of Object.values(attempt.artifacts)) {
      const artifact = artifactId && this.artifacts.get(artifactId);
      if (artifact) artifact.bytes = undefined;
    }
    this.expiredAttemptIds.push(attemptId);

    while (this.expiredAttemptIds.length > EXPIRED_ATTEMPT_TOMBSTONE_CAP) {
      const expiredAttemptId = this.expiredAttemptIds.shift();
      if (!expiredAttemptId) continue;
      const expiredAttempt = this.attempts.get(expiredAttemptId);
      if (!expiredAttempt || expiredAttempt.status === 'active') continue;
      this.attempts.delete(expiredAttemptId);
      for (const artifactId of Object.values(expiredAttempt.artifacts)) {
        if (artifactId) this.artifacts.delete(artifactId);
      }
    }
  }

  private validateAttempt(
    webContentsId: number,
    attemptId: HtmlExportAttemptId,
  ): HtmlExportPipelineResult<AttemptRecord> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) {
      return failure('stale-artifact');
    }
    if (attempt.webContentsId !== webContentsId) {
      return failure('wrong-sender');
    }
    if (attempt.status === 'superseded') {
      return failure('attempt-superseded');
    }
    if (attempt.status !== 'active' || this.activeAttempts.get(webContentsId) !== attemptId) {
      return failure('stale-artifact');
    }
    return success(attempt);
  }

  private validateArtifact(
    webContentsId: number,
    attemptId: HtmlExportAttemptId,
    artifactId: HtmlExportArtifactId,
  ): HtmlExportPipelineResult<ArtifactRecord> {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact) {
      return failure('unknown-artifact');
    }
    if (artifact.webContentsId !== webContentsId) {
      return failure('wrong-sender');
    }
    if (artifact.ref.attemptId !== attemptId) {
      return failure('stale-artifact');
    }

    const attempt = this.validateAttempt(webContentsId, attemptId);
    if (!attempt.ok) {
      return attempt;
    }
    return success(artifact);
  }
}
