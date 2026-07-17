import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { parse, type DefaultTreeAdapterTypes } from 'parse5';

import {
  createHtmlExportPipelineError,
  type HtmlExportArtifactId,
  type HtmlExportArtifactRef,
  type HtmlExportAttemptId,
  type HtmlExportPipelineError,
  type HtmlExportPipelineErrorKind,
  type HtmlExportPipelineResult,
  type HtmlExportStage,
} from '../shared/html-export-pipeline';
import type { HtmlExportParseValue } from '../main/html-export-parse-host';
import { sanitizeHtmlExport } from '../main/html-export-sanitize';
import {
  HTML_EXPORT_PIPELINE_STAGE_MAX_BYTES,
  HTML_EXPORT_RAW_MODEL_OUTPUT_MAX_BYTES,
  HtmlExportPipelineService,
  extractHtmlExportDocument,
  type HtmlExportPipelineServiceOptions,
  type HtmlExportSanitizedPayload,
} from '../main/html-export-pipeline-service';

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
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  return result.value;
}

/** In-memory main-registry fake: bytes remain private to the test fake. */
class FakeRegistry {
  private nextId = 1;
  private readonly activeAttempts = new Map<number, HtmlExportAttemptId>();
  private readonly attempts = new Map<HtmlExportAttemptId, number>();
  private readonly artifacts = new Map<HtmlExportArtifactId, Artifact>();
  readonly transitions: Array<{ priorId: HtmlExportArtifactId; stage: HtmlExportStage; bytes: Buffer }> = [];
  readCorruption?: 'bytes' | 'metadata';
  transitionMetadataMismatch = false;

  beginAttempt(webContentsId: number): HtmlExportPipelineResult<{ attemptId: HtmlExportAttemptId }> {
    const attemptId = `attempt-${this.nextId++}` as HtmlExportAttemptId;
    this.attempts.set(attemptId, webContentsId);
    this.activeAttempts.set(webContentsId, attemptId);
    return success({ attemptId });
  }

  storeRaw(webContentsId: number, attemptId: HtmlExportAttemptId, bytes: Uint8Array): HtmlExportPipelineResult<HtmlExportArtifactRef<'raw'>> {
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
    if (prior.value.ref.stage !== source[stage]) return failure('pipeline-reject');
    this.transitions.push({ priorId, stage, bytes: Buffer.from(bytes) });
    const ref = this.store(webContentsId, attemptId, stage, bytes);
    return success(this.transitionMetadataMismatch ? { ...ref, sha256: '0'.repeat(64) } : ref);
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
    const ref = { ...artifact.ref } as HtmlExportArtifactRef<Stage>;
    const bytes = Buffer.from(artifact.bytes);
    const corruption = this.readCorruption;
    this.readCorruption = undefined;
    if (corruption === 'metadata') ref.sha256 = '0'.repeat(64);
    if (corruption === 'bytes' && bytes.length > 0) bytes[0] ^= 0xff;
    return success({ ref, bytes });
  }

  invalidateAttempt(webContentsId: number, attemptId: HtmlExportAttemptId): HtmlExportPipelineResult<Record<string, never>> {
    if (this.attempts.get(attemptId) !== webContentsId) return failure('wrong-sender');
    if (this.activeAttempts.get(webContentsId) !== attemptId) return failure('stale-artifact');
    this.activeAttempts.delete(webContentsId);
    return success({});
  }

  invalidateSender(webContentsId: number): void {
    this.activeAttempts.delete(webContentsId);
  }

  private validateAttempt(webContentsId: number, attemptId: HtmlExportAttemptId): HtmlExportPipelineResult<true> {
    if (!this.attempts.has(attemptId) || this.activeAttempts.get(webContentsId) !== attemptId) return failure('stale-artifact');
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
  readonly inputs: string[] = [];
  documentForNextParse?: DefaultTreeAdapterTypes.Document;
  countsForNextParse?: HtmlExportParseValue['counts'];
  failure?: HtmlExportPipelineError;
  throwCause?: unknown;

  async parse(html: string): Promise<HtmlExportPipelineResult<HtmlExportParseValue>> {
    this.inputs.push(html);
    if (this.failure) return { ok: false, error: this.failure };
    if (this.throwCause !== undefined) throw this.throwCause;
    const document = this.documentForNextParse ?? parse(html);
    const sanitized = sanitizeHtmlExport({ html: '', parse: () => document, isAllowedAssetId: () => false });
    if (!sanitized.ok) {
      return success({
        document,
        counts: this.countsForNextParse ?? { nodeCount: 1, maxDepth: 0, attributeCount: 0 },
      });
    }
    return success({ document, counts: this.countsForNextParse ?? sanitized.counts });
  }
}

function serviceFor(registry = new FakeRegistry(), parseHost = new FakeParseHost(), resolver?: HtmlExportPipelineServiceOptions['resolver']) {
  return {
    registry,
    parseHost,
    service: new HtmlExportPipelineService({
      registry: registry as unknown as HtmlExportPipelineServiceOptions['registry'],
      parseHost: parseHost as unknown as HtmlExportPipelineServiceOptions['parseHost'],
      resolver,
    }),
  };
}

function start(service: HtmlExportPipelineService, webContentsId = 1): HtmlExportAttemptId {
  return valueOf(service.beginAttempt(webContentsId)).attemptId;
}
describe('extractHtmlExportDocument', () => {
  it('keeps the largest HTML or plain fenced block and tolerates an unclosed fence', () => {
    expect(extractHtmlExportDocument('```html\n<p>short</p>\n```\n```html\n<html><body><p>largest</p></body></html>\n```')).toBe(
      '<html><body><p>largest</p></body></html>\n',
    );
    expect(extractHtmlExportDocument('```\n<p>plain</p>\n```')).toBe('<p>plain</p>\n');
    expect(extractHtmlExportDocument('before\n```\n<p>unclosed</p>')).toBe('<p>unclosed</p>');
  });

  it('prefers an HTML document fence over a sibling CSS fence', () => {
    expect(extractHtmlExportDocument('```css\nbody { color: red; }\n```\n```html\n<!doctype html><html><body><p>kept</p></body></html>\n```')).toBe(
      '<!doctype html><html><body><p>kept</p></body></html>\n',
    );
  });
  it('does not merge an unterminated HTML draft with a complete sibling document fence', () => {
    expect(extractHtmlExportDocument('```html\n<html><body><p>draft</p>\nNarration\n```html\n<html><body><p>v2</p></body></html>\n```')).toBe(
      '<html><body><p>v2</p></body></html>\n',
    );
  });
  it('does not include a sibling CSS fence after an unterminated HTML fence', () => {
    expect(extractHtmlExportDocument('```html\n<html><body><p>draft</p>\n```css\nbody { color: red; }\n```')).toBe(
      '<html><body><p>draft</p>\n',
    );
  });
  it('does not truncate a fenced document at literal fences inside a pre block', () => {
    const document = '```html\n<!doctype html><html><body><pre>\n```\ninner code\n```\n</pre><p>tail content</p></body></html>\n```';
    expect(extractHtmlExportDocument(document)).toBe(
      '<!doctype html><html><body><pre>\n```\ninner code\n```\n</pre><p>tail content</p></body></html>',
    );
  });
  it('does not truncate a fenced document when a lang-tagged fence appears inside a pre block', () => {
    const document = '```html\n<html><body><pre>\n```python\ncode\n```\n</pre><p>tail content</p></body></html>\n```';
    expect(extractHtmlExportDocument(document)).toBe(
      '<html><body><pre>\n```python\ncode\n```\n</pre><p>tail content</p></body></html>',
    );
  });

  it('passes through an unfenced document containing literal fences inside a pre block', () => {
    const document = '<!doctype html><html><body><pre>\n```\ninner code\n```\n</pre><p>tail content</p></body></html>';
    expect(extractHtmlExportDocument(document)).toBe(document);
  });

  it('keeps an unfenced document ahead of a later fenced code snippet', () => {
    const document = '<!doctype html><html><body><p>kept</p></body></html>\n```css\nbody { color: red; }\n```';
    expect(extractHtmlExportDocument(document)).toBe(document);
  });

  it('preserves a clean document containing literal fences byte-for-byte', () => {
    const document = '<html><body><pre>\n```\nconst value = 1;\n```</pre></body></html>';
    expect(extractHtmlExportDocument(document)).toBe(document);
  });

  it('extracts a full document from an xhtml fence', () => {
    expect(extractHtmlExportDocument('```xhtml\n<!doctype html><html><body><p>kept</p></body></html>\n```')).toBe(
      '<!doctype html><html><body><p>kept</p></body></html>\n',
    );
  });
  it('supports non-alphanumeric fenced language tags', () => {
    expect(extractHtmlExportDocument('```c++\n<html><body><p>kept</p></body></html>\n```')).toBe(
      '<html><body><p>kept</p></body></html>\n',
    );
  });
  it('slices a complete document from leading narration and otherwise passes text through', () => {
    expect(extractHtmlExportDocument('Here is the page.\n<!DOCTYPE html><html><body><p>kept</p></body></html>\nThanks.')).toBe(
      '<!DOCTYPE html><html><body><p>kept</p></body></html>',
    );
    expect(extractHtmlExportDocument('just prose')).toBe('just prose');
  });
});


describe('HtmlExportPipelineService', () => {
  it('keeps raw ingress main-only and sends sanitize only a bound opaque raw ID', async () => {
    const { service, registry, parseHost } = serviceFor();
    const attemptId = start(service);
    const raw = valueOf(service.storeRawModelOutput(1, attemptId, '<p>raw model output</p>'));

    const result = await service.sanitize(1, attemptId, raw.id);

    expect(result.ok).toBe(true);
    expect(parseHost.inputs).toEqual(['<p>raw model output</p>']);
    expect(registry.transitions).toHaveLength(1);
    expect(registry.transitions[0]).toMatchObject({ priorId: raw.id, stage: 'sanitized' });
    expect(JSON.parse(registry.transitions[0].bytes.toString('utf8'))).toMatchObject({
      bodyHtml: '<p>raw model output</p>',
      counts: expect.any(Object),
    });
  });
  it('extracts a fence-wrapped document before the parse host and sanitizer', async () => {
    const { service, parseHost } = serviceFor();
    const attemptId = start(service);
    const raw = valueOf(service.storeRawModelOutput(
      1,
      attemptId,
      '```html\n<!doctype html><html><body><h1>Title</h1><p>Body</p></body></html>\n```',
    ));

    const result = await service.sanitize(1, attemptId, raw.id);

    expect(result.ok).toBe(true);
    expect(parseHost.inputs).toEqual(['<!doctype html><html><body><h1>Title</h1><p>Body</p></body></html>\n']);
  });

  it('uses only the parse-host document rather than parsing raw HTML in main', async () => {
    const { service, registry, parseHost } = serviceFor();
    const attemptId = start(service);
    const raw = valueOf(service.storeRawModelOutput(1, attemptId, '<script>unsafe raw input</script>'));
    parseHost.documentForNextParse = parse('<p>worker-owned document</p>');

    const result = await service.sanitize(1, attemptId, raw.id);

    expect(result.ok).toBe(true);
    expect(JSON.parse(registry.transitions[0].bytes.toString('utf8')).bodyHtml).toBe('<p>worker-owned document</p>');
    expect(parseHost.inputs).toEqual(['<script>unsafe raw input</script>']);
  });

  it('propagates unknown, wrong-sender, and stale binding errors without remapping them', async () => {
    const { service } = serviceFor();
    const firstAttempt = start(service, 1);
    const raw = valueOf(service.storeRawModelOutput(1, firstAttempt, '<p>bound</p>'));
    const secondAttempt = start(service, 1);

    const unknown = await service.sanitize(1, secondAttempt, 'missing' as HtmlExportArtifactId<'raw'>);
    const wrongSender = await service.sanitize(2, firstAttempt, raw.id);
    const stale = await service.sanitize(1, secondAttempt, raw.id);

    expect(unknown.ok ? '' : unknown.error.kind).toBe('unknown-artifact');
    expect(wrongSender.ok ? '' : wrongSender.error.kind).toBe('wrong-sender');
    expect(stale.ok ? '' : stale.error.kind).toBe('stale-artifact');
  });

  it('allows exactly the frozen raw cap and rejects cap plus one', () => {
    const { service } = serviceFor();
    const attemptId = start(service);

    const exact = service.storeRawModelOutput(1, attemptId, 'a'.repeat(HTML_EXPORT_RAW_MODEL_OUTPUT_MAX_BYTES));
    const plusOne = service.storeRawModelOutput(1, attemptId, 'a'.repeat(HTML_EXPORT_RAW_MODEL_OUTPUT_MAX_BYTES + 1));

    expect(exact.ok).toBe(true);
    expect(plusOne.ok ? '' : plusOne.error.kind).toBe('pipeline-oversize');
  });

  it('stores deterministic UTF-8 candidate bytes and verifies their digest', async () => {
    const first = serviceFor();
    const second = serviceFor();
    const firstAttempt = start(first.service);
    const secondAttempt = start(second.service);
    const firstRaw = valueOf(first.service.storeRawModelOutput(1, firstAttempt, '<p>deterministic</p>'));
    const secondRaw = valueOf(second.service.storeRawModelOutput(1, secondAttempt, '<p>deterministic</p>'));

    const firstResult = await first.service.sanitize(1, firstAttempt, firstRaw.id);
    const secondResult = await second.service.sanitize(1, secondAttempt, secondRaw.id);

    expect(firstResult.ok).toBe(true);
    expect(secondResult.ok).toBe(true);
    expect(first.registry.transitions[0].bytes.equals(second.registry.transitions[0].bytes)).toBe(true);
    expect(firstResult.ok && firstResult.value.artifact.sha256).toBe(digest(first.registry.transitions[0].bytes));
  });

  it('strips sanitizer violations while preserving worker rejections', async () => {
    const sanitizer = serviceFor();
    const sanitizerAttempt = start(sanitizer.service);
    const sanitizerRaw = valueOf(sanitizer.service.storeRawModelOutput(1, sanitizerAttempt, '<section><script>alert(1)</script><p>safe</p></section>'));
    const sanitizerResult = await sanitizer.service.sanitize(1, sanitizerAttempt, sanitizerRaw.id);

    const worker = serviceFor();
    worker.parseHost.failure = createHtmlExportPipelineError('pipeline-oversize');
    const workerAttempt = start(worker.service);
    const workerRaw = valueOf(worker.service.storeRawModelOutput(1, workerAttempt, '<p>worker cap</p>'));
    const workerResult = await worker.service.sanitize(1, workerAttempt, workerRaw.id);

    expect(sanitizerResult.ok).toBe(true);
    expect(workerResult.ok ? '' : workerResult.error.kind).toBe('pipeline-oversize');
  });


  it('removes an unissued asset:<id> image while preserving the document', async () => {
    const { service, registry } = serviceFor();
    const attemptId = start(service);
    const raw = valueOf(
      service.storeRawModelOutput(1, attemptId, '<section><h1>t</h1><img src="asset:aaaaaaaaaaaaaaaa" alt="diagram"></section>'),
    );
    const result = await service.sanitize(1, attemptId, raw.id);
    expect(result.ok).toBe(true);
    expect(registry.transitions).toHaveLength(1);
  });

  it('rejects mismatched worker node, depth, and attribute counts before a registry transition', async () => {
    for (const field of ['nodeCount', 'maxDepth', 'attributeCount'] as const) {
      const { service, registry, parseHost } = serviceFor();
      const attemptId = start(service);
      const html = '<section id="section"><p class="body">Counted</p></section>';
      const document = parse(html);
      const sanitized = sanitizeHtmlExport({ html, parse: () => document, isAllowedAssetId: () => false });
      if (!sanitized.ok) throw new Error('test document must sanitize');

      parseHost.documentForNextParse = document;
      parseHost.countsForNextParse = {
        ...sanitized.counts,
        [field]: sanitized.counts[field] + 1,
      };
      const raw = valueOf(service.storeRawModelOutput(1, attemptId, html));
      const result = await service.sanitize(1, attemptId, raw.id);

      expect(result.ok ? '' : result.error.kind).toBe('pipeline-reject');
      expect(registry.transitions).toHaveLength(0);
    }
  });
  it('rejects sanitized expansion by UTF-8 bytes before a registry transition', async () => {
    const { service, registry } = serviceFor();
    const attemptId = start(service);
    const html = `<p>${'가'.repeat(2_000_000)}</p>`;
    expect(Buffer.byteLength(html, 'utf8')).toBeLessThan(HTML_EXPORT_RAW_MODEL_OUTPUT_MAX_BYTES);
    const raw = valueOf(service.storeRawModelOutput(1, attemptId, html));

    const result = await service.sanitize(1, attemptId, raw.id);

    expect(result.ok ? '' : result.error.kind).toBe('pipeline-oversize');
    expect(registry.transitions).toHaveLength(0);
  });

  it('keeps thrown dependency details main-owned while returning safe public errors', async () => {
    const parseFailure = serviceFor();
    parseFailure.parseHost.throwCause = new TypeError('parse dependency exploded');
    const parseAttempt = start(parseFailure.service);
    const parseRaw = valueOf(
      parseFailure.service.storeRawModelOutput(1, parseAttempt, '<p>parse failure</p>'),
    );

    const parseResult = await parseFailure.service.sanitize(1, parseAttempt, parseRaw.id);

    expect(parseResult).toStrictEqual({
      ok: false,
      error: { kind: 'pipeline-reject', detail: 'HTML parse worker failed' },
    });
    expect(parseFailure.service.getDiagnostics()).toStrictEqual([{
      boundary: 'parse-host',
      causeName: 'TypeError',
      causeMessage: 'parse dependency exploded',
    }]);

    const resolverFailure = serviceFor(undefined, undefined, async () => {
      throw new RangeError('resolver dependency exploded');
    });
    const resolverAttempt = start(resolverFailure.service);
    const resolverRaw = valueOf(
      resolverFailure.service.storeRawModelOutput(1, resolverAttempt, '<p>resolver failure</p>'),
    );
    const sanitized = valueOf(
      await resolverFailure.service.sanitize(1, resolverAttempt, resolverRaw.id),
    ).artifact;

    const resolverResult = await resolverFailure.service.resolve(1, resolverAttempt, sanitized.id);

    expect(resolverResult).toStrictEqual({
      ok: false,
      error: { kind: 'pipeline-reject', detail: 'HTML export resolver rejected sanitized payload' },
    });
    expect(resolverFailure.service.getDiagnostics()).toStrictEqual([{
      boundary: 'resolver',
      causeName: 'RangeError',
      causeMessage: 'resolver dependency exploded',
    }]);
  });
  it('bounds hostile diagnostic fields without escaping the public error contract', async () => {
    const fixture = serviceFor();
    const hostile = new Error('unused');
    Object.defineProperty(hostile, 'name', {
      get: () => {
        throw new Error('hostile name accessor');
      },
    });
    fixture.parseHost.throwCause = hostile;
    const hostileAttempt = start(fixture.service);
    const hostileRaw = valueOf(
      fixture.service.storeRawModelOutput(1, hostileAttempt, '<p>hostile diagnostic</p>'),
    );

    const hostileResult = await fixture.service.sanitize(1, hostileAttempt, hostileRaw.id);

    expect(hostileResult).toStrictEqual({
      ok: false,
      error: { kind: 'pipeline-reject', detail: 'HTML parse worker failed' },
    });
    expect(fixture.service.getDiagnostics()).toStrictEqual([{
      boundary: 'parse-host',
      causeName: 'unknown',
      causeMessage: 'Unavailable pipeline dependency failure',
    }]);

    const malformed = new Error('unused');
    Object.defineProperties(malformed, {
      name: { value: 42 },
      message: { value: { unsafe: true } },
    });
    fixture.parseHost.throwCause = malformed;
    const malformedAttempt = start(fixture.service);
    const malformedRaw = valueOf(
      fixture.service.storeRawModelOutput(1, malformedAttempt, '<p>malformed diagnostic</p>'),
    );
    const malformedResult = await fixture.service.sanitize(1, malformedAttempt, malformedRaw.id);
    expect(malformedResult.ok ? '' : malformedResult.error.kind).toBe('pipeline-reject');
    expect(fixture.service.getDiagnostics().at(-1)).toStrictEqual({
      boundary: 'parse-host',
      causeName: 'Error',
      causeMessage: 'Unavailable Error message',
    });

    const oversized = new Error('m'.repeat(600));
    oversized.name = 'n'.repeat(100);
    fixture.parseHost.throwCause = oversized;
    for (let index = 0; index < 17; index += 1) {
      const attemptId = start(fixture.service);
      const raw = valueOf(
        fixture.service.storeRawModelOutput(1, attemptId, `<p>diagnostic ${index}</p>`),
      );
      const result = await fixture.service.sanitize(1, attemptId, raw.id);
      expect(result.ok ? '' : result.error.kind).toBe('pipeline-reject');
    }

    const diagnostics = fixture.service.getDiagnostics();
    expect(diagnostics).toHaveLength(16);
    expect(diagnostics.every((diagnostic) =>
      diagnostic.causeName.length === 64 && diagnostic.causeMessage.length === 512)).toBe(true);
  });
  it('rejects corrupt registry reads and mismatched transition metadata', async () => {
    for (const corruption of ['bytes', 'metadata'] as const) {
      const { service, registry } = serviceFor();
      const attemptId = start(service);
      const raw = valueOf(service.storeRawModelOutput(1, attemptId, '<p>immutable</p>'));
      registry.readCorruption = corruption;

      const result = await service.sanitize(1, attemptId, raw.id);

      expect(result.ok ? '' : result.error.kind).toBe('pipeline-reject');
      expect(registry.transitions).toHaveLength(0);
    }

    const transition = serviceFor();
    const transitionAttempt = start(transition.service);
    const transitionRaw = valueOf(
      transition.service.storeRawModelOutput(1, transitionAttempt, '<p>transition metadata</p>'),
    );
    transition.registry.transitionMetadataMismatch = true;

    const transitionResult = await transition.service.sanitize(1, transitionAttempt, transitionRaw.id);

    expect(transitionResult.ok ? '' : transitionResult.error.kind).toBe('pipeline-reject');
    expect(transition.registry.transitions).toHaveLength(1);
  });

  it('rejects corrupt sanitized metadata before invoking the resolver', async () => {
    let resolverCalls = 0;
    const { service, registry } = serviceFor(undefined, undefined, async () => {
      resolverCalls += 1;
      return 'resolved';
    });
    const attemptId = start(service);
    const raw = valueOf(service.storeRawModelOutput(1, attemptId, '<p>resolve</p>'));
    const sanitized = valueOf(await service.sanitize(1, attemptId, raw.id)).artifact;
    registry.readCorruption = 'metadata';

    const result = await service.resolve(1, attemptId, sanitized.id);

    expect(result.ok ? '' : result.error.kind).toBe('pipeline-reject');
    expect(resolverCalls).toBe(0);
    expect(registry.transitions).toHaveLength(1);
  });

  it('resolves only a sanitized prior ID through the main-owned resolver', async () => {
    const resolver = async (payload: HtmlExportSanitizedPayload) => `resolved:${payload.bodyHtml}`;
    const { service, registry } = serviceFor(undefined, undefined, resolver);
    const attemptId = start(service);
    const raw = valueOf(service.storeRawModelOutput(1, attemptId, '<p>resolve me</p>'));
    const sanitized = valueOf(await service.sanitize(1, attemptId, raw.id)).artifact;

    const resolved = await service.resolve(1, attemptId, sanitized.id);
    const wrongStage = await service.resolve(1, attemptId, raw.id as unknown as HtmlExportArtifactId<'sanitized'>);

    expect(resolved.ok).toBe(true);
    expect(wrongStage.ok ? '' : wrongStage.error.kind).toBe('pipeline-reject');
    expect(registry.transitions.at(-1)).toMatchObject({ priorId: sanitized.id, stage: 'resolved' });
    expect(registry.transitions.at(-1)?.bytes.toString('utf8')).toBe('resolved:<p>resolve me</p>');
  });

  it('rejects resolve without a resolver and applies the exact resolved cap', async () => {
    const absent = serviceFor();
    const absentAttempt = start(absent.service);
    const absentRaw = valueOf(absent.service.storeRawModelOutput(1, absentAttempt, '<p>no resolver</p>'));
    const absentSanitized = valueOf(await absent.service.sanitize(1, absentAttempt, absentRaw.id)).artifact;
    const absentResult = await absent.service.resolve(1, absentAttempt, absentSanitized.id);

    const exact = serviceFor(undefined, undefined, async () => 'a'.repeat(HTML_EXPORT_PIPELINE_STAGE_MAX_BYTES));
    const exactAttempt = start(exact.service);
    const exactRaw = valueOf(exact.service.storeRawModelOutput(1, exactAttempt, '<p>cap</p>'));
    const exactSanitized = valueOf(await exact.service.sanitize(1, exactAttempt, exactRaw.id)).artifact;
    const exactResult = await exact.service.resolve(1, exactAttempt, exactSanitized.id);

    const plusOne = serviceFor(undefined, undefined, async () => 'a'.repeat(HTML_EXPORT_PIPELINE_STAGE_MAX_BYTES + 1));
    const plusOneAttempt = start(plusOne.service);
    const plusOneRaw = valueOf(plusOne.service.storeRawModelOutput(1, plusOneAttempt, '<p>cap</p>'));
    const plusOneSanitized = valueOf(await plusOne.service.sanitize(1, plusOneAttempt, plusOneRaw.id)).artifact;
    const plusOneResult = await plusOne.service.resolve(1, plusOneAttempt, plusOneSanitized.id);

    expect(absentResult.ok ? '' : absentResult.error.kind).toBe('pipeline-reject');
    expect(exactResult.ok).toBe(true);
    expect(plusOneResult.ok ? '' : plusOneResult.error.kind).toBe('pipeline-oversize');
  });
  it('rejects sanitized payloads whose optional content-root fields are non-string', async () => {
    let resolverCalls = 0;
    const { service, registry } = serviceFor(undefined, undefined, async () => {
      resolverCalls += 1;
      return 'resolved';
    });
    const attemptId = start(service);
    // Seed a legitimate sanitized artifact, then overwrite its stored bytes with
    // a shape-invalid payload (contentRootClass/Id must be string | undefined).
    const raw = valueOf(service.storeRawModelOutput(1, attemptId, '<p>shape</p>'));
    const sanitized = valueOf(await service.sanitize(1, attemptId, raw.id)).artifact;

    const basePayload = {
      bodyHtml: '<p>shape</p>',
      documentHtml: '<html><body><p>shape</p></body></html>',
      contentCss: '',
      counts: { nodeCount: 1, maxDepth: 1, attributeCount: 0 },
    };

    for (const bad of [
      { ...basePayload, contentRootClass: 42 },
      { ...basePayload, contentRootId: null },
      { ...basePayload, contentRootClass: { x: 1 } },
      { ...basePayload, contentRootId: true },
    ]) {
      const bytes = Buffer.from(JSON.stringify(bad), 'utf8');
      // Replace the registry artifact bytes under the same id so resolve() parses them.
      const stored = (registry as unknown as { artifacts: Map<string, { bytes: Buffer }> }).artifacts.get(sanitized.id);
      expect(stored).toBeDefined();
      stored!.bytes = bytes;
      // Keep digest metadata aligned so the shape guard (not digest) is the reject reason.
      const artifact = (registry as unknown as {
        artifacts: Map<string, { ref: { sha256: string; byteLength: number }; bytes: Buffer }>;
      }).artifacts.get(sanitized.id)!;
      artifact.ref.sha256 = digest(bytes);
      artifact.ref.byteLength = bytes.byteLength;

      const result = await service.resolve(1, attemptId, sanitized.id);
      expect(result.ok ? '' : result.error.kind).toBe('pipeline-reject');
    }

    expect(resolverCalls).toBe(0);
  });

  it('accepts sanitized payloads with string or omitted content-root identity fields', async () => {
    const seen: HtmlExportSanitizedPayload[] = [];
    const { service, registry } = serviceFor(undefined, undefined, async (payload) => {
      seen.push(payload);
      return `ok:${payload.bodyHtml}`;
    });
    const attemptId = start(service);
    const raw = valueOf(service.storeRawModelOutput(1, attemptId, '<p>ok</p>'));
    const sanitized = valueOf(await service.sanitize(1, attemptId, raw.id)).artifact;

    const withStrings = {
      bodyHtml: '<p>ok</p>',
      documentHtml: '<html><body><p>ok</p></body></html>',
      contentCss: '',
      counts: { nodeCount: 1, maxDepth: 1, attributeCount: 0 },
      contentRootClass: 'dark',
      contentRootId: 'app',
    };
    const bytes = Buffer.from(JSON.stringify(withStrings), 'utf8');
    const artifact = (registry as unknown as {
      artifacts: Map<string, { ref: { sha256: string; byteLength: number }; bytes: Buffer }>;
    }).artifacts.get(sanitized.id)!;
    artifact.bytes = bytes;
    artifact.ref.sha256 = digest(bytes);
    artifact.ref.byteLength = bytes.byteLength;

    const result = await service.resolve(1, attemptId, sanitized.id);
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].contentRootClass).toBe('dark');
    expect(seen[0].contentRootId).toBe('app');
  });
});
