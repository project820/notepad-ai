import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HtmlExportPipelineErrorKind } from '../shared/html-export-pipeline';

const ipc = vi.hoisted(() => {
  type Handler = (event: any, input: unknown) => unknown;
  const handlers = new Map<string, Handler>();
  return {
    handleTrusted: (channel: string, handler: Handler) => handlers.set(channel, handler),
    handler: (channel: string) => handlers.get(channel),
    reset: () => handlers.clear(),
  };
});

vi.mock('../main/ipc-guard', () => ({ handleTrusted: ipc.handleTrusted }));
vi.mock('electron', () => ({ dialog: {}, shell: {} }));
import { dialog } from 'electron';

import { registerHtmlExportIpc } from '../main/ipc/html-export-ipc';

type Sender = {
  id: number;
  once: ReturnType<typeof vi.fn>;
};

function eventFor(sender: Sender) {
  return { sender } as never;
}

function createService() {
  return {
    beginAttempt: vi.fn(() => ({ ok: true as const, value: { attemptId: 'attempt-1' } })),
    sanitize: vi.fn(() => ({ ok: true as const, value: { artifact: { id: 'sanitized-1' } } })),
    resolve: vi.fn(() => ({ ok: true as const, value: { artifact: { id: 'resolved-1' } } })),
    finalize: vi.fn(() => ({
      ok: true as const,
      value: {
        artifact: {
          id: 'finalized-1',
          stage: 'finalized',
          sha256: 'a'.repeat(64),
          byteLength: 12,
        },
      },
    })),
    readFinalizedArtifact: vi.fn(() => ({
      ok: true as const,
      value: {
        bytes: Buffer.from('<!doctype html><p>final</p>', 'utf8'),
        sha256: 'b'.repeat(64),
        byteLength: 27,
      },
    })),
    invalidateAttempt: vi.fn(() => ({ ok: true as const, value: {} })),
    invalidateSender: vi.fn(),
  };
}
function createQuarantine(pass = true) {
  return {
    measure: vi.fn(async () =>
      pass
        ? {
            ok: true as const,
            value: {
              verdict: 'pass' as const,
              measurement: {
                nodeCount: 1,
                maxDepth: 1,
                documentWidth: 100,
                documentHeight: 100,
                viewportWidth: 100,
                viewportHeight: 100,
                horizontalOverflow: false,
                activeRegionCount: 1,
                printNavHidden: true,
                printSectionsOrdered: true,
              },
            },
          }
        : {
            ok: false as const,
            error: { kind: 'layout-violation' as const, detail: 'HTML export quarantine error: layout-violation' },
          },
    ),
    cancelWebContents: vi.fn(),
    cancelAttempt: vi.fn(),
  };
}
function createAssetLifecycle(activeAttempt = 'attempt-old') {
  return {
    getActiveAttempt: vi.fn(() => activeAttempt),
    invalidateAttempt: vi.fn(),
    releaseWebContents: vi.fn(),
  };
}
function createNoopAssetLifecycle() {
  return {
    getActiveAttempt: vi.fn(() => undefined),
    invalidateAttempt: vi.fn(),
    releaseWebContents: vi.fn(),
  };
}
function expectCanonicalPipelineError(
  result: unknown,
  kind: HtmlExportPipelineErrorKind,
  dependencyDetail?: string,
): void {
  const response = result as { readonly ok: boolean; readonly error: unknown };
  expect(response).toStrictEqual({
    ok: false,
    error: {
      kind,
      detail: `HTML export pipeline error: ${kind}`,
    },
  });
  expect(Object.getPrototypeOf(response.error)).toBe(Object.prototype);
  expect((response.error as object)).not.toBeInstanceOf(Error);
  const serialized = JSON.stringify(response);
  expect(serialized).not.toMatch(/private|secret|path/i);
  if (dependencyDetail) {
    expect(serialized).not.toContain(dependencyDetail);
    expect(serialized).not.toContain('/private/');
  }
}
function expectCanonicalPipelineReject(result: unknown): void {
  expectCanonicalPipelineError(result, 'pipeline-reject');
}


describe('HTML export pipeline IPC', () => {
  beforeEach(() => ipc.reset());

  it('forwards only opaque IDs to the pipeline service', async () => {
    const service = createService();
    const sender: Sender = { id: 41, once: vi.fn() };
    registerHtmlExportIpc({
      windowForWebContents: () => null,
      pipelineService: service as never,
      assetLifecycle: createNoopAssetLifecycle(),
    });

    await ipc.handler('html:attempt:generate')!(eventFor(sender), {});
    await ipc.handler('html:pipeline:sanitize')!(eventFor(sender), {
      attemptId: 'attempt-1',
      rawArtifactId: 'raw-1',
    });
    await ipc.handler('html:pipeline:resolve')!(eventFor(sender), {
      attemptId: 'attempt-1',
      sanitizedCandidateId: 'sanitized-1',
    });
    await ipc.handler('html:attempt:cancel')!(eventFor(sender), { attemptId: 'attempt-1' });

    expect(service.beginAttempt).toHaveBeenCalledWith(41);
    expect(service.sanitize).toHaveBeenCalledWith(41, 'attempt-1', 'raw-1');
    expect(service.resolve).toHaveBeenCalledWith(41, 'attempt-1', 'sanitized-1');
    expect(service.invalidateAttempt).toHaveBeenCalledWith(41, 'attempt-1');
  });

  const invalidOpaqueIds = [
    ['empty', ''],
    ['oversized', 'a'.repeat(129)],
    ['HTML-containing', '<html>not-an-id</html>'],
    ['whitespace', 'attempt id'],
    ['punctuation', 'attempt.id'],
  ] as const;

  it.each(invalidOpaqueIds)('rejects %s opaque IDs in every expected field', async (_description, invalidId) => {
    const service = createService();
    const sender: Sender = { id: 42, once: vi.fn() };
    registerHtmlExportIpc({
      windowForWebContents: () => null,
      pipelineService: service as never,
      assetLifecycle: createNoopAssetLifecycle(),
    });

    const expected = {
      ok: false,
      error: {
        kind: 'pipeline-reject',
        detail: 'HTML export pipeline error: pipeline-reject',
      },
    };
    const results = await Promise.all([
      ipc.handler('html:pipeline:sanitize')!(eventFor(sender), {
        attemptId: invalidId,
        rawArtifactId: 'raw-2',
      }),
      ipc.handler('html:pipeline:sanitize')!(eventFor(sender), {
        attemptId: 'attempt-2',
        rawArtifactId: invalidId,
      }),
      ipc.handler('html:pipeline:resolve')!(eventFor(sender), {
        attemptId: invalidId,
        sanitizedCandidateId: 'sanitized-2',
      }),
      ipc.handler('html:pipeline:resolve')!(eventFor(sender), {
        attemptId: 'attempt-2',
        sanitizedCandidateId: invalidId,
      }),
      ipc.handler('html:attempt:cancel')!(eventFor(sender), { attemptId: invalidId }),
    ]);

    for (const result of results) {
      expect(result).toStrictEqual(expected);
    }
    expect(service.sanitize).not.toHaveBeenCalled();
    expect(service.resolve).not.toHaveBeenCalled();
    expect(service.invalidateAttempt).not.toHaveBeenCalled();
  });
  it.each([
    ['null', null],
    ['array', []],
    ['number', 42],
    ['string', 'attempt-2'],
    ['wrong field types', { attemptId: 2, rawArtifactId: false }],
    ['inherited fields', Object.create({ attemptId: 'attempt-2', rawArtifactId: 'raw-2' })],
    ['custom prototype', Object.assign(Object.create({ polluted: true }), {
      attemptId: 'attempt-2',
      rawArtifactId: 'raw-2',
    })],
  ])('rejects %s request shapes across every pipeline handler', async (_description, malformed) => {
    const service = createService();
    const sender: Sender = { id: 46, once: vi.fn() };
    registerHtmlExportIpc({
      windowForWebContents: () => null,
      pipelineService: service as never,
      assetLifecycle: createNoopAssetLifecycle(),
    });

    const results = await Promise.all([
      ipc.handler('html:attempt:generate')!(eventFor(sender), malformed),
      ipc.handler('html:pipeline:sanitize')!(eventFor(sender), malformed),
      ipc.handler('html:pipeline:resolve')!(eventFor(sender), malformed),
      ipc.handler('html:attempt:cancel')!(eventFor(sender), malformed),
    ]);

    for (const result of results) {
      expect(result).toMatchObject({ ok: false, error: { kind: 'pipeline-reject' } });
    }
    expect(service.beginAttempt).not.toHaveBeenCalled();
    expect(service.sanitize).not.toHaveBeenCalled();
    expect(service.resolve).not.toHaveBeenCalled();
    expect(service.invalidateAttempt).not.toHaveBeenCalled();
  });

  it('rejects malformed and byte-bearing requests before calling the pipeline', async () => {
    const service = createService();
    const sender: Sender = { id: 44, once: vi.fn() };
    registerHtmlExportIpc({
      windowForWebContents: () => null,
      pipelineService: service as never,
      assetLifecycle: createNoopAssetLifecycle(),
    });

    const malformed = await ipc.handler('html:pipeline:sanitize')!(eventFor(sender), {
      attemptId: 'attempt-2',
      rawArtifactId: 'raw-2',
      rawHtml: '<html>renderer bytes must not cross this boundary</html>',
    });
    const invalidBegin = await ipc.handler('html:attempt:generate')!(eventFor(sender), {
      html: '<html>renderer bytes must not cross this boundary</html>',
    });
    const invalidResolve = await ipc.handler('html:pipeline:resolve')!(eventFor(sender), {
      attemptId: 'attempt-2',
      sanitizedCandidateId: 'sanitized-2',
      sanitizedHtml: '<html>renderer bytes must not cross this boundary</html>',
    });
    const invalidCancel = await ipc.handler('html:attempt:cancel')!(eventFor(sender), {
      attemptId: 'attempt-2',
      finalHtml: '<html>renderer bytes must not cross this boundary</html>',
    });

    expect(malformed).toMatchObject({ ok: false, error: { kind: 'pipeline-reject' } });
    expect(invalidBegin).toMatchObject({ ok: false, error: { kind: 'pipeline-reject' } });
    expect(invalidResolve).toMatchObject({ ok: false, error: { kind: 'pipeline-reject' } });
    expect(invalidCancel).toMatchObject({ ok: false, error: { kind: 'pipeline-reject' } });
    expect(service.sanitize).not.toHaveBeenCalled();
    expect(service.beginAttempt).not.toHaveBeenCalled();
    expect(service.resolve).not.toHaveBeenCalled();
    expect(service.invalidateAttempt).not.toHaveBeenCalled();
  });

  const stableErrorKinds = [
    'unknown-artifact',
    'stale-artifact',
    'wrong-sender',
    'attempt-superseded',
    'pipeline-oversize',
    'pipeline-reject',
  ] as const satisfies readonly HtmlExportPipelineErrorKind[];

  it.each(stableErrorKinds)('normalizes private detail from every pipeline handler %s failure', async (kind) => {
    const handlers = [
      ['begin', 'html:attempt:generate', {}, 'beginAttempt', []],
      ['sanitize', 'html:pipeline:sanitize', { attemptId: 'attempt-typed', rawArtifactId: 'raw-typed' }, 'sanitize', ['attempt-typed', 'raw-typed']],
      ['resolve', 'html:pipeline:resolve', { attemptId: 'attempt-typed', sanitizedCandidateId: 'sanitized-typed' }, 'resolve', ['attempt-typed', 'sanitized-typed']],
      ['cancel', 'html:attempt:cancel', { attemptId: 'attempt-typed' }, 'invalidateAttempt', ['attempt-typed']],
    ] as const;

    for (const [operation, channel, input, method, expectedArgs] of handlers) {
      const service = createService();
      const dependencyDetail = `private ${operation} failure at /private/${method}/secret.html`;
      service[method].mockReturnValueOnce({
        ok: false,
        error: { kind, detail: dependencyDetail },
      });
      const sender: Sender = { id: 43, once: vi.fn() };
      const assetLifecycle = createNoopAssetLifecycle();
      registerHtmlExportIpc({
        windowForWebContents: () => null,
        pipelineService: service as never,
        assetLifecycle,
      });

      const result = await ipc.handler(channel)!(eventFor(sender), input);

      expectCanonicalPipelineError(result, kind, dependencyDetail);
      expect(service[method]).toHaveBeenCalledExactlyOnceWith(43, ...expectedArgs);
      expect(assetLifecycle.invalidateAttempt).not.toHaveBeenCalled();
    }
  });
  it.each([
    ['begin', 'html:attempt:generate', {}, 'beginAttempt'],
    ['sanitize', 'html:pipeline:sanitize', { attemptId: 'attempt-throw', rawArtifactId: 'raw-throw' }, 'sanitize'],
    ['resolve', 'html:pipeline:resolve', { attemptId: 'attempt-throw', sanitizedCandidateId: 'sanitized-throw' }, 'resolve'],
    ['cancel', 'html:attempt:cancel', { attemptId: 'attempt-throw' }, 'invalidateAttempt'],
  ] as const)('contains private-path errors thrown by pipeline %s dependencies', async (
    _operation,
    channel,
    input,
    method,
  ) => {
    const service = createService();
    service[method].mockImplementationOnce(() => {
      throw new Error(`private failure at /private/${method}/secret.html`);
    });
    const sender: Sender = { id: 52, once: vi.fn() };
    const assetLifecycle = createAssetLifecycle();
    registerHtmlExportIpc({
      windowForWebContents: () => null,
      pipelineService: service as never,
      assetLifecycle,
    });

    const result = await ipc.handler(channel)!(eventFor(sender), input);
    expectCanonicalPipelineReject(result);
    expect(assetLifecycle.invalidateAttempt).not.toHaveBeenCalled();
  });
  it.each([
    ['begin', 'html:attempt:generate', {}, 'beginAttempt'],
    ['sanitize', 'html:pipeline:sanitize', { attemptId: 'attempt-reject', rawArtifactId: 'raw-reject' }, 'sanitize'],
    ['resolve', 'html:pipeline:resolve', { attemptId: 'attempt-reject', sanitizedCandidateId: 'sanitized-reject' }, 'resolve'],
    ['cancel', 'html:attempt:cancel', { attemptId: 'attempt-reject' }, 'invalidateAttempt'],
  ] as const)('contains private-path errors rejected by pipeline %s dependencies', async (
    _operation,
    channel,
    input,
    method,
  ) => {
    const service = createService();
    service[method].mockRejectedValueOnce(new Error(`private rejection at /private/${method}/secret.html`));
    const sender: Sender = { id: 56, once: vi.fn() };
    const assetLifecycle = createAssetLifecycle();
    registerHtmlExportIpc({
      windowForWebContents: () => null,
      pipelineService: service as never,
      assetLifecycle,
    });

    const result = await ipc.handler(channel)!(eventFor(sender), input);
    expectCanonicalPipelineReject(result);
    expect(assetLifecycle.invalidateAttempt).not.toHaveBeenCalled();
  });

  it('contains lifecycle dependency failures without beginning downstream cleanup', async () => {
    const service = createService();
    const assetLifecycle = createAssetLifecycle();
    assetLifecycle.getActiveAttempt.mockImplementationOnce(() => {
      throw new Error('private lifecycle failure at /private/attempts/secret.html');
    });
    const sender: Sender = { id: 53, once: vi.fn() };
    registerHtmlExportIpc({
      windowForWebContents: () => null,
      pipelineService: service as never,
      assetLifecycle,
    });

    const result = await ipc.handler('html:attempt:generate')!(eventFor(sender), {});
    expectCanonicalPipelineReject(result);
    expect(service.beginAttempt).not.toHaveBeenCalled();
    expect(assetLifecycle.invalidateAttempt).not.toHaveBeenCalled();
  });
  it('contains asynchronously rejected lifecycle lookup failures before beginning downstream work', async () => {
    const service = createService();
    const assetLifecycle = createAssetLifecycle();
    assetLifecycle.getActiveAttempt.mockRejectedValueOnce(
      new Error('private lifecycle rejection at /private/attempts/secret.html'),
    );
    const sender: Sender = { id: 57, once: vi.fn() };
    registerHtmlExportIpc({
      windowForWebContents: () => null,
      pipelineService: service as never,
      assetLifecycle,
    });

    const result = await ipc.handler('html:attempt:generate')!(eventFor(sender), {});
    expectCanonicalPipelineReject(result);
    expect(service.beginAttempt).not.toHaveBeenCalled();
    expect(assetLifecycle.invalidateAttempt).not.toHaveBeenCalled();
  });

  it.each([
    ['begin supersession', 'html:attempt:generate', {}, 'attempt-old'],
    ['successful cancellation', 'html:attempt:cancel', { attemptId: 'attempt-1' }, 'attempt-1'],
  ] as const)('contains lifecycle invalidation failures after %s', async (
    _operation,
    channel,
    input,
    expectedAttemptId,
  ) => {
    const service = createService();
    const assetLifecycle = createAssetLifecycle();
    assetLifecycle.invalidateAttempt.mockImplementationOnce(() => {
      throw new Error('private lifecycle invalidation at /private/assets/secret.png');
    });
    const sender: Sender = { id: 54, once: vi.fn() };
    registerHtmlExportIpc({
      windowForWebContents: () => null,
      pipelineService: service as never,
      assetLifecycle,
    });

    const result = await ipc.handler(channel)!(eventFor(sender), input);
    expectCanonicalPipelineReject(result);
    expect(assetLifecycle.invalidateAttempt).toHaveBeenCalledExactlyOnceWith({
      webContentsId: 54,
      attemptId: expectedAttemptId,
    });
  });
  it.each([
    ['begin supersession', 'html:attempt:generate', {}, 'attempt-old'],
    ['successful cancellation', 'html:attempt:cancel', { attemptId: 'attempt-1' }, 'attempt-1'],
  ] as const)('contains asynchronously rejected lifecycle invalidation after %s', async (
    _operation,
    channel,
    input,
    expectedAttemptId,
  ) => {
    const service = createService();
    const assetLifecycle = createAssetLifecycle();
    assetLifecycle.invalidateAttempt.mockRejectedValueOnce(
      new Error('private lifecycle rejection at /private/assets/secret.png'),
    );
    const sender: Sender = { id: 58, once: vi.fn() };
    registerHtmlExportIpc({
      windowForWebContents: () => null,
      pipelineService: service as never,
      assetLifecycle,
    });

    const result = await ipc.handler(channel)!(eventFor(sender), input);
    expectCanonicalPipelineReject(result);
    expect(assetLifecycle.invalidateAttempt).toHaveBeenCalledExactlyOnceWith({
      webContentsId: 58,
      attemptId: expectedAttemptId,
    });
  });

  it('cleans asset lifecycle only after successful superseding begins and cancels', async () => {
    const service = createService();
    const assetLifecycle = createAssetLifecycle();
    const sender: Sender = { id: 47, once: vi.fn() };
    registerHtmlExportIpc({
      windowForWebContents: () => null,
      pipelineService: service as never,
      assetLifecycle,
    });

    await expect(ipc.handler('html:attempt:generate')!(eventFor(sender), {})).resolves.toEqual({
      ok: true,
      value: { attemptId: 'attempt-1' },
    });
    expect(assetLifecycle.getActiveAttempt).toHaveBeenCalledWith(47);
    expect(assetLifecycle.invalidateAttempt).toHaveBeenCalledWith({ webContentsId: 47, attemptId: 'attempt-old' });

    await expect(ipc.handler('html:attempt:cancel')!(eventFor(sender), { attemptId: 'attempt-1' })).resolves.toEqual({
      ok: true,
      value: {},
    });
    expect(assetLifecycle.invalidateAttempt).toHaveBeenLastCalledWith({ webContentsId: 47, attemptId: 'attempt-1' });
  });
  it('keeps prior asset bytes when a replacement attempt fails to start', async () => {
    const service = createService();
    service.beginAttempt.mockReturnValueOnce({
      ok: false,
      error: { kind: 'pipeline-reject', detail: 'begin failed' },
    });
    const assetLifecycle = createAssetLifecycle();
    const sender: Sender = { id: 49, once: vi.fn() };
    registerHtmlExportIpc({
      windowForWebContents: () => null,
      pipelineService: service as never,
      assetLifecycle,
    });

    const result = await ipc.handler('html:attempt:generate')!(eventFor(sender), {});
    expectCanonicalPipelineError(result, 'pipeline-reject', 'begin failed');
    expect(assetLifecycle.getActiveAttempt).toHaveBeenCalledWith(49);
    expect(assetLifecycle.invalidateAttempt).not.toHaveBeenCalled();
  });
  it.each([
    'wrong-sender',
    'stale-artifact',
    'attempt-superseded',
  ] as const)('keeps asset lifecycle intact when cancellation fails with %s', async (kind) => {
    const service = createService();
    service.invalidateAttempt.mockReturnValueOnce({
      ok: false,
      error: { kind, detail: `HTML export pipeline error: ${kind}` },
    });
    const assetLifecycle = createAssetLifecycle();
    const sender: Sender = { id: 50, once: vi.fn() };
    registerHtmlExportIpc({
      windowForWebContents: () => null,
      pipelineService: service as never,
      assetLifecycle,
    });

    await expect(ipc.handler('html:attempt:cancel')!(eventFor(sender), { attemptId: 'attempt-1' })).resolves.toStrictEqual({
      ok: false,
      error: { kind, detail: `HTML export pipeline error: ${kind}` },
    });
    expect(service.invalidateAttempt).toHaveBeenCalledWith(50, 'attempt-1');
    expect(assetLifecycle.invalidateAttempt).not.toHaveBeenCalled();
  });

  it('invalidates pipeline and asset state once when its webContents is destroyed', async () => {
    const service = createService();
    const assetLifecycle = createAssetLifecycle();
    const sender: Sender = { id: 43, once: vi.fn() };
    registerHtmlExportIpc({
      windowForWebContents: () => null,
      pipelineService: service as never,
      assetLifecycle,
    });

    await ipc.handler('html:attempt:generate')!(eventFor(sender), {});
    await ipc.handler('html:attempt:generate')!(eventFor(sender), {});

    expect(sender.once).toHaveBeenCalledTimes(1);
    expect(sender.once).toHaveBeenCalledWith('destroyed', expect.any(Function));
    const destroyed = sender.once.mock.calls[0][1] as () => void;
    destroyed();
    expect(service.invalidateSender).toHaveBeenCalledTimes(1);
    expect(service.invalidateSender).toHaveBeenCalledWith(43);
    expect(assetLifecycle.releaseWebContents).toHaveBeenCalledTimes(1);
    expect(assetLifecycle.releaseWebContents).toHaveBeenCalledWith(43);
  });
  it('fences in-flight work and stale cleanup when a webContents id is reused', async () => {
    const service = createService();
    const assetLifecycle = createNoopAssetLifecycle();
    const oldSender: Sender = { id: 43, once: vi.fn() };
    const newSender: Sender = { id: 43, once: vi.fn() };
    let finishOldAttempt!: (result: { ok: true; value: { attemptId: string } }) => void;
    service.beginAttempt.mockImplementationOnce(
      () => new Promise((resolve) => {
        finishOldAttempt = resolve;
      }),
    );
    registerHtmlExportIpc({
      windowForWebContents: () => null,
      pipelineService: service as never,
      assetLifecycle,
    });

    const oldRun = ipc.handler('html:attempt:generate')!(eventFor(oldSender), {});
    await vi.waitFor(() => expect(service.beginAttempt).toHaveBeenCalledTimes(1));

    await expect(ipc.handler('html:attempt:generate')!(eventFor(newSender), {})).resolves.toEqual({
      ok: true,
      value: { attemptId: 'attempt-1' },
    });
    finishOldAttempt({ ok: true, value: { attemptId: 'attempt-old-incarnation' } });
    expectCanonicalPipelineReject(await oldRun);

    expect(service.invalidateSender).toHaveBeenCalledExactlyOnceWith(43);
    expect(assetLifecycle.releaseWebContents).toHaveBeenCalledExactlyOnceWith(43);
    expect(service.invalidateAttempt).toHaveBeenCalledWith(43, 'attempt-old-incarnation');
    expect(assetLifecycle.invalidateAttempt).toHaveBeenCalledWith({
      webContentsId: 43,
      attemptId: 'attempt-old-incarnation',
    });

    const oldDestroyed = oldSender.once.mock.calls[0][1] as () => void;
    const newDestroyed = newSender.once.mock.calls[0][1] as () => void;
    oldDestroyed();
    expect(service.invalidateSender).toHaveBeenCalledTimes(1);
    expect(assetLifecycle.releaseWebContents).toHaveBeenCalledTimes(1);

    newDestroyed();
    expect(service.invalidateSender).toHaveBeenCalledTimes(2);
    expect(assetLifecycle.releaseWebContents).toHaveBeenCalledTimes(2);
  });
  it('waits for destroyed-sender cleanup before reusing the same webContents id', async () => {
    const service = createService();
    const assetLifecycle = createNoopAssetLifecycle();
    const oldSender: Sender = { id: 67, once: vi.fn() };
    const newSender: Sender = { id: 67, once: vi.fn() };
    let finishCleanup!: () => void;
    service.invalidateSender.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        finishCleanup = resolve;
      }),
    );
    registerHtmlExportIpc({
      windowForWebContents: () => null,
      pipelineService: service as never,
      assetLifecycle,
    });

    await ipc.handler('html:attempt:generate')!(eventFor(oldSender), {});
    const oldDestroyed = oldSender.once.mock.calls[0][1] as () => void;
    oldDestroyed();

    const replacementRun = ipc.handler('html:attempt:generate')!(eventFor(newSender), {});
    await Promise.resolve();
    expect(service.beginAttempt).toHaveBeenCalledTimes(1);

    finishCleanup();
    await expect(replacementRun).resolves.toEqual({
      ok: true,
      value: { attemptId: 'attempt-1' },
    });
    expect(service.beginAttempt).toHaveBeenCalledTimes(2);
  });
  it('retains a failed cleanup tombstone and rejects same-id rebinding', async () => {
    const service = createService();
    const assetLifecycle = createNoopAssetLifecycle();
    const oldSender: Sender = { id: 69, once: vi.fn() };
    const newSender: Sender = { id: 69, once: vi.fn() };
    registerHtmlExportIpc({
      windowForWebContents: () => null,
      pipelineService: service as never,
      assetLifecycle,
    });

    await ipc.handler('html:attempt:generate')!(eventFor(oldSender), {});
    service.invalidateSender.mockImplementationOnce(() => {
      throw new Error('cleanup failed');
    });
    const oldDestroyed = oldSender.once.mock.calls[0][1] as () => void;
    oldDestroyed();

    expectCanonicalPipelineReject(
      await ipc.handler('html:attempt:generate')!(eventFor(newSender), {}),
    );
    expect(service.beginAttempt).toHaveBeenCalledTimes(1);
    expect(assetLifecycle.releaseWebContents).toHaveBeenCalledExactlyOnceWith(69);
  });
  it('releases assets even when destroyed pipeline cleanup throws private-path errors', () => {
    const service = createService();
    service.invalidateSender.mockImplementationOnce(() => {
      throw new Error('private sender cleanup at /private/pipeline/secret.html');
    });
    const assetLifecycle = createAssetLifecycle();
    const sender: Sender = { id: 55, once: vi.fn() };
    registerHtmlExportIpc({
      windowForWebContents: () => null,
      pipelineService: service as never,
      assetLifecycle,
    });

    ipc.handler('html:attempt:generate')!(eventFor(sender), {});
    const destroyed = sender.once.mock.calls[0][1] as () => void;
    expect(destroyed).not.toThrow();
    expect(service.invalidateSender).toHaveBeenCalledExactlyOnceWith(55);
    expect(assetLifecycle.releaseWebContents).toHaveBeenCalledExactlyOnceWith(55);
  });
  it('keeps destroyed sender cleanup nonthrowing when asset release throws', () => {
    const service = createService();
    const assetLifecycle = createAssetLifecycle();
    assetLifecycle.releaseWebContents.mockImplementationOnce(() => {
      throw new Error('private asset release at /private/assets/secret.png');
    });
    const sender: Sender = { id: 59, once: vi.fn() };
    registerHtmlExportIpc({
      windowForWebContents: () => null,
      pipelineService: service as never,
      assetLifecycle,
    });

    ipc.handler('html:attempt:generate')!(eventFor(sender), {});
    const destroyed = sender.once.mock.calls[0][1] as () => void;
    expect(destroyed).not.toThrow();
    expect(service.invalidateSender).toHaveBeenCalledExactlyOnceWith(59);
    expect(assetLifecycle.releaseWebContents).toHaveBeenCalledExactlyOnceWith(59);
  });

  it('does not mutate asset lifecycle for malformed requests and keeps legacy HTML export handlers registered', async () => {
    const service = createService();
    const assetLifecycle = createAssetLifecycle();
    const sender: Sender = { id: 48, once: vi.fn() };
    registerHtmlExportIpc({
      windowForWebContents: () => null,
      pipelineService: service as never,
      assetLifecycle,
    });

    await ipc.handler('html:attempt:generate')!(eventFor(sender), { bytes: 'renderer bytes' });
    await ipc.handler('html:attempt:cancel')!(eventFor(sender), { attemptId: 'invalid/path' });

    expect(assetLifecycle.getActiveAttempt).not.toHaveBeenCalled();
    expect(assetLifecycle.invalidateAttempt).not.toHaveBeenCalled();
    expect(assetLifecycle.releaseWebContents).not.toHaveBeenCalled();
    expect(ipc.handler('design:fetch')).toBeDefined();
    expect(ipc.handler('design:list')).toBeDefined();
    expect(ipc.handler('html:save')).toBeDefined();
    expect(ipc.handler('html:open-saved')).toBeDefined();
  });

  it('keeps legacy save and open behavior fail-closed', async () => {
    const service = createService();
    const sender: Sender = { id: 45, once: vi.fn() };
    registerHtmlExportIpc({
      windowForWebContents: () => null,
      pipelineService: service as never,
      assetLifecycle: createNoopAssetLifecycle(),
    });

    const save = await ipc.handler('html:save')!(eventFor(sender), {
      html: '<!doctype html><p>legacy</p>',
      defaultName: 'legacy.html',
    });
    const open = await ipc.handler('html:open-saved')!(eventFor(sender), 'not-html.txt');

    expect(save).toStrictEqual({ saved: false });
    expect(open).toStrictEqual({ opened: false, error: 'Not an openable HTML file.' });
  });
  it('finalizes on quarantine PASS and returns finalizedArtifactId', async () => {
    const service = createService();
    const quarantine = createQuarantine(true);
    const sender: Sender = { id: 71, once: vi.fn() };
    registerHtmlExportIpc({
      windowForWebContents: () => null,
      pipelineService: service as never,
      assetLifecycle: createNoopAssetLifecycle(),
      quarantine,
    });

    const result = await ipc.handler('html:quarantine:measure')!(eventFor(sender), {
      attemptId: 'attempt-1',
      resolvedArtifactId: 'resolved-1',
    });

    expect(quarantine.measure).toHaveBeenCalledWith(71, 'attempt-1', 'resolved-1');
    expect(service.finalize).toHaveBeenCalledWith(71, 'attempt-1', 'resolved-1');
    expect(result).toMatchObject({
      ok: true,
      value: {
        verdict: 'pass',
        finalizedArtifactId: 'finalized-1',
      },
    });
    expect(quarantine.cancelAttempt).not.toHaveBeenCalled();
  });

  it('does not finalize when quarantine returns a typed error', async () => {
    const service = createService();
    const quarantine = createQuarantine(false);
    const sender: Sender = { id: 72, once: vi.fn() };
    registerHtmlExportIpc({
      windowForWebContents: () => null,
      pipelineService: service as never,
      assetLifecycle: createNoopAssetLifecycle(),
      quarantine,
    });

    const result = await ipc.handler('html:quarantine:measure')!(eventFor(sender), {
      attemptId: 'attempt-1',
      resolvedArtifactId: 'resolved-1',
    });

    expect(service.finalize).not.toHaveBeenCalled();
    expect(result).toStrictEqual({
      ok: false,
      error: { kind: 'layout-violation', detail: 'HTML export quarantine error: layout-violation' },
    });
  });

  it('returns recoverable-failure and cancels measure when finalize fails', async () => {
    const service = createService();
    service.finalize.mockReturnValueOnce({
      ok: false,
      error: { kind: 'pipeline-reject', detail: 'HTML export pipeline error: pipeline-reject' },
    });
    const quarantine = createQuarantine(true);
    const sender: Sender = { id: 73, once: vi.fn() };
    registerHtmlExportIpc({
      windowForWebContents: () => null,
      pipelineService: service as never,
      assetLifecycle: createNoopAssetLifecycle(),
      quarantine,
    });

    const result = await ipc.handler('html:quarantine:measure')!(eventFor(sender), {
      attemptId: 'attempt-1',
      resolvedArtifactId: 'resolved-1',
    });

    expect(service.finalize).toHaveBeenCalledWith(73, 'attempt-1', 'resolved-1');
    expect(quarantine.cancelAttempt).toHaveBeenCalledWith(73, 'attempt-1');
    expect(result).toStrictEqual({
      ok: false,
      error: {
        kind: 'recoverable-failure',
        detail: 'HTML export quarantine error: recoverable-failure',
      },
    });
  });

  it('returns quarantine-unavailable without finalize when quarantine dep is absent', async () => {
    const service = createService();
    const sender: Sender = { id: 74, once: vi.fn() };
    registerHtmlExportIpc({
      windowForWebContents: () => null,
      pipelineService: service as never,
      assetLifecycle: createNoopAssetLifecycle(),
    });

    const result = await ipc.handler('html:quarantine:measure')!(eventFor(sender), {
      attemptId: 'attempt-1',
      resolvedArtifactId: 'resolved-1',
    });

    expect(service.finalize).not.toHaveBeenCalled();
    expect(result).toStrictEqual({
      ok: false,
      error: {
        kind: 'quarantine-unavailable',
        detail: 'HTML export quarantine error: quarantine-unavailable',
      },
    });
  });

  describe('html:save-finalized (AC-M1d)', () => {
    function createSaveBackend() {
      const writes: Array<{ path: string; data: string; mode?: number }> = [];
      const backend = {
        mkdir: vi.fn(async () => {}),
        writeFile: vi.fn(async (p: string, data: string | Buffer, mode?: number) => {
          writes.push({ path: p, data: Buffer.isBuffer(data) ? data.toString('utf8') : String(data), mode });
        }),
        fsyncFile: vi.fn(async () => {}),
        rename: vi.fn(async () => {}),
        unlink: vi.fn(async () => {}),
        fsyncDir: vi.fn(async () => {}),
        randomId: vi.fn(() => 'testid'),
      };
      return Object.assign(backend, { writes });
    }
    const fakeWin = {} as never;
    function setDialog(impl: unknown) {
      (dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = impl;
    }

    it('atomic-writes the main-held finalized bytes and returns the finalized digest', async () => {
      const service = createService();
      const backend = createSaveBackend();
      setDialog(vi.fn(async () => ({ canceled: false, filePath: '/tmp/out.html' })));
      const sender: Sender = { id: 81, once: vi.fn() };
      registerHtmlExportIpc({
        windowForWebContents: () => fakeWin,
        pipelineService: service as never,
        assetLifecycle: createNoopAssetLifecycle(),
        saveBackend: backend as never,
      });

      const result = await ipc.handler('html:save-finalized')!(eventFor(sender), {
        attemptId: 'attempt-1',
        finalizedArtifactId: 'finalized-1',
        defaultName: 'report.html',
      });

      expect(result).toStrictEqual({ saved: true, filePath: '/tmp/out.html', sha256: 'b'.repeat(64) });
      expect(service.readFinalizedArtifact).toHaveBeenCalledWith(81, 'attempt-1', 'finalized-1');
      expect(backend.writes).toHaveLength(1);
      expect(backend.writes[0]!.data).toBe('<!doctype html><p>final</p>');
      // Atomic write path: temp then rename (never a direct write to target).
      expect(backend.rename).toHaveBeenCalledWith('/tmp/out.html.testid.tmp', '/tmp/out.html');
      // Exported HTML is user-shareable (0o644), not the 0o600 secret-store default.
      expect(backend.writes[0]!.mode).toBe(0o644);
    });

    it('appends .html when the chosen path lacks the extension', async () => {
      const service = createService();
      const backend = createSaveBackend();
      setDialog(vi.fn(async () => ({ canceled: false, filePath: '/tmp/report' })));
      const sender: Sender = { id: 82, once: vi.fn() };
      registerHtmlExportIpc({
        windowForWebContents: () => fakeWin,
        pipelineService: service as never,
        assetLifecycle: createNoopAssetLifecycle(),
        saveBackend: backend as never,
      });

      const result = await ipc.handler('html:save-finalized')!(eventFor(sender), {
        attemptId: 'attempt-1',
        finalizedArtifactId: 'finalized-1',
      });

      expect(result).toStrictEqual({ saved: true, filePath: '/tmp/report.html', sha256: 'b'.repeat(64) });
    });

    it('never writes and never opens a dialog when the finalized artifact is unresolved', async () => {
      const service = createService();
      service.readFinalizedArtifact.mockReturnValueOnce({
        ok: false,
        error: { kind: 'unknown-artifact', detail: 'HTML export pipeline error: unknown-artifact' },
      } as never);
      const backend = createSaveBackend();
      const dialogSpy = vi.fn(async () => ({ canceled: false, filePath: '/tmp/out.html' }));
      setDialog(dialogSpy);
      const sender: Sender = { id: 83, once: vi.fn() };
      registerHtmlExportIpc({
        windowForWebContents: () => fakeWin,
        pipelineService: service as never,
        assetLifecycle: createNoopAssetLifecycle(),
        saveBackend: backend as never,
      });

      const result = await ipc.handler('html:save-finalized')!(eventFor(sender), {
        attemptId: 'attempt-1',
        finalizedArtifactId: 'finalized-1',
      });

      expect(result).toStrictEqual({ saved: false });
      expect(dialogSpy).not.toHaveBeenCalled();
      expect(backend.writes).toHaveLength(0);
    });

    it('returns saved:false without writing when the save dialog is canceled', async () => {
      const service = createService();
      const backend = createSaveBackend();
      setDialog(vi.fn(async () => ({ canceled: true, filePath: undefined })));
      const sender: Sender = { id: 84, once: vi.fn() };
      registerHtmlExportIpc({
        windowForWebContents: () => fakeWin,
        pipelineService: service as never,
        assetLifecycle: createNoopAssetLifecycle(),
        saveBackend: backend as never,
      });

      const result = await ipc.handler('html:save-finalized')!(eventFor(sender), {
        attemptId: 'attempt-1',
        finalizedArtifactId: 'finalized-1',
      });

      expect(result).toStrictEqual({ saved: false });
      expect(backend.writes).toHaveLength(0);
    });

    it('rejects a byte-bearing or malformed request before touching the pipeline', async () => {
      const service = createService();
      const backend = createSaveBackend();
      const dialogSpy = vi.fn(async () => ({ canceled: false, filePath: '/tmp/out.html' }));
      setDialog(dialogSpy);
      const sender: Sender = { id: 85, once: vi.fn() };
      registerHtmlExportIpc({
        windowForWebContents: () => fakeWin,
        pipelineService: service as never,
        assetLifecycle: createNoopAssetLifecycle(),
        saveBackend: backend as never,
      });

      for (const malformed of [
        { attemptId: 'attempt-1', finalizedArtifactId: 'finalized-1', html: '<p>bytes</p>' },
        { attemptId: 'attempt-1', finalizedArtifactId: 'finalized-1', defaultName: 42 },
        { attemptId: 'attempt-1' },
        { attemptId: 'a b', finalizedArtifactId: 'finalized-1' },
      ]) {
        const result = await ipc.handler('html:save-finalized')!(eventFor(sender), malformed);
        expect(result).toStrictEqual({ saved: false });
      }
      expect(service.readFinalizedArtifact).not.toHaveBeenCalled();
      expect(dialogSpy).not.toHaveBeenCalled();
      expect(backend.writes).toHaveLength(0);
    });

    it('reports a failed atomic write without leaving a partial file (saved:false + error)', async () => {
      const service = createService();
      const backend = createSaveBackend();
      backend.writeFile.mockRejectedValueOnce(new Error('disk full'));
      setDialog(vi.fn(async () => ({ canceled: false, filePath: '/tmp/out.html' })));
      const sender: Sender = { id: 86, once: vi.fn() };
      registerHtmlExportIpc({
        windowForWebContents: () => fakeWin,
        pipelineService: service as never,
        assetLifecycle: createNoopAssetLifecycle(),
        saveBackend: backend as never,
      });

      const result = await ipc.handler('html:save-finalized')!(eventFor(sender), {
        attemptId: 'attempt-1',
        finalizedArtifactId: 'finalized-1',
      });

      expect(result).toStrictEqual({ saved: false, error: 'write-failed' });
      // The temp file is unlinked on failure; the target is never renamed into place.
      expect(backend.unlink).toHaveBeenCalledWith('/tmp/out.html.testid.tmp');
      expect(backend.rename).not.toHaveBeenCalled();
    });


    it('re-reads the finalized artifact after the dialog and fails closed if it was superseded', async () => {
      const service = createService();
      const backend = createSaveBackend();
      const okValue = {
        ok: true as const,
        value: { bytes: Buffer.from('<!doctype html><p>final</p>', 'utf8'), sha256: 'b'.repeat(64), byteLength: 27 },
      };
      // Preflight read succeeds (dialog opens); the post-dialog re-read fails
      // because the attempt was superseded/tombstoned while the dialog was open.
      service.readFinalizedArtifact
        .mockReturnValueOnce(okValue as never)
        .mockReturnValueOnce({
          ok: false,
          error: { kind: 'stale-artifact', detail: 'HTML export pipeline error: stale-artifact' },
        } as never);
      setDialog(vi.fn(async () => ({ canceled: false, filePath: '/tmp/out.html' })));
      const sender: Sender = { id: 87, once: vi.fn() };
      registerHtmlExportIpc({
        windowForWebContents: () => fakeWin,
        pipelineService: service as never,
        assetLifecycle: createNoopAssetLifecycle(),
        saveBackend: backend as never,
      });

      const result = await ipc.handler('html:save-finalized')!(eventFor(sender), {
        attemptId: 'attempt-1',
        finalizedArtifactId: 'finalized-1',
      });

      expect(result).toStrictEqual({ saved: false });
      expect(service.readFinalizedArtifact).toHaveBeenCalledTimes(2);
      expect(backend.writes).toHaveLength(0);
      expect(backend.rename).not.toHaveBeenCalled();
    });

    it('rejects a request whose required ids are prototype-inherited, not own keys', async () => {
      const service = createService();
      const backend = createSaveBackend();
      const dialogSpy = vi.fn(async () => ({ canceled: false, filePath: '/tmp/out.html' }));
      setDialog(dialogSpy);
      const sender: Sender = { id: 88, once: vi.fn() };
      registerHtmlExportIpc({
        windowForWebContents: () => fakeWin,
        pipelineService: service as never,
        assetLifecycle: createNoopAssetLifecycle(),
        saveBackend: backend as never,
      });

      const inherited = Object.create({ attemptId: 'attempt-1', finalizedArtifactId: 'finalized-1' }) as object;
      const result = await ipc.handler('html:save-finalized')!(eventFor(sender), inherited);

      expect(result).toStrictEqual({ saved: false });
      expect(service.readFinalizedArtifact).not.toHaveBeenCalled();
      expect(dialogSpy).not.toHaveBeenCalled();
    });

    it('keeps the legacy html:save handler registered alongside the finalized path', async () => {
      const service = createService();
      registerHtmlExportIpc({
        windowForWebContents: () => null,
        pipelineService: service as never,
        assetLifecycle: createNoopAssetLifecycle(),
      });
      expect(ipc.handler('html:save')).toBeDefined();
      expect(ipc.handler('html:save-finalized')).toBeDefined();
    });
  });
});
