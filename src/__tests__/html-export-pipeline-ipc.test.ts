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
    invalidateAttempt: vi.fn(() => ({ ok: true as const, value: {} })),
    invalidateSender: vi.fn(),
  };
}

describe('HTML export pipeline IPC', () => {
  beforeEach(() => ipc.reset());

  it('forwards only opaque IDs to the pipeline service', async () => {
    const service = createService();
    const sender: Sender = { id: 41, once: vi.fn() };
    registerHtmlExportIpc({ windowForWebContents: () => null, pipelineService: service as never });

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
    registerHtmlExportIpc({ windowForWebContents: () => null, pipelineService: service as never });

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
    registerHtmlExportIpc({ windowForWebContents: () => null, pipelineService: service as never });

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
    registerHtmlExportIpc({ windowForWebContents: () => null, pipelineService: service as never });

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

  it.each(stableErrorKinds)('passes through a plain %s error exactly', async (kind) => {
    const service = createService();
    const sender: Sender = { id: 43, once: vi.fn() };
    const expected = {
      ok: false as const,
      error: { kind, detail: `HTML export pipeline error: ${kind}` },
    };
    service.sanitize.mockReturnValueOnce(expected);
    registerHtmlExportIpc({ windowForWebContents: () => null, pipelineService: service as never });

    const result = await ipc.handler('html:pipeline:sanitize')!(eventFor(sender), {
      attemptId: 'attempt-3',
      rawArtifactId: 'raw-3',
    });
    const error = (result as { error: unknown }).error;

    expect(result).toStrictEqual(expected);
    expect(Object.getPrototypeOf(error)).toBe(Object.prototype);
    expect(error).not.toBeInstanceOf(Error);
    expect(service.sanitize).toHaveBeenCalledWith(43, 'attempt-3', 'raw-3');
  });

  it('invalidates each sender once when its webContents is destroyed', async () => {
    const service = createService();
    const sender: Sender = { id: 43, once: vi.fn() };
    registerHtmlExportIpc({ windowForWebContents: () => null, pipelineService: service as never });

    await ipc.handler('html:attempt:generate')!(eventFor(sender), {});
    await ipc.handler('html:attempt:generate')!(eventFor(sender), {});

    expect(sender.once).toHaveBeenCalledTimes(1);
    expect(sender.once).toHaveBeenCalledWith('destroyed', expect.any(Function));
    const destroyed = sender.once.mock.calls[0][1] as () => void;
    destroyed();
    expect(service.invalidateSender).toHaveBeenCalledTimes(1);
    expect(service.invalidateSender).toHaveBeenCalledWith(43);
  });

  it('keeps the legacy HTML export handlers registered', () => {
    const service = createService();
    registerHtmlExportIpc({ windowForWebContents: () => null, pipelineService: service as never });

    expect(ipc.handler('design:fetch')).toBeDefined();
    expect(ipc.handler('design:list')).toBeDefined();
    expect(ipc.handler('html:save')).toBeDefined();
    expect(ipc.handler('html:open-saved')).toBeDefined();
  });

  it('keeps legacy save and open behavior fail-closed', async () => {
    const service = createService();
    const sender: Sender = { id: 45, once: vi.fn() };
    registerHtmlExportIpc({ windowForWebContents: () => null, pipelineService: service as never });

    const save = await ipc.handler('html:save')!(eventFor(sender), {
      html: '<!doctype html><p>legacy</p>',
      defaultName: 'legacy.html',
    });
    const open = await ipc.handler('html:open-saved')!(eventFor(sender), 'not-html.txt');

    expect(save).toStrictEqual({ saved: false });
    expect(open).toStrictEqual({ opened: false, error: 'Not an openable HTML file.' });
  });
});
