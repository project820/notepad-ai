import { createHash } from 'node:crypto';
import { parse, type DefaultTreeAdapterTypes } from 'parse5';
import { describe, expect, it } from 'vitest';

import {
  createHtmlExportPipelineError,
  type HtmlExportArtifactId,
  type HtmlExportArtifactRef,
  type HtmlExportAttemptId,
  type HtmlExportPipelineErrorKind,
  type HtmlExportPipelineResult,
  type HtmlExportStage,
  type ResolvedArtifactId,
  type FinalizedArtifactId,
} from '../shared/html-export-pipeline';
import {
  HTML_EXPORT_PIPELINE_STAGE_MAX_BYTES,
  HtmlExportPipelineService,
  type HtmlExportPipelineServiceOptions,
  type HtmlExportSanitizedPayload,
} from '../main/html-export-pipeline-service';
import { sanitizeHtmlExport } from '../main/html-export-sanitize';
import type { HtmlExportParseValue } from '../main/html-export-parse-host';

type Artifact = {
  ref: HtmlExportArtifactRef;
  webContentsId: number;
  bytes: Buffer;
};

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function success<T>(value: T): HtmlExportPipelineResult<T> {
  return { ok: true, value };
}

function failure<T>(kind: HtmlExportPipelineErrorKind): HtmlExportPipelineResult<T> {
  return { ok: false, error: createHtmlExportPipelineError(kind) };
}

function valueOf<T>(result: HtmlExportPipelineResult<T>): T {
  if (!result.ok) throw new Error(`expected ok result, got ${result.error.kind}`);
  return result.value;
}

/** In-memory main-registry fake: bytes remain private to the test fake. */
class FakeRegistry {
  private nextId = 1;
  private readonly activeAttempts = new Map<number, HtmlExportAttemptId>();
  private readonly attempts = new Map<HtmlExportAttemptId, number>();
  private readonly artifacts = new Map<HtmlExportArtifactId, Artifact>();
  readonly transitions: Array<{ priorId: HtmlExportArtifactId; stage: HtmlExportStage; bytes: Buffer }> = [];

  beginAttempt(webContentsId: number): HtmlExportPipelineResult<{ attemptId: HtmlExportAttemptId }> {
    const attemptId = `attempt-${this.nextId++}` as HtmlExportAttemptId;
    this.attempts.set(attemptId, webContentsId);
    this.activeAttempts.set(webContentsId, attemptId);
    return success({ attemptId });
  }

  storeRaw(
    webContentsId: number,
    attemptId: HtmlExportAttemptId,
    bytes: Uint8Array,
  ): HtmlExportPipelineResult<HtmlExportArtifactRef<'raw'>> {
    const valid = this.validateAttempt(webContentsId, attemptId);
    if (!valid.ok) return valid;
    return success(this.store(webContentsId, attemptId, 'raw', bytes));
  }

  transition<Target extends Exclude<HtmlExportStage, 'raw'>>(
    webContentsId: number,
    attemptId: HtmlExportAttemptId,
    priorId: HtmlExportArtifactId,
    stage: Target,
    bytes: Uint8Array,
  ): HtmlExportPipelineResult<HtmlExportArtifactRef<Target>> {
    const prior = this.read(webContentsId, attemptId, priorId);
    if (!prior.ok) return prior;
    const source: Record<Target, HtmlExportStage> = {
      sanitized: 'raw',
      resolved: 'sanitized',
      finalized: 'resolved',
    } as Record<Target, HtmlExportStage>;
    // Reject double finalize (and any other duplicate-stage transition).
    if (prior.value.ref.stage !== source[stage]) return failure('pipeline-reject');
    // Real registry also rejects if target stage already exists on the attempt.
    for (const artifact of this.artifacts.values()) {
      if (
        artifact.ref.attemptId === attemptId
        && artifact.ref.stage === stage
        && artifact.webContentsId === webContentsId
      ) {
        return failure('pipeline-reject');
      }
    }
    this.transitions.push({ priorId, stage, bytes: Buffer.from(bytes) });
    return success(this.store(webContentsId, attemptId, stage, bytes));
  }

  read<Stage extends HtmlExportStage>(
    webContentsId: number,
    attemptId: HtmlExportAttemptId,
    artifactId: HtmlExportArtifactId,
    expectedStage?: Stage,
  ): HtmlExportPipelineResult<{ ref: HtmlExportArtifactRef<Stage>; bytes: Buffer }> {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact) return failure('unknown-artifact');
    if (artifact.webContentsId !== webContentsId) return failure('wrong-sender');
    if (artifact.ref.attemptId !== attemptId) return failure('stale-artifact');
    const valid = this.validateAttempt(webContentsId, attemptId);
    if (!valid.ok) return valid;
    if (expectedStage && artifact.ref.stage !== expectedStage) return failure('pipeline-reject');
    return success({
      ref: { ...artifact.ref } as HtmlExportArtifactRef<Stage>,
      bytes: Buffer.from(artifact.bytes),
    });
  }

  invalidateAttempt(
    webContentsId: number,
    attemptId: HtmlExportAttemptId,
  ): HtmlExportPipelineResult<Record<string, never>> {
    if (this.attempts.get(attemptId) !== webContentsId) return failure('wrong-sender');
    if (this.activeAttempts.get(webContentsId) !== attemptId) return failure('stale-artifact');
    this.activeAttempts.delete(webContentsId);
    return success({});
  }

  invalidateSender(webContentsId: number): void {
    this.activeAttempts.delete(webContentsId);
  }

  private validateAttempt(
    webContentsId: number,
    attemptId: HtmlExportAttemptId,
  ): HtmlExportPipelineResult<true> {
    if (!this.attempts.has(attemptId) || this.activeAttempts.get(webContentsId) !== attemptId) {
      return failure('stale-artifact');
    }
    if (this.attempts.get(attemptId) !== webContentsId) return failure('wrong-sender');
    return success(true);
  }

  private store<Stage extends HtmlExportStage>(
    webContentsId: number,
    attemptId: HtmlExportAttemptId,
    stage: Stage,
    bytes: Uint8Array,
  ): HtmlExportArtifactRef<Stage> {
    const copy = Buffer.from(bytes);
    const ref: HtmlExportArtifactRef<Stage> = {
      id: `artifact-${this.nextId++}` as HtmlExportArtifactId<Stage>,
      attemptId,
      stage,
      sha256: digest(copy),
      byteLength: copy.byteLength,
    };
    this.artifacts.set(ref.id, { ref, webContentsId, bytes: copy });
    return { ...ref };
  }
}

class FakeParseHost {
  async parse(html: string): Promise<HtmlExportPipelineResult<HtmlExportParseValue>> {
    const document = parse(html);
    const sanitized = sanitizeHtmlExport({ html: '', parse: () => document, isAllowedAssetId: () => false });
    if (!sanitized.ok) {
      return success({
        document,
        counts: { nodeCount: 1, maxDepth: 0, attributeCount: 0 },
      });
    }
    return success({ document, counts: sanitized.counts });
  }
}

function serviceFor(
  registry = new FakeRegistry(),
  resolver: HtmlExportPipelineServiceOptions['resolver'] = async (payload: HtmlExportSanitizedPayload) =>
    `resolved:${payload.bodyHtml}`,
) {
  return {
    registry,
    service: new HtmlExportPipelineService({
      registry: registry as unknown as HtmlExportPipelineServiceOptions['registry'],
      parseHost: new FakeParseHost() as unknown as HtmlExportPipelineServiceOptions['parseHost'],
      resolver,
    }),
  };
}

async function driveToResolved(
  service: HtmlExportPipelineService,
  registry: FakeRegistry,
  webContentsId = 1,
  html = '<p>finalize me</p>',
): Promise<{ attemptId: HtmlExportAttemptId; resolvedId: ResolvedArtifactId; resolvedBytes: Buffer }> {
  const attemptId = valueOf(service.beginAttempt(webContentsId)).attemptId;
  const raw = valueOf(service.storeRawModelOutput(webContentsId, attemptId, html));
  const sanitized = valueOf(await service.sanitize(webContentsId, attemptId, raw.id)).artifact;
  const resolved = valueOf(await service.resolve(webContentsId, attemptId, sanitized.id)).artifact;
  const last = registry.transitions.at(-1);
  if (!last || last.stage !== 'resolved') throw new Error('expected resolved transition');
  return { attemptId, resolvedId: resolved.id, resolvedBytes: last.bytes };
}

describe('HtmlExportPipelineService.finalize', () => {
  it('injects the scroll runtime without slide navigation', async () => {
    const { service, registry } = serviceFor();
    const { attemptId, resolvedId } = await driveToResolved(service, registry);

    const finalized = service.finalize(1, attemptId, resolvedId, 'scroll');

    expect(finalized.ok).toBe(true);
    if (!finalized.ok) return;
    const bytes = registry.transitions.at(-1)?.bytes;
    expect(finalized.value.artifact.stage).toBe('finalized');
    expect(finalized.value.artifact.sha256).toBe(digest(bytes!));
    expect(finalized.value.artifact.byteLength).toBe(bytes!.byteLength);
    expect(bytes?.toString('utf8')).toContain('id="nai-runtime"');
    expect(bytes?.toString('utf8')).toContain('if(false)');
  });
  it('injects slide navigation for slide-mode requests', async () => {
    const { service, registry } = serviceFor();
    const { attemptId, resolvedId } = await driveToResolved(service, registry, 1, '<section class="slide">One</section>');

    const finalized = service.finalize(1, attemptId, resolvedId, 'slide');

    expect(finalized.ok).toBe(true);
    expect(registry.transitions.at(-1)?.bytes.toString('utf8')).toContain('nai-slide-nav');
  });
  it('injects locale-specific labels', async () => {
    const { service, registry } = serviceFor();
    const { attemptId, resolvedId } = await driveToResolved(service, registry, 1, '<section class="slide">One</section>');

    const finalized = service.finalize(1, attemptId, resolvedId, 'slide', 'ko');

    expect(finalized.ok).toBe(true);
    const html = registry.transitions.at(-1)?.bytes.toString('utf8') ?? '';
    expect(html).toContain('어두운 테마로 전환');
  });

  it('returns typed pipeline errors for unknown, wrong-sender, and stale resolved ids', async () => {
    const { service, registry } = serviceFor();
    const { attemptId, resolvedId } = await driveToResolved(service, registry);

    const unknown = service.finalize(1, attemptId, 'artifact-missing' as ResolvedArtifactId);
    expect(unknown.ok ? '' : unknown.error.kind).toBe('unknown-artifact');

    const wrongSender = service.finalize(99, attemptId, resolvedId);
    expect(wrongSender.ok ? '' : wrongSender.error.kind).toBe('wrong-sender');

    // Supersede the attempt so the original becomes stale.
    registry.invalidateAttempt(1, attemptId);
    const stale = service.finalize(1, attemptId, resolvedId);
    expect(stale.ok ? '' : stale.error.kind).toBe('stale-artifact');
  });

  it('rejects a second finalize on the same resolved artifact', async () => {
    const { service, registry } = serviceFor();
    const { attemptId, resolvedId } = await driveToResolved(service, registry);

    const first = service.finalize(1, attemptId, resolvedId);
    expect(first.ok).toBe(true);

    const second = service.finalize(1, attemptId, resolvedId);
    expect(second.ok ? '' : second.error.kind).toBe('pipeline-reject');
    expect(registry.transitions.filter((t) => t.stage === 'finalized')).toHaveLength(1);
  });

  it('rejects finalize when the prior is not a resolved artifact', async () => {
    const { service } = serviceFor();
    const attemptId = valueOf(service.beginAttempt(1)).attemptId;
    const raw = valueOf(service.storeRawModelOutput(1, attemptId, '<p>not resolved</p>'));

    const result = service.finalize(1, attemptId, raw.id as unknown as ResolvedArtifactId);
    expect(result.ok ? '' : result.error.kind).toBe('pipeline-reject');
  });

  it('applies the stage byte cap before transitioning', async () => {
    const oversized = Buffer.alloc(HTML_EXPORT_PIPELINE_STAGE_MAX_BYTES + 1, 0x61);
    const registry = new FakeRegistry();
    // Bypass resolve and plant an oversized "resolved" artifact directly.
    const attemptId = valueOf(registry.beginAttempt(1)).attemptId;
    const raw = valueOf(registry.storeRaw(1, attemptId, Buffer.from('<p>x</p>', 'utf8')));
    const sanitized = valueOf(
      registry.transition(1, attemptId, raw.id, 'sanitized', Buffer.from('{}', 'utf8')),
    );
    const resolved = valueOf(registry.transition(1, attemptId, sanitized.id, 'resolved', oversized));

    const service = new HtmlExportPipelineService({
      registry: registry as unknown as HtmlExportPipelineServiceOptions['registry'],
      parseHost: new FakeParseHost() as unknown as HtmlExportPipelineServiceOptions['parseHost'],
    });

    const result = service.finalize(1, attemptId, resolved.id);
    expect(result.ok ? '' : result.error.kind).toBe('pipeline-oversize');
    expect(registry.transitions.filter((t) => t.stage === 'finalized')).toHaveLength(0);
  });
});


describe('HtmlExportPipelineService.readFinalizedArtifact', () => {
  async function driveToFinalized(service: HtmlExportPipelineService, registry: FakeRegistry) {
    const { attemptId, resolvedId } = await driveToResolved(service, registry);
    const finalized = valueOf(service.finalize(1, attemptId, resolvedId));
    return { attemptId, finalizedId: finalized.artifact.id };
  }

  it('returns the exact main-held finalized bytes with a matching digest', async () => {
    const { service, registry } = serviceFor();
    const { attemptId, finalizedId } = await driveToFinalized(service, registry);

    const read = service.readFinalizedArtifact(1, attemptId, finalizedId);

    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const finalizedBytes = registry.transitions.at(-1)?.bytes;
    expect(read.value.bytes.equals(finalizedBytes!)).toBe(true);
    expect(read.value.sha256).toBe(digest(finalizedBytes!));
    expect(read.value.byteLength).toBe(finalizedBytes!.byteLength);
  });

  it('returns typed errors for unknown, wrong-sender, and stale finalized ids', async () => {
    const { service, registry } = serviceFor();
    const { attemptId, finalizedId } = await driveToFinalized(service, registry);

    const unknown = service.readFinalizedArtifact(1, attemptId, 'artifact-missing' as FinalizedArtifactId);
    expect(unknown.ok ? '' : unknown.error.kind).toBe('unknown-artifact');

    const wrongSender = service.readFinalizedArtifact(99, attemptId, finalizedId);
    expect(wrongSender.ok ? '' : wrongSender.error.kind).toBe('wrong-sender');

    registry.invalidateSender(1);
    const stale = service.readFinalizedArtifact(1, attemptId, finalizedId);
    expect(stale.ok ? '' : stale.error.kind).toBe('stale-artifact');
  });

  it('refuses to read a non-finalized artifact id (only finalized bytes are durable)', async () => {
    const { service, registry } = serviceFor();
    const { attemptId, resolvedId } = await driveToResolved(service, registry);

    const read = service.readFinalizedArtifact(
      1,
      attemptId,
      resolvedId as unknown as FinalizedArtifactId,
    );
    expect(read.ok ? '' : read.error.kind).toBe('pipeline-reject');
  });
});
