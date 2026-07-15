import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { HtmlExportAttemptRegistry } from '../main/html-export-attempt-registry';
import {
  HTML_EXPORT_RAW_ARTIFACT_MAX_BYTES,
  HTML_EXPORT_STAGE_ARTIFACT_MAX_BYTES,
  type HtmlExportArtifactId,
  type HtmlExportPipelineResult,
  type RawArtifactId,
  type ResolvedArtifactId,
  type FinalizedArtifactId,
} from '../shared/html-export-pipeline';

const SENDER = 41;
const OTHER_SENDER = 84;

function registryWithIds(...ids: string[]): HtmlExportAttemptRegistry {
  return new HtmlExportAttemptRegistry({
    uuidFactory: () => {
      const id = ids.shift();
      if (!id) throw new Error('test UUID supply exhausted');
      return id;
    },
  });
}

function valueOf<T>(result: HtmlExportPipelineResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  return result.value;
}

function expectError<T>(result: HtmlExportPipelineResult<T>, kind: string): void {
  expect(result).toMatchObject({ ok: false, error: { kind } });
}

describe('HtmlExportAttemptRegistry', () => {
  it('stores the permitted raw → sanitized → resolved → finalized chain', () => {
    const registry = registryWithIds('attempt', 'raw', 'sanitized', 'resolved', 'finalized');
    const { attemptId } = valueOf(registry.beginAttempt(SENDER));
    const raw = valueOf(registry.storeRaw(SENDER, attemptId, Buffer.from('raw')));
    const sanitized = valueOf(registry.transition(SENDER, attemptId, raw.id, 'sanitized', Buffer.from('sanitized')));
    const resolved = valueOf(registry.transition(SENDER, attemptId, sanitized.id, 'resolved', Buffer.from('resolved')));
    const finalized = valueOf(registry.transition(SENDER, attemptId, resolved.id, 'finalized', Buffer.from('finalized')));
    const resolvedId: ResolvedArtifactId = resolved.id;
    const finalizedId: FinalizedArtifactId = finalized.id;
    expect([resolvedId, finalizedId]).toEqual(['resolved', 'finalized']);

    expect([raw.stage, sanitized.stage, resolved.stage, finalized.stage]).toEqual([
      'raw',
      'sanitized',
      'resolved',
      'finalized',
    ]);
    expect(valueOf(registry.read(SENDER, attemptId, finalized.id, 'finalized')).bytes.toString()).toBe('finalized');
  });

  it('stores at most one artifact for each stage of an attempt', () => {
    const registry = registryWithIds('attempt', 'raw', 'sanitized', 'resolved', 'finalized');
    const { attemptId } = valueOf(registry.beginAttempt(SENDER));
    const raw = valueOf(registry.storeRaw(SENDER, attemptId, Buffer.from('raw')));

    expectError(registry.storeRaw(SENDER, attemptId, Buffer.from('duplicate raw')), 'pipeline-reject');

    const sanitized = valueOf(registry.transition(SENDER, attemptId, raw.id, 'sanitized', Buffer.from('sanitized')));
    expectError(
      registry.transition(SENDER, attemptId, raw.id, 'sanitized', Buffer.from('duplicate sanitized')),
      'pipeline-reject',
    );

    const resolved = valueOf(registry.transition(SENDER, attemptId, sanitized.id, 'resolved', Buffer.from('resolved')));
    expectError(
      registry.transition(SENDER, attemptId, sanitized.id, 'resolved', Buffer.from('duplicate resolved')),
      'pipeline-reject',
    );

    valueOf(registry.transition(SENDER, attemptId, resolved.id, 'finalized', Buffer.from('finalized')));
    expectError(
      registry.transition(SENDER, attemptId, resolved.id, 'finalized', Buffer.from('duplicate finalized')),
      'pipeline-reject',
    );
  });

  it('rejects an illegal prior stage and stage-mismatched reads', () => {
    const registry = registryWithIds('attempt', 'raw');
    const { attemptId } = valueOf(registry.beginAttempt(SENDER));
    const raw = valueOf(registry.storeRaw(SENDER, attemptId, Buffer.from('raw')));

    expectError(registry.transition(SENDER, attemptId, raw.id, 'resolved', Buffer.from('resolved')), 'pipeline-reject');
    expectError(registry.read(SENDER, attemptId, raw.id, 'sanitized'), 'pipeline-reject');
  });
  it('enforces exact raw and non-raw artifact limits at the registry boundary', () => {
    const exactRawRegistry = registryWithIds('raw-attempt', 'raw');
    const exactRawAttempt = valueOf(exactRawRegistry.beginAttempt(SENDER)).attemptId;
    expect(exactRawRegistry.storeRaw(
      SENDER,
      exactRawAttempt,
      Buffer.alloc(HTML_EXPORT_RAW_ARTIFACT_MAX_BYTES),
    ).ok).toBe(true);

    const oversizedRawRegistry = registryWithIds('raw-attempt');
    const oversizedRawAttempt = valueOf(oversizedRawRegistry.beginAttempt(SENDER)).attemptId;
    expectError(
      oversizedRawRegistry.storeRaw(
        SENDER,
        oversizedRawAttempt,
        Buffer.alloc(HTML_EXPORT_RAW_ARTIFACT_MAX_BYTES + 1),
      ),
      'pipeline-oversize',
    );

    const exactStageRegistry = registryWithIds('stage-attempt', 'raw', 'sanitized');
    const exactStageAttempt = valueOf(exactStageRegistry.beginAttempt(SENDER)).attemptId;
    const exactStageRaw = valueOf(exactStageRegistry.storeRaw(SENDER, exactStageAttempt, Buffer.from('raw')));
    expect(exactStageRegistry.transition(
      SENDER,
      exactStageAttempt,
      exactStageRaw.id,
      'sanitized',
      Buffer.alloc(HTML_EXPORT_STAGE_ARTIFACT_MAX_BYTES),
    ).ok).toBe(true);

    const oversizedStageRegistry = registryWithIds('stage-attempt', 'raw');
    const oversizedStageAttempt = valueOf(oversizedStageRegistry.beginAttempt(SENDER)).attemptId;
    const oversizedStageRaw = valueOf(
      oversizedStageRegistry.storeRaw(SENDER, oversizedStageAttempt, Buffer.from('raw')),
    );
    expectError(
      oversizedStageRegistry.transition(
        SENDER,
        oversizedStageAttempt,
        oversizedStageRaw.id,
        'sanitized',
        Buffer.alloc(HTML_EXPORT_STAGE_ARTIFACT_MAX_BYTES + 1),
      ),
      'pipeline-oversize',
    );
  });

  it('distinguishes an unknown artifact from a stale artifact and a wrong sender', () => {
    const registry = registryWithIds('attempt', 'raw', 'other-attempt');
    const { attemptId } = valueOf(registry.beginAttempt(SENDER));
    const raw = valueOf(registry.storeRaw(SENDER, attemptId, Buffer.from('raw')));

    expectError(registry.read(SENDER, attemptId, 'missing' as HtmlExportArtifactId), 'unknown-artifact');
    expectError(registry.read(OTHER_SENDER, attemptId, raw.id), 'wrong-sender');

    const { attemptId: otherAttemptId } = valueOf(registry.beginAttempt(OTHER_SENDER));
    expectError(registry.read(SENDER, otherAttemptId, raw.id), 'stale-artifact');
  });

  it('marks the previous active attempt as superseded when a sender begins again', () => {
    const registry = registryWithIds('first-attempt', 'raw', 'second-attempt');
    const { attemptId: firstAttemptId } = valueOf(registry.beginAttempt(SENDER));
    const raw = valueOf(registry.storeRaw(SENDER, firstAttemptId, Buffer.from('raw')));
    const { attemptId: secondAttemptId } = valueOf(registry.beginAttempt(SENDER));

    expect(registry.getActiveAttempt(SENDER)).toBe(secondAttemptId);
    expectError(registry.read(SENDER, firstAttemptId, raw.id), 'attempt-superseded');
  });
  it('keeps the active attempt intact when replacement ID generation fails', () => {
    const registry = registryWithIds('first-attempt', 'raw', 'first-attempt');
    const { attemptId } = valueOf(registry.beginAttempt(SENDER));
    const raw = valueOf(registry.storeRaw(SENDER, attemptId, Buffer.from('raw')));

    expect(() => registry.beginAttempt(SENDER)).toThrow('duplicate or empty attempt ID');
    expect(registry.getActiveAttempt(SENDER)).toBe(attemptId);
    expect(valueOf(registry.read(SENDER, attemptId, raw.id, 'raw')).bytes.toString()).toBe('raw');
  });

  it('invalidates cancelled attempts and sender-close attempts without deleting stale metadata', () => {
    const registry = registryWithIds('cancelled-attempt', 'cancelled-raw', 'closed-attempt', 'closed-raw');
    const { attemptId: cancelledAttemptId } = valueOf(registry.beginAttempt(SENDER));
    const cancelledRaw = valueOf(registry.storeRaw(SENDER, cancelledAttemptId, Buffer.from('raw')));
    expectError(registry.invalidateAttempt(OTHER_SENDER, cancelledAttemptId), 'wrong-sender');
    expect(valueOf(registry.invalidateAttempt(SENDER, cancelledAttemptId))).toEqual({});
    expectError(registry.invalidateAttempt(SENDER, cancelledAttemptId), 'stale-artifact');

    expect(registry.getActiveAttempt(SENDER)).toBeUndefined();
    expectError(registry.read(SENDER, cancelledAttemptId, cancelledRaw.id), 'stale-artifact');

    const { attemptId: closedAttemptId } = valueOf(registry.beginAttempt(SENDER));
    const closedRaw = valueOf(registry.storeRaw(SENDER, closedAttemptId, Buffer.from('raw')));
    registry.invalidateSender(SENDER);

    expect(registry.getActiveAttempt(SENDER)).toBeUndefined();
    expectError(registry.read(SENDER, closedAttemptId, closedRaw.id), 'stale-artifact');
  });

  it('retains only 64 expired attempt tombstones while preserving stable errors', () => {
    let nextId = 0;
    const registry = new HtmlExportAttemptRegistry({
      uuidFactory: () => `id-${nextId++}`,
    });
    const { attemptId: evictedAttemptId } = valueOf(registry.beginAttempt(SENDER));
    const evictedRaw = valueOf(registry.storeRaw(SENDER, evictedAttemptId, Buffer.from('evicted')));
    valueOf(registry.invalidateAttempt(SENDER, evictedAttemptId));

    let retainedAttemptId = evictedAttemptId;
    let retainedRaw = evictedRaw;
    for (let index = 0; index < 64; index += 1) {
      const { attemptId } = valueOf(registry.beginAttempt(SENDER));
      const raw = valueOf(registry.storeRaw(SENDER, attemptId, Buffer.from(`raw-${index}`)));
      valueOf(registry.invalidateAttempt(SENDER, attemptId));
      retainedAttemptId = attemptId;
      retainedRaw = raw;
    }

    expectError(registry.read(SENDER, retainedAttemptId, retainedRaw.id), 'stale-artifact');
    expectError(registry.read(SENDER, evictedAttemptId, evictedRaw.id), 'unknown-artifact');
  });

  it('copies incoming and outgoing artifact bytes', () => {
    const registry = registryWithIds('attempt', 'raw');
    const { attemptId } = valueOf(registry.beginAttempt(SENDER));
    const input = Buffer.from('source');
    const raw = valueOf(registry.storeRaw(SENDER, attemptId, input));
    input.write('mutated');

    const firstRead = valueOf(registry.read(SENDER, attemptId, raw.id, 'raw'));
    expect(firstRead.bytes.toString()).toBe('source');
    firstRead.bytes.write('altered');

    expect(valueOf(registry.read(SENDER, attemptId, raw.id, 'raw')).bytes.toString()).toBe('source');
  });

  it('uses injected IDs and reports a SHA-256 digest with byte length', () => {
    const registry = registryWithIds('attempt-1', 'artifact-1');
    const { attemptId } = valueOf(registry.beginAttempt(SENDER));
    const bytes = Buffer.from('digest me');
    const raw = valueOf(registry.storeRaw(SENDER, attemptId, bytes));

    expect(attemptId).toBe('attempt-1');
    expect(raw.id as RawArtifactId).toBe('artifact-1');
    expect(raw.byteLength).toBe(bytes.byteLength);
    expect(raw.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  });
});
