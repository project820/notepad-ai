import { beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('electron', () => ({ dialog: { showOpenDialog: vi.fn() } }));

import { registerHtmlExportAssetIpc } from '../main/ipc/html-export-asset-ipc';
import {
  HTML_ASSET_PICK_MAX_BASENAME_HINTS,
  HTML_ASSET_PICK_MAX_BASENAME_LENGTH,
  HTML_EXPORT_RETAINED_ASSET_MAX_COUNT,
} from '../shared/html-export-assets';

type Sender = { id: number };

function eventFor(sender: Sender) {
  return { sender } as never;
}

function request(overrides: Partial<{ attemptId: string; basenameHints: unknown }> = {}) {
  return {
    attemptId: 'attempt_1',
    basenameHints: [{ basename: 'from-markdown.png' }],
    ...overrides,
  };
}

function asset(assetId = 'asset_1', basename = 'selected.png') {
  return {
    assetId,
    basename,
    mime: 'image/png' as const,
    width: 10,
    height: 20,
    encodedBytes: 123,
  };
}

function createDeps(overrides: Partial<{
  activeAttempt: () => string | undefined;
  windowForWebContents: (id: number) => object | null;
  currentDocumentPathForWebContents: (id: number) => string | null | undefined;
  pickAssets: ReturnType<typeof vi.fn>;
  authorizeExistingFile: ReturnType<typeof vi.fn>;
  authorizeWriteTarget: ReturnType<typeof vi.fn>;
  grantAssetSelection: ReturnType<typeof vi.fn>;
  issueFromExplicitSelection: ReturnType<typeof vi.fn>;
  invalidateAttempt: ReturnType<typeof vi.fn>;
}> = {}) {
  const window = { marker: 'requesting-window' };
  const fileGrants = {
    authorizeExistingFile: overrides.authorizeExistingFile ?? vi.fn(async () => null),
    authorizeWriteTarget: overrides.authorizeWriteTarget ?? vi.fn(async () => null),
    grantAssetSelection: overrides.grantAssetSelection ?? vi.fn(async () => ({
      kind: 'file',
      source: 'asset-picker',
      realpath: '/authorized/selected.png',
      identity: 'identity',
      generation: 0,
    })),
  };
  const assetRegistry = {
    issueFromExplicitSelection: overrides.issueFromExplicitSelection ?? vi.fn(async () => ({ ok: true as const, asset: asset() })),
    invalidateAttempt: overrides.invalidateAttempt ?? vi.fn(),
  };
  return {
    deps: {
      windowForWebContents: overrides.windowForWebContents ?? vi.fn(() => window),
      currentDocumentPathForWebContents: overrides.currentDocumentPathForWebContents ?? vi.fn(() => null),
      fileGrants,
      assetRegistry,
      attemptRegistry: { getActiveAttempt: overrides.activeAttempt ?? vi.fn(() => 'attempt_1') },
      pickAssets: overrides.pickAssets ?? vi.fn(async () => ({ canceled: false, filePaths: ['/selection/selected.png'] })),
    },
    window,
    fileGrants,
    assetRegistry,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('HTML export asset picker IPC', () => {
  beforeEach(() => ipc.reset());

  it.each([
    ['null request', null],
    ['array request', []],
    ['inherited request fields', Object.create(request())],
    ['custom request prototype', Object.assign(Object.create({ polluted: true }), request())],
    ['extra request field', { ...request(), path: '/private/image.png' }],
    ['symbol request field', Object.assign(request(), { [Symbol('bytes')]: new Uint8Array([1]) })],
    ['missing request field', { attemptId: 'attempt_1' }],
    ['wrong hint array type', request({ basenameHints: { basename: 'image.png' } })],
    ['empty hint basename', request({ basenameHints: [{ basename: '' }] })],
    ['non-string hint basename', request({ basenameHints: [{ basename: 42 }] })],
    ['symbol hint field', request({ basenameHints: [Object.assign({ basename: 'image.png' }, { [Symbol('hint')]: true })] })],
    ['invalid empty opaque attempt ID', request({ attemptId: '' })],
    ['invalid path opaque attempt ID', request({ attemptId: '../attempt' })],
    ['invalid oversized opaque attempt ID', request({ attemptId: 'a'.repeat(129) })],
    ['raw path field', { ...request(), selectedPath: '/private/image.png' }],
    ['raw bytes field', { ...request(), bytes: new Uint8Array([1, 2, 3]) }],
    ['hint with slash', request({ basenameHints: [{ basename: 'folder/image.png' }] })],
    ['hint with backslash', request({ basenameHints: [{ basename: 'folder\\image.png' }] })],
    ['hint with NUL', request({ basenameHints: [{ basename: 'image\0.png' }] })],
    ['oversized hint', request({ basenameHints: [{ basename: 'a'.repeat(HTML_ASSET_PICK_MAX_BASENAME_LENGTH + 1) }] })],
    ['too many hints', request({ basenameHints: Array.from({ length: HTML_ASSET_PICK_MAX_BASENAME_HINTS + 1 }, () => ({ basename: 'image.png' })) })],
    ['non-plain hint', request({ basenameHints: [Object.create({ basename: 'image.png' })] })],
    ['extra hint field', request({ basenameHints: [{ basename: 'image.png', path: '/private/image.png' }] })],
  ])('rejects %s before picker, document authorization, grants, or issuance', async (_description, malformed) => {
    const { deps, fileGrants, assetRegistry } = createDeps();
    registerHtmlExportAssetIpc(deps as never);

    await expect(ipc.handler('html:asset:pick')!(eventFor({ id: 17 }), malformed)).resolves.toStrictEqual({
      ok: false,
      error: 'asset-invalid',
    });
    expect(deps.pickAssets).not.toHaveBeenCalled();
    expect(fileGrants.authorizeExistingFile).not.toHaveBeenCalled();
    expect(fileGrants.authorizeWriteTarget).not.toHaveBeenCalled();
    expect(fileGrants.grantAssetSelection).not.toHaveBeenCalled();
    expect(assetRegistry.issueFromExplicitSelection).not.toHaveBeenCalled();
  });

  it('requires the exact requesting BrowserWindow and never falls back to a focused window', async () => {
    const { deps, fileGrants } = createDeps({ windowForWebContents: vi.fn(() => null) });
    registerHtmlExportAssetIpc(deps as never);

    await expect(ipc.handler('html:asset:pick')!(eventFor({ id: 18 }), request())).resolves.toStrictEqual({
      ok: false,
      error: 'no-window',
    });
    expect(deps.windowForWebContents).toHaveBeenCalledWith(18);
    expect(deps.pickAssets).not.toHaveBeenCalled();
    expect(fileGrants.grantAssetSelection).not.toHaveBeenCalled();
  });
  it('rejects an initially stale request before document authorization or picker use', async () => {
    const { deps, fileGrants, assetRegistry } = createDeps({ activeAttempt: vi.fn(() => 'attempt_2') });
    registerHtmlExportAssetIpc(deps as never);

    await expect(ipc.handler('html:asset:pick')!(eventFor({ id: 181 }), request())).resolves.toStrictEqual({
      ok: false,
      error: 'stale-attempt',
    });
    expect(fileGrants.authorizeExistingFile).not.toHaveBeenCalled();
    expect(fileGrants.authorizeWriteTarget).not.toHaveBeenCalled();
    expect(deps.pickAssets).not.toHaveBeenCalled();
    expect(fileGrants.grantAssetSelection).not.toHaveBeenCalled();
    expect(assetRegistry.issueFromExplicitSelection).not.toHaveBeenCalled();
  });
  it('accepts exact request and selection maxima and reaches picker and asset issuance', async () => {
    const attemptId = 'a'.repeat(128);
    const selectedPaths = Array.from(
      { length: HTML_EXPORT_RETAINED_ASSET_MAX_COUNT },
      (_, index) => `/selection/${index}.png`,
    );
    const { deps, fileGrants, assetRegistry } = createDeps({
      activeAttempt: () => attemptId,
      pickAssets: vi.fn(async () => ({ canceled: false, filePaths: selectedPaths })),
    });
    registerHtmlExportAssetIpc(deps as never);

    const result = await ipc.handler('html:asset:pick')!(eventFor({ id: 182 }), request({
      attemptId,
      basenameHints: Array.from(
        { length: HTML_ASSET_PICK_MAX_BASENAME_HINTS },
        () => ({ basename: 'b'.repeat(HTML_ASSET_PICK_MAX_BASENAME_LENGTH) }),
      ),
    }));

    expect(result).toMatchObject({
      ok: true,
      assets: Array.from({ length: HTML_EXPORT_RETAINED_ASSET_MAX_COUNT }, () => asset()),
      rejected: [],
    });
    expect(deps.pickAssets).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.anything());
    expect(fileGrants.grantAssetSelection).toHaveBeenCalledTimes(HTML_EXPORT_RETAINED_ASSET_MAX_COUNT);
    expect(assetRegistry.issueFromExplicitSelection).toHaveBeenCalledTimes(HTML_EXPORT_RETAINED_ASSET_MAX_COUNT);
  });


  it('uses only main-authorized current-document state for picker options, never basename hints', async () => {
    const authorizedCurrentDocument = vi.fn(async () => ({
      grant: { realpath: '/authorized/project/document.md' },
    }));
    const { deps, window, fileGrants } = createDeps({
      currentDocumentPathForWebContents: vi.fn(() => '/renderer-claimed/current.md'),
      authorizeExistingFile: authorizedCurrentDocument,
      pickAssets: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    });
    registerHtmlExportAssetIpc(deps as never);

    await expect(ipc.handler('html:asset:pick')!(eventFor({ id: 19 }), request({
      basenameHints: [{ basename: 'untrusted-hint.png' }],
    }))).resolves.toStrictEqual({ ok: false, error: 'cancelled' });

    expect(authorizedCurrentDocument).toHaveBeenCalledWith(19, '/renderer-claimed/current.md');
    expect(fileGrants.authorizeWriteTarget).not.toHaveBeenCalled();
    expect(fileGrants.grantAssetSelection).not.toHaveBeenCalled();
    expect(deps.pickAssets).toHaveBeenCalledWith(window, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
      defaultPath: '/authorized/project',
    });

  });
  it('contains private existing-file authorization errors before picker or registry access', async () => {
    const authorizeExistingFile = vi.fn(async () => {
      throw new Error('existing authorization failed for /private/current/secret.md');
    });
    const { deps, fileGrants, assetRegistry } = createDeps({
      currentDocumentPathForWebContents: vi.fn(() => '/renderer-claimed/current.md'),
      authorizeExistingFile,
    });
    registerHtmlExportAssetIpc(deps as never);

    const result = await ipc.handler('html:asset:pick')!(eventFor({ id: 190 }), request());

    expect(result).toStrictEqual({ ok: false, error: 'asset-operation-failed' });
    expect(authorizeExistingFile).toHaveBeenCalledWith(190, '/renderer-claimed/current.md');
    expect(fileGrants.authorizeWriteTarget).not.toHaveBeenCalled();
    expect(deps.pickAssets).not.toHaveBeenCalled();
    expect(fileGrants.grantAssetSelection).not.toHaveBeenCalled();
    expect(assetRegistry.issueFromExplicitSelection).not.toHaveBeenCalled();
    expect(assetRegistry.invalidateAttempt).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/private|secret|current|path/i);
  });

  it('contains private write-target authorization errors before picker or registry access', async () => {
    const authorizeWriteTarget = vi.fn(async () => {
      throw new Error('write authorization failed for /private/current/secret.md');
    });
    const { deps, fileGrants, assetRegistry } = createDeps({
      currentDocumentPathForWebContents: vi.fn(() => '/renderer-claimed/current.md'),
      authorizeWriteTarget,
    });
    registerHtmlExportAssetIpc(deps as never);

    const result = await ipc.handler('html:asset:pick')!(eventFor({ id: 1901 }), request());

    expect(result).toStrictEqual({ ok: false, error: 'asset-operation-failed' });
    expect(fileGrants.authorizeExistingFile).toHaveBeenCalledWith(1901, '/renderer-claimed/current.md');
    expect(authorizeWriteTarget).toHaveBeenCalledWith(1901, '/renderer-claimed/current.md');
    expect(deps.pickAssets).not.toHaveBeenCalled();
    expect(fileGrants.grantAssetSelection).not.toHaveBeenCalled();
    expect(assetRegistry.issueFromExplicitSelection).not.toHaveBeenCalled();
    expect(assetRegistry.invalidateAttempt).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/private|secret|current|path/i);
  });

  it('rejects a request superseded while current-document authorization is pending without opening the picker', async () => {
    let activeAttempt = 'attempt_1';
    const authorization = deferred<{ grant: { realpath: string } } | null>();
    const authorizationStarted = deferred<void>();
    const { deps, fileGrants, assetRegistry } = createDeps({
      activeAttempt: () => activeAttempt,
      currentDocumentPathForWebContents: vi.fn(() => '/renderer-claimed/current.md'),
      authorizeExistingFile: vi.fn(() => {
        authorizationStarted.resolve();
        return authorization.promise;
      }),
    });
    registerHtmlExportAssetIpc(deps as never);

    const pending = ipc.handler('html:asset:pick')!(eventFor({ id: 191 }), request());
    await authorizationStarted.promise;
    activeAttempt = 'attempt_2';
    authorization.resolve({ grant: { realpath: '/authorized/project/current.md' } });

    await expect(pending).resolves.toStrictEqual({ ok: false, error: 'stale-attempt' });
    expect(fileGrants.authorizeWriteTarget).not.toHaveBeenCalled();
    expect(deps.pickAssets).not.toHaveBeenCalled();
    expect(fileGrants.grantAssetSelection).not.toHaveBeenCalled();
    expect(assetRegistry.issueFromExplicitSelection).not.toHaveBeenCalled();
    expect(assetRegistry.invalidateAttempt).toHaveBeenCalledTimes(1);
    expect(assetRegistry.invalidateAttempt).toHaveBeenCalledWith({ webContentsId: 191, attemptId: 'attempt_1' });
    expect(assetRegistry.invalidateAttempt).not.toHaveBeenCalledWith({ webContentsId: 191, attemptId: 'attempt_2' });
  });
  it('rejects a request superseded while current-document write authorization is pending without opening the picker', async () => {
    let activeAttempt = 'attempt_1';
    const authorization = deferred<{ scope: 'save-target'; canonicalTarget: string } | null>();
    const authorizationStarted = deferred<void>();
    const { deps, assetRegistry } = createDeps({
      activeAttempt: () => activeAttempt,
      currentDocumentPathForWebContents: vi.fn(() => '/renderer-claimed/untitled.md'),
      authorizeWriteTarget: vi.fn(() => {
        authorizationStarted.resolve();
        return authorization.promise;
      }),
    });
    registerHtmlExportAssetIpc(deps as never);

    const pending = ipc.handler('html:asset:pick')!(eventFor({ id: 192 }), request());
    await authorizationStarted.promise;
    activeAttempt = 'attempt_2';
    authorization.resolve({
      scope: 'save-target',
      canonicalTarget: '/authorized/project/untitled.md',
    });

    await expect(pending).resolves.toStrictEqual({ ok: false, error: 'stale-attempt' });
    expect(deps.pickAssets).not.toHaveBeenCalled();
    expect(deps.fileGrants.grantAssetSelection).not.toHaveBeenCalled();
    expect(assetRegistry.issueFromExplicitSelection).not.toHaveBeenCalled();
    expect(assetRegistry.invalidateAttempt).toHaveBeenCalledTimes(1);
    expect(assetRegistry.invalidateAttempt).toHaveBeenCalledWith({ webContentsId: 192, attemptId: 'attempt_1' });
    expect(assetRegistry.invalidateAttempt).not.toHaveBeenCalledWith({ webContentsId: 192, attemptId: 'attempt_2' });
  });

  it('uses no default path when main cannot authorize the current document', async () => {
    const { deps } = createDeps({
      currentDocumentPathForWebContents: vi.fn(() => '/renderer-claimed/current.md'),
      pickAssets: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    });
    registerHtmlExportAssetIpc(deps as never);

    await ipc.handler('html:asset:pick')!(eventFor({ id: 20 }), request({
      basenameHints: [{ basename: 'not-a-default-path.png' }],
    }));

    expect(deps.pickAssets).toHaveBeenCalledWith(expect.anything(), {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    });
  });
  it('uses a save-target grant as the picker default when no existing-file grant is available', async () => {
    const { deps, fileGrants, window } = createDeps({
      currentDocumentPathForWebContents: vi.fn(() => '/renderer-claimed/untitled.md'),
      authorizeWriteTarget: vi.fn(async () => ({
        scope: 'save-target',
        canonicalTarget: '/authorized/exports/untitled.md',
      })),
      pickAssets: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    });
    registerHtmlExportAssetIpc(deps as never);

    await expect(ipc.handler('html:asset:pick')!(eventFor({ id: 201 }), request())).resolves.toStrictEqual({
      ok: false,
      error: 'cancelled',
    });
    expect(fileGrants.authorizeWriteTarget).toHaveBeenCalledWith(201, '/renderer-claimed/untitled.md');
    expect(deps.pickAssets).toHaveBeenCalledWith(window, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
      defaultPath: '/authorized/exports',
    });
  });

  it.each(['direct', 'workspace'] as const)('does not use a %s write grant as the picker default', async (scope) => {
    const { deps } = createDeps({
      currentDocumentPathForWebContents: vi.fn(() => '/renderer-claimed/current.md'),
      authorizeWriteTarget: vi.fn(async () => ({
        scope,
        canonicalTarget: '/unauthorized/default/current.md',
      })),
      pickAssets: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    });
    registerHtmlExportAssetIpc(deps as never);

    await expect(ipc.handler('html:asset:pick')!(eventFor({ id: 202 }), request())).resolves.toStrictEqual({
      ok: false,
      error: 'cancelled',
    });
    expect(deps.pickAssets).toHaveBeenCalledWith(expect.anything(), {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    });
  });


  it('returns pathless multi-selection summaries and independent pathless rejections', async () => {
    const grantAssetSelection = vi.fn(async (_senderId: number, selectedPath: string) => {
      if (selectedPath.endsWith('invalid.gif')) return null;
      return { kind: 'file', source: 'asset-picker', realpath: selectedPath, identity: selectedPath };
    });
    const issueFromExplicitSelection = vi.fn(async (_owner: unknown, grant: { realpath: string }) => {
      if (grant.realpath.endsWith('large.webp')) return { ok: false as const, error: 'asset-too-large' };
      return { ok: true as const, asset: asset('asset_ok', 'chosen.png') };
    });
    const { deps } = createDeps({
      grantAssetSelection,
      issueFromExplicitSelection,
      pickAssets: vi.fn(async () => ({
        canceled: false,
        filePaths: ['/selection/chosen.png', '/selection/invalid.gif', '/selection/large.webp'],
      })),
    });
    registerHtmlExportAssetIpc(deps as never);

    const result = await ipc.handler('html:asset:pick')!(eventFor({ id: 21 }), request());

    expect(result).toStrictEqual({
      ok: true,
      assets: [asset('asset_ok', 'chosen.png')],
      rejected: [
        { basename: 'invalid.gif', error: 'asset-invalid' },
        { basename: 'large.webp', error: 'asset-too-large' },
      ],
    });
    expect(Object.keys((result as { assets: Array<Record<string, unknown>> }).assets[0]).sort()).toEqual([
      'assetId',
      'basename',
      'encodedBytes',
      'height',
      'mime',
      'width',
    ]);
    expect(JSON.stringify(result)).not.toMatch(/selection|realpath|identity|error details/i);
  });
  it('propagates only the explicit picker selection under literal owner metadata', async () => {
    const selectedPath = '/private/picker-only/selected.png';
    const explicitGrant = {
      kind: 'file' as const,
      source: 'asset-picker' as const,
      realpath: selectedPath,
      identity: 'picker-identity',
      generation: 0,
    };
    const grantAssetSelection = vi.fn(async () => explicitGrant);
    const issueFromExplicitSelection = vi.fn(async () => ({ ok: true as const, asset: asset('asset-picked', 'selected.png') }));
    const { deps } = createDeps({
      activeAttempt: () => 'attempt_explicit_owner',
      grantAssetSelection,
      issueFromExplicitSelection,
      pickAssets: vi.fn(async () => ({ canceled: false, filePaths: [selectedPath] })),
    });
    registerHtmlExportAssetIpc(deps as never);

    await expect(ipc.handler('html:asset:pick')!(eventFor({ id: 210 }), request({
      attemptId: 'attempt_explicit_owner',
      basenameHints: [{ basename: 'unrelated-hint.gif' }],
    }))).resolves.toStrictEqual({
      ok: true,
      assets: [asset('asset-picked', 'selected.png')],
      rejected: [],
    });

    expect(grantAssetSelection).toHaveBeenCalledExactlyOnceWith(210, selectedPath);
    expect(issueFromExplicitSelection).toHaveBeenCalledExactlyOnceWith(
      { webContentsId: 210, attemptId: 'attempt_explicit_owner' },
      explicitGrant,
    );
  });
  it('atomically rejects selected files above the retained-asset maximum before granting or issuing any asset', async () => {
    const { deps, fileGrants, assetRegistry } = createDeps({
      pickAssets: vi.fn(async () => ({
        canceled: false,
        filePaths: Array.from(
          { length: HTML_EXPORT_RETAINED_ASSET_MAX_COUNT + 1 },
          (_, index) => `/private/picker/${index}.png`,
        ),
      })),
    });
    registerHtmlExportAssetIpc(deps as never);

    const result = await ipc.handler('html:asset:pick')!(eventFor({ id: 211 }), request());
    expect(result).toStrictEqual({ ok: false, error: 'asset-budget-exceeded' });
    expect(JSON.stringify(result)).not.toMatch(/private|picker|path/i);
    expect(fileGrants.grantAssetSelection).not.toHaveBeenCalled();
    expect(assetRegistry.issueFromExplicitSelection).not.toHaveBeenCalled();
  });

  it('maps issuance errors and picker errors without exposing paths, bytes, identities, or OS errors', async () => {
    const issueFromExplicitSelection = vi.fn()
      .mockResolvedValueOnce({ ok: false as const, error: 'identity-mismatch' })
      .mockResolvedValueOnce({ ok: false as const, error: 'read-failed' });
    const { deps } = createDeps({
      issueFromExplicitSelection,
      pickAssets: vi.fn(async () => ({ canceled: false, filePaths: ['/selection/changed.png', '/selection/broken.png'] })),
    });
    registerHtmlExportAssetIpc(deps as never);

    await expect(ipc.handler('html:asset:pick')!(eventFor({ id: 22 }), request())).resolves.toStrictEqual({
      ok: true,
      assets: [],
      rejected: [
        { basename: 'changed.png', error: 'asset-changed' },
        { basename: 'broken.png', error: 'asset-operation-failed' },
      ],
    });

    const pickerFails = createDeps({ pickAssets: vi.fn(async () => { throw new Error('OS path /private/secret.png failed'); }) });
    ipc.reset();
    registerHtmlExportAssetIpc(pickerFails.deps as never);
    const error = await ipc.handler('html:asset:pick')!(eventFor({ id: 23 }), request());
    expect(error).toStrictEqual({ ok: false, error: 'picker-failed' });
    expect(JSON.stringify(error)).not.toMatch(/private|secret|path|OS/i);
  });
  it('converts thrown grant and issuance errors into pathless generic rejections', async () => {
    const grantAssetSelection = vi.fn()
      .mockRejectedValueOnce(new Error('grant failed for /private/grant-secret.png'))
      .mockResolvedValueOnce({
        kind: 'file',
        source: 'asset-picker',
        realpath: '/private/issue-secret.png',
        identity: 'private-identity',
      });
    const issueFromExplicitSelection = vi.fn()
      .mockRejectedValueOnce(new Error('issuance failed for /private/issue-secret.png'));
    const { deps } = createDeps({
      grantAssetSelection,
      issueFromExplicitSelection,
      pickAssets: vi.fn(async () => ({
        canceled: false,
        filePaths: ['/chosen/grant.png', '/chosen/issue.png'],
      })),
    });
    registerHtmlExportAssetIpc(deps as never);

    const result = await ipc.handler('html:asset:pick')!(eventFor({ id: 231 }), request());

    expect(result).toStrictEqual({
      ok: true,
      assets: [],
      rejected: [
        { basename: 'grant.png', error: 'asset-operation-failed' },
        { basename: 'issue.png', error: 'asset-operation-failed' },
      ],
    });
    expect(issueFromExplicitSelection).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toMatch(/private|secret|identity|chosen/i);
  });


  it('fails stale and invalidates assets when superseded while the picker is pending', async () => {
    let activeAttempt = 'attempt_1';
    const selection = deferred<{ readonly canceled: boolean; readonly filePaths: readonly string[] }>();
    const pickerStarted = deferred<void>();
    const { deps, fileGrants, assetRegistry } = createDeps({
      activeAttempt: () => activeAttempt,
      pickAssets: vi.fn(() => {
        pickerStarted.resolve();
        return selection.promise;
      }),
    });
    registerHtmlExportAssetIpc(deps as never);

    const pending = ipc.handler('html:asset:pick')!(eventFor({ id: 24 }), request());
    await pickerStarted.promise;
    activeAttempt = 'attempt_2';
    selection.resolve({ canceled: false, filePaths: ['/selection/late.png'] });

    await expect(pending).resolves.toStrictEqual({ ok: false, error: 'stale-attempt' });
    expect(fileGrants.grantAssetSelection).not.toHaveBeenCalled();
    expect(assetRegistry.invalidateAttempt).toHaveBeenCalledWith({ webContentsId: 24, attemptId: 'attempt_1' });
  });
  it('contains a stale picker rejection without paths and invalidates only the old owner once', async () => {
    let activeAttempt = 'attempt_1';
    const picker = deferred<{ readonly canceled: boolean; readonly filePaths: readonly string[] }>();
    const pickerStarted = deferred<void>();
    const { deps, fileGrants, assetRegistry } = createDeps({
      activeAttempt: () => activeAttempt,
      pickAssets: vi.fn(() => {
        pickerStarted.resolve();
        return picker.promise;
      }),
    });
    registerHtmlExportAssetIpc(deps as never);

    const pending = ipc.handler('html:asset:pick')!(eventFor({ id: 242 }), request());
    await pickerStarted.promise;
    activeAttempt = 'attempt_2';
    picker.reject(new Error('picker failed for /private/late-selection.png'));

    const result = await pending;
    expect(result).toStrictEqual({ ok: false, error: 'stale-attempt' });
    expect(JSON.stringify(result)).not.toMatch(/private|late|path/i);
    expect(assetRegistry.invalidateAttempt).toHaveBeenCalledTimes(1);
    expect(assetRegistry.invalidateAttempt).toHaveBeenCalledWith({ webContentsId: 242, attemptId: 'attempt_1' });
    expect(assetRegistry.invalidateAttempt).not.toHaveBeenCalledWith({ webContentsId: 242, attemptId: 'attempt_2' });
    expect(fileGrants.grantAssetSelection).not.toHaveBeenCalled();
    expect(assetRegistry.issueFromExplicitSelection).not.toHaveBeenCalled();
  });
  it('fails stale and invalidates assets when superseded while selection authorization is pending', async () => {
    let activeAttempt = 'attempt_1';
    const grant = deferred<{ kind: string; source: string; realpath: string; identity: string } | null>();
    const grantStarted = deferred<void>();
    const { deps, assetRegistry } = createDeps({
      activeAttempt: () => activeAttempt,
      grantAssetSelection: vi.fn(() => {
        grantStarted.resolve();
        return grant.promise;
      }),
    });
    registerHtmlExportAssetIpc(deps as never);

    const pending = ipc.handler('html:asset:pick')!(eventFor({ id: 241 }), request());
    await grantStarted.promise;
    activeAttempt = 'attempt_2';
    grant.resolve({
      kind: 'file',
      source: 'asset-picker',
      realpath: '/authorized/late.png',
      identity: 'late-identity',
    });

    await expect(pending).resolves.toStrictEqual({ ok: false, error: 'stale-attempt' });
    expect(assetRegistry.issueFromExplicitSelection).not.toHaveBeenCalled();
    expect(assetRegistry.invalidateAttempt).toHaveBeenCalledWith({ webContentsId: 241, attemptId: 'attempt_1' });
  });
  it('contains a stale rejected final grant without invalidating its replacement owner', async () => {
    let activeAttempt = 'attempt_1';
    const grant = deferred<null>();
    const grantStarted = deferred<void>();
    const { deps, assetRegistry } = createDeps({
      activeAttempt: () => activeAttempt,
      grantAssetSelection: vi.fn(() => {
        grantStarted.resolve();
        return grant.promise;
      }),
    });
    registerHtmlExportAssetIpc(deps as never);

    const pending = ipc.handler('html:asset:pick')!(eventFor({ id: 243 }), request());
    await grantStarted.promise;
    activeAttempt = 'attempt_2';
    grant.resolve(null);

    const result = await pending;
    expect(result).toStrictEqual({ ok: false, error: 'stale-attempt' });
    expect(JSON.stringify(result)).not.toMatch(/authorized|selection|path/i);
    expect(assetRegistry.invalidateAttempt).toHaveBeenCalledTimes(1);
    expect(assetRegistry.invalidateAttempt).toHaveBeenCalledWith({ webContentsId: 243, attemptId: 'attempt_1' });
    expect(assetRegistry.invalidateAttempt).not.toHaveBeenCalledWith({ webContentsId: 243, attemptId: 'attempt_2' });
    expect(assetRegistry.issueFromExplicitSelection).not.toHaveBeenCalled();
  });

  it('fails stale and invalidates assets when superseded while issuance is pending', async () => {
    let activeAttempt = 'attempt_1';
    const issuance = deferred<{ readonly ok: true; readonly asset: ReturnType<typeof asset> }>();
    const issuanceStarted = deferred<void>();
    const { deps, assetRegistry } = createDeps({
      activeAttempt: () => activeAttempt,
      issueFromExplicitSelection: vi.fn(() => {
        issuanceStarted.resolve();
        return issuance.promise;
      }),
    });
    registerHtmlExportAssetIpc(deps as never);

    const pending = ipc.handler('html:asset:pick')!(eventFor({ id: 25 }), request());
    await issuanceStarted.promise;
    activeAttempt = 'attempt_2';
    issuance.resolve({ ok: true, asset: asset() });

    await expect(pending).resolves.toStrictEqual({ ok: false, error: 'stale-attempt' });
    expect(assetRegistry.invalidateAttempt).toHaveBeenCalledWith({ webContentsId: 25, attemptId: 'attempt_1' });
  });
  it('contains a stale rejected existing-file authorization when cleanup throws privately', async () => {
    let activeAttempt = 'attempt_1';
    const authorization = deferred<never>();
    const authorizationStarted = deferred<void>();
    const invalidateAttempt = vi.fn(() => {
      throw new Error('cleanup failed for /private/stale-owner.png');
    });
    const consoleWarn = vi.spyOn(console, 'warn');
    const { deps, fileGrants, assetRegistry } = createDeps({
      activeAttempt: () => activeAttempt,
      currentDocumentPathForWebContents: vi.fn(() => '/renderer-claimed/current.md'),
      authorizeExistingFile: vi.fn(() => {
        authorizationStarted.resolve();
        return authorization.promise;
      }),
      invalidateAttempt,
    });
    registerHtmlExportAssetIpc(deps as never);

    const pending = ipc.handler('html:asset:pick')!(eventFor({ id: 244 }), request());
    await authorizationStarted.promise;
    activeAttempt = 'attempt_2';
    authorization.reject(new Error('existing authorization failed for /private/current/secret.md'));

    const result = await pending;

    expect(result).toStrictEqual({ ok: false, error: 'stale-attempt' });
    expect(JSON.stringify(result)).not.toMatch(/private|secret|current|path/i);
    expect(consoleWarn).not.toHaveBeenCalled();
    consoleWarn.mockRestore();
    expect(assetRegistry.invalidateAttempt).toHaveBeenCalledTimes(1);
    expect(assetRegistry.invalidateAttempt).toHaveBeenCalledWith({ webContentsId: 244, attemptId: 'attempt_1' });
    expect(assetRegistry.invalidateAttempt).not.toHaveBeenCalledWith({ webContentsId: 244, attemptId: 'attempt_2' });
    expect(fileGrants.authorizeWriteTarget).not.toHaveBeenCalled();
    expect(deps.pickAssets).not.toHaveBeenCalled();
    expect(fileGrants.grantAssetSelection).not.toHaveBeenCalled();
    expect(assetRegistry.issueFromExplicitSelection).not.toHaveBeenCalled();
  });
  it('contains a stale rejected write-target authorization without replacement side effects', async () => {
    let activeAttempt = 'attempt_1';
    const authorization = deferred<never>();
    const authorizationStarted = deferred<void>();
    const { deps, fileGrants, assetRegistry } = createDeps({
      activeAttempt: () => activeAttempt,
      currentDocumentPathForWebContents: vi.fn(() => '/renderer-claimed/current.md'),
      authorizeWriteTarget: vi.fn(() => {
        authorizationStarted.resolve();
        return authorization.promise;
      }),
    });
    registerHtmlExportAssetIpc(deps as never);

    const pending = ipc.handler('html:asset:pick')!(eventFor({ id: 245 }), request());
    await authorizationStarted.promise;
    activeAttempt = 'attempt_2';
    authorization.reject(new Error('write authorization failed for /private/current/secret.md'));

    const result = await pending;

    expect(result).toStrictEqual({ ok: false, error: 'stale-attempt' });
    expect(JSON.stringify(result)).not.toMatch(/private|secret|current|path/i);
    expect(assetRegistry.invalidateAttempt).toHaveBeenCalledTimes(1);
    expect(assetRegistry.invalidateAttempt).toHaveBeenCalledWith({ webContentsId: 245, attemptId: 'attempt_1' });
    expect(assetRegistry.invalidateAttempt).not.toHaveBeenCalledWith({ webContentsId: 245, attemptId: 'attempt_2' });
    expect(deps.pickAssets).not.toHaveBeenCalled();
    expect(fileGrants.grantAssetSelection).not.toHaveBeenCalled();
    expect(assetRegistry.issueFromExplicitSelection).not.toHaveBeenCalled();
  });
  it('contains a stale rejected final grant without replacement side effects', async () => {
    let activeAttempt = 'attempt_1';
    const grant = deferred<never>();
    const grantStarted = deferred<void>();
    const { deps, assetRegistry } = createDeps({
      activeAttempt: () => activeAttempt,
      grantAssetSelection: vi.fn(() => {
        grantStarted.resolve();
        return grant.promise;
      }),
    });
    registerHtmlExportAssetIpc(deps as never);

    const pending = ipc.handler('html:asset:pick')!(eventFor({ id: 246 }), request());
    await grantStarted.promise;
    activeAttempt = 'attempt_2';
    grant.reject(new Error('grant failed for /private/selected/secret.png'));

    const result = await pending;

    expect(result).toStrictEqual({ ok: false, error: 'stale-attempt' });
    expect(JSON.stringify(result)).not.toMatch(/private|secret|selected|path/i);
    expect(assetRegistry.invalidateAttempt).toHaveBeenCalledTimes(1);
    expect(assetRegistry.invalidateAttempt).toHaveBeenCalledWith({ webContentsId: 246, attemptId: 'attempt_1' });
    expect(assetRegistry.invalidateAttempt).not.toHaveBeenCalledWith({ webContentsId: 246, attemptId: 'attempt_2' });
    expect(assetRegistry.issueFromExplicitSelection).not.toHaveBeenCalled();
  });
  it('contains a stale rejected issuance without replacement side effects', async () => {
    let activeAttempt = 'attempt_1';
    const issuance = deferred<never>();
    const issuanceStarted = deferred<void>();
    const { deps, fileGrants, assetRegistry } = createDeps({
      activeAttempt: () => activeAttempt,
      issueFromExplicitSelection: vi.fn(() => {
        issuanceStarted.resolve();
        return issuance.promise;
      }),
    });
    registerHtmlExportAssetIpc(deps as never);

    const pending = ipc.handler('html:asset:pick')!(eventFor({ id: 247 }), request());
    await issuanceStarted.promise;
    activeAttempt = 'attempt_2';
    issuance.reject(new Error('issuance failed for /private/selected/secret.png'));

    const result = await pending;

    expect(result).toStrictEqual({ ok: false, error: 'stale-attempt' });
    expect(JSON.stringify(result)).not.toMatch(/private|secret|selected|path/i);
    expect(assetRegistry.invalidateAttempt).toHaveBeenCalledTimes(1);
    expect(assetRegistry.invalidateAttempt).toHaveBeenCalledWith({ webContentsId: 247, attemptId: 'attempt_1' });
    expect(assetRegistry.invalidateAttempt).not.toHaveBeenCalledWith({ webContentsId: 247, attemptId: 'attempt_2' });
    expect(fileGrants.grantAssetSelection).toHaveBeenCalledExactlyOnceWith(247, '/selection/selected.png');
    expect(assetRegistry.issueFromExplicitSelection).toHaveBeenCalledExactlyOnceWith(
      { webContentsId: 247, attemptId: 'attempt_1' },
      expect.anything(),
    );
    expect(assetRegistry.issueFromExplicitSelection).not.toHaveBeenCalledWith(
      { webContentsId: 247, attemptId: 'attempt_2' },
      expect.anything(),
    );
  });
  it('bounds pending pickers per exact owner and sender before downstream work, then admits a fresh request after cancellation', async () => {
    const selection = deferred<{ readonly canceled: boolean; readonly filePaths: readonly string[] }>();
    const pickerStarted = deferred<void>();
    const pickAssets = vi.fn(() => {
      pickerStarted.resolve();
      return selection.promise;
    });
    const { deps, fileGrants, assetRegistry } = createDeps({ pickAssets });
    registerHtmlExportAssetIpc(deps as never);

    const pending = ipc.handler('html:asset:pick')!(eventFor({ id: 260 }), request());
    await pickerStarted.promise;

    await expect(ipc.handler('html:asset:pick')!(eventFor({ id: 260 }), request())).resolves.toStrictEqual({
      ok: false,
      error: 'asset-budget-exceeded',
    });
    await expect(ipc.handler('html:asset:pick')!(eventFor({ id: 260 }), request({ attemptId: 'attempt_2' }))).resolves.toStrictEqual({
      ok: false,
      error: 'asset-budget-exceeded',
    });

    expect(deps.windowForWebContents).toHaveBeenCalledTimes(1);
    expect(fileGrants.authorizeExistingFile).not.toHaveBeenCalled();
    expect(fileGrants.authorizeWriteTarget).not.toHaveBeenCalled();
    expect(pickAssets).toHaveBeenCalledTimes(1);
    expect(fileGrants.grantAssetSelection).not.toHaveBeenCalled();
    expect(assetRegistry.issueFromExplicitSelection).not.toHaveBeenCalled();

    selection.resolve({ canceled: true, filePaths: [] });
    await expect(pending).resolves.toStrictEqual({ ok: false, error: 'cancelled' });
    await expect(ipc.handler('html:asset:pick')!(eventFor({ id: 260 }), request())).resolves.toStrictEqual({
      ok: false,
      error: 'cancelled',
    });
    expect(pickAssets).toHaveBeenCalledTimes(2);
  });

  it('releases exactly one global picker slot while the other seven remain pending', async () => {
    const selections: Array<ReturnType<typeof deferred<{ readonly canceled: boolean; readonly filePaths: readonly string[] }>>> = [];
    const initialPickersStarted = deferred<void>();
    const replacementPickerStarted = deferred<void>();
    const pickAssets = vi.fn(() => {
      const selection = deferred<{ readonly canceled: boolean; readonly filePaths: readonly string[] }>();
      selections.push(selection);
      if (selections.length === 8) initialPickersStarted.resolve();
      if (selections.length === 9) replacementPickerStarted.resolve();
      return selection.promise;
    });
    const { deps, fileGrants, assetRegistry } = createDeps({ pickAssets });
    registerHtmlExportAssetIpc(deps as never);

    const pending = Array.from(
      { length: 8 },
      (_, index) => ipc.handler('html:asset:pick')!(eventFor({ id: 270 + index }), request()),
    );
    await initialPickersStarted.promise;

    await expect(ipc.handler('html:asset:pick')!(eventFor({ id: 278 }), request())).resolves.toStrictEqual({
      ok: false,
      error: 'asset-budget-exceeded',
    });
    expect(deps.windowForWebContents).toHaveBeenCalledTimes(8);
    expect(fileGrants.authorizeExistingFile).not.toHaveBeenCalled();
    expect(fileGrants.authorizeWriteTarget).not.toHaveBeenCalled();
    expect(pickAssets).toHaveBeenCalledTimes(8);
    expect(fileGrants.grantAssetSelection).not.toHaveBeenCalled();
    expect(assetRegistry.issueFromExplicitSelection).not.toHaveBeenCalled();

    selections[0]!.resolve({ canceled: true, filePaths: [] });
    await expect(pending[0]).resolves.toStrictEqual({ ok: false, error: 'cancelled' });

    const replacement = ipc.handler('html:asset:pick')!(eventFor({ id: 278 }), request());
    await replacementPickerStarted.promise;
    await expect(ipc.handler('html:asset:pick')!(eventFor({ id: 279 }), request())).resolves.toStrictEqual({
      ok: false,
      error: 'asset-budget-exceeded',
    });
    expect(pickAssets).toHaveBeenCalledTimes(9);

    selections[8]!.resolve({ canceled: true, filePaths: [] });
    await expect(replacement).resolves.toStrictEqual({ ok: false, error: 'cancelled' });
    for (const selection of selections.slice(1, 8)) {
      selection.resolve({ canceled: true, filePaths: [] });
    }
    await expect(Promise.all(pending.slice(1))).resolves.toStrictEqual(
      Array.from({ length: 7 }, () => ({ ok: false, error: 'cancelled' })),
    );
  });

  it('treats a cancellation resolved after an attempt switch as stale and invalidates only the old owner once', async () => {
    let activeAttempt = 'attempt_1';
    const selection = deferred<{ readonly canceled: boolean; readonly filePaths: readonly string[] }>();
    const pickerStarted = deferred<void>();
    const { deps, fileGrants, assetRegistry } = createDeps({
      activeAttempt: () => activeAttempt,
      pickAssets: vi.fn(() => {
        pickerStarted.resolve();
        return selection.promise;
      }),
    });
    registerHtmlExportAssetIpc(deps as never);

    const pending = ipc.handler('html:asset:pick')!(eventFor({ id: 279 }), request());
    await pickerStarted.promise;
    activeAttempt = 'attempt_2';
    selection.resolve({ canceled: true, filePaths: [] });

    await expect(pending).resolves.toStrictEqual({ ok: false, error: 'stale-attempt' });
    expect(assetRegistry.invalidateAttempt).toHaveBeenCalledTimes(1);
    expect(assetRegistry.invalidateAttempt).toHaveBeenCalledWith({ webContentsId: 279, attemptId: 'attempt_1' });
    expect(assetRegistry.invalidateAttempt).not.toHaveBeenCalledWith({ webContentsId: 279, attemptId: 'attempt_2' });
    expect(fileGrants.grantAssetSelection).not.toHaveBeenCalled();
    expect(assetRegistry.issueFromExplicitSelection).not.toHaveBeenCalled();
    activeAttempt = 'attempt_1';
    await expect(ipc.handler('html:asset:pick')!(eventFor({ id: 279 }), request())).resolves.toStrictEqual({
      ok: false,
      error: 'cancelled',
    });
    expect(deps.pickAssets).toHaveBeenCalledTimes(2);
  });

  it('invalidates partial old state after a later issuance stalls and does not process later files', async () => {
    let activeAttempt = 'attempt_1';
    const issuance = deferred<{ readonly ok: true; readonly asset: ReturnType<typeof asset> }>();
    const issuanceStarted = deferred<void>();
    let issuanceCount = 0;
    const issueFromExplicitSelection = vi.fn(() => {
      issuanceCount += 1;
      if (issuanceCount === 2) {
        issuanceStarted.resolve();
        return issuance.promise;
      }
      return Promise.resolve({ ok: true as const, asset: asset('asset_first', 'first.png') });
    });
    const { deps, fileGrants, assetRegistry } = createDeps({
      activeAttempt: () => activeAttempt,
      issueFromExplicitSelection,
      pickAssets: vi.fn(async () => ({
        canceled: false,
        filePaths: ['/selection/first.png', '/selection/stalled.png', '/selection/unprocessed.png'],
      })),
    });
    registerHtmlExportAssetIpc(deps as never);

    const pending = ipc.handler('html:asset:pick')!(eventFor({ id: 280 }), request());
    await issuanceStarted.promise;
    activeAttempt = 'attempt_2';
    issuance.resolve({ ok: true, asset: asset('asset_stalled', 'stalled.png') });

    await expect(pending).resolves.toStrictEqual({ ok: false, error: 'stale-attempt' });
    expect(fileGrants.grantAssetSelection).toHaveBeenCalledTimes(2);
    expect(fileGrants.grantAssetSelection).not.toHaveBeenCalledWith(280, '/selection/unprocessed.png');
    expect(issueFromExplicitSelection).toHaveBeenCalledTimes(2);
    expect(assetRegistry.invalidateAttempt).toHaveBeenCalledTimes(1);
    expect(assetRegistry.invalidateAttempt).toHaveBeenCalledWith({ webContentsId: 280, attemptId: 'attempt_1' });
    expect(assetRegistry.invalidateAttempt).not.toHaveBeenCalledWith({ webContentsId: 280, attemptId: 'attempt_2' });
  });
  it.each([
    ['success', () => ({ canceled: false, filePaths: [] }), { ok: true, assets: [], rejected: [] }],
    ['cancellation', () => ({ canceled: true, filePaths: [] }), { ok: false, error: 'cancelled' }],
    [
      'typed selection-budget failure',
      () => ({
        canceled: false,
        filePaths: Array.from({ length: HTML_EXPORT_RETAINED_ASSET_MAX_COUNT + 1 }, (_, index) => `/selection/${index}.png`),
      }),
      { ok: false, error: 'asset-budget-exceeded' },
    ],
    ['picker rejection', () => Promise.reject(new Error('picker failed')), { ok: false, error: 'picker-failed' }],
  ])('releases admission after %s so the same owner can make a fresh request', async (_terminal, selection, expected) => {
    const pickAssets = vi.fn(async () => selection());
    const { deps } = createDeps({ pickAssets });
    registerHtmlExportAssetIpc(deps as never);

    await expect(ipc.handler('html:asset:pick')!(eventFor({ id: 281 }), request())).resolves.toStrictEqual(expected);
    await expect(ipc.handler('html:asset:pick')!(eventFor({ id: 281 }), request())).resolves.toStrictEqual(expected);
    expect(pickAssets).toHaveBeenCalledTimes(2);
  });

  it('releases admission after current-document authorization failure', async () => {
    let authorizationFails = true;
    const authorizeExistingFile = vi.fn(async () => {
      if (authorizationFails) throw new Error('authorization failed');
      return null;
    });
    const { deps } = createDeps({
      currentDocumentPathForWebContents: vi.fn(() => '/renderer-claimed/current.md'),
      authorizeExistingFile,
      pickAssets: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    });
    registerHtmlExportAssetIpc(deps as never);

    await expect(ipc.handler('html:asset:pick')!(eventFor({ id: 282 }), request())).resolves.toStrictEqual({
      ok: false,
      error: 'asset-operation-failed',
    });

    authorizationFails = false;
    await expect(ipc.handler('html:asset:pick')!(eventFor({ id: 282 }), request())).resolves.toStrictEqual({
      ok: false,
      error: 'cancelled',
    });
    expect(deps.pickAssets).toHaveBeenCalledTimes(1);
  });
});
