import { describe, expect, it } from 'vitest';

import {
  HtmlExportAssetRegistry,
  type HtmlAssetOwner,
} from '../main/html-export-asset-registry';
import type { ExplicitAssetFileGrant } from '../main/file-grants';
import {
  ASSET_SOURCE_READ_MAX_BYTES,
  type HtmlAssetId,
} from '../shared/html-export-assets';

const OWNER: HtmlAssetOwner = { webContentsId: 41, attemptId: 'attempt-a' };
const OTHER_OWNER: HtmlAssetOwner = { webContentsId: 84, attemptId: 'attempt-b' };
const ACTIVE_ATTEMPT = () => true;

function pngBytes(width = 1, height = 1): Uint8Array {
  const bytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x08, 0x06, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function assetGrant(realpath = '/private/selected-images/secret-logo.png'): ExplicitAssetFileGrant {
  return {
    kind: 'file',
    source: 'asset-picker',
    realpath,
    identity: '1:2' as ExplicitAssetFileGrant['identity'],
    generation: 0,
  };
}

function registryWithBytes(bytes = pngBytes()): HtmlExportAssetRegistry {
  let nextId = 0;
  return new HtmlExportAssetRegistry({
    uuidFactory: () => `asset-${nextId++}`,
    assetReader: async () => ({ ok: true, bytes: bytes.slice() }),
    isAttemptActive: ACTIVE_ATTEMPT,
  });
}

async function issue(
  registry: HtmlExportAssetRegistry,
  owner = OWNER,
  grant = assetGrant(),
): Promise<HtmlAssetId> {
  const result = await registry.issueFromExplicitSelection(owner, grant);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result.asset.assetId;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function expectResolveError(
  registry: HtmlExportAssetRegistry,
  owner: HtmlAssetOwner,
  assetIds: readonly HtmlAssetId[],
  error: string,
): void {
  expect(registry.resolveForAttempt(owner, assetIds, Number.MAX_SAFE_INTEGER)).toEqual({ ok: false, error });
}

describe('HtmlExportAssetRegistry', () => {
  it('issues pathless metadata only after an asset-picker grant', async () => {
    let reads = 0;
    const registry = new HtmlExportAssetRegistry({
      uuidFactory: () => 'asset-1',
      assetReader: async () => {
        reads += 1;
        return { ok: true, bytes: pngBytes() };
      },
      isAttemptActive: ACTIVE_ATTEMPT,
    });

    const issued = await registry.issueFromExplicitSelection(OWNER, assetGrant());
    expect(issued).toMatchObject({
      ok: true,
      asset: {
        assetId: 'asset-1',
        basename: 'secret-logo.png',
        mime: 'image/png',
        width: 1,
        height: 1,
        encodedBytes: 44,
      },
    });
    expect(reads).toBe(1);
    expect(JSON.stringify(issued)).not.toContain('/private/selected-images');
    expect(issued.ok && Object.keys(issued.asset).sort()).toEqual([
      'assetId',
      'basename',
      'encodedBytes',
      'height',
      'mime',
      'width',
    ]);

    const denied = await registry.issueFromExplicitSelection(
      OWNER,
      { ...assetGrant(), source: 'open-dialog' } as ExplicitAssetFileGrant,
    );
    expect(denied).toEqual({ ok: false, error: 'identity-mismatch' });
    expect(JSON.stringify(denied)).not.toContain('/private/selected-images');
    expect(reads).toBe(1);
  });
  it('fails closed without an active-attempt authority', async () => {
    let reads = 0;
    const registry = new HtmlExportAssetRegistry({
      assetReader: async () => {
        reads += 1;
        return { ok: true, bytes: pngBytes() };
      },
    });

    await expect(registry.issueFromExplicitSelection(OWNER, assetGrant())).resolves.toEqual({
      ok: false,
      error: 'stale-attempt',
    });
    expect(reads).toBe(0);
  });

  it('rejects wrong senders and stale attempts without returning bytes', async () => {
    const registry = registryWithBytes();
    const assetId = await issue(registry);

    expectResolveError(registry, OTHER_OWNER, [assetId], 'wrong-owner');
    expectResolveError(
      registry,
      { webContentsId: OWNER.webContentsId, attemptId: 'attempt-newer' },
      [assetId],
      'stale-attempt',
    );
  });

  it('rejects missing and duplicate asset IDs before resolution', async () => {
    const registry = registryWithBytes();
    const assetId = await issue(registry);

    expectResolveError(registry, OWNER, ['missing' as HtmlAssetId], 'missing-asset');
    expectResolveError(registry, OWNER, [assetId, assetId], 'duplicate-asset');
  });

  it('enforces the aggregate encoded-byte budget across two distinct assets', async () => {
    const registry = registryWithBytes();
    const firstAssetId = await issue(registry);
    const secondAssetId = await issue(registry, OWNER, assetGrant('/private/selected-images/second-logo.png'));
    expect(secondAssetId).not.toBe(firstAssetId);

    expect(registry.resolveForAttempt(OWNER, [firstAssetId], 44).ok).toBe(true);
    expect(registry.resolveForAttempt(OWNER, [secondAssetId], 44).ok).toBe(true);
    expect(registry.resolveForAttempt(OWNER, [firstAssetId, secondAssetId], 88).ok).toBe(true);
    expect(registry.resolveForAttempt(OWNER, [firstAssetId, secondAssetId], 87)).toEqual({
      ok: false,
      error: 'asset-budget-exceeded',
    });
  });

  it('stores and returns immutable copies of raster bytes', async () => {
    const source = pngBytes();
    const registry = registryWithBytes(source);
    const assetId = await issue(registry);
    source[0] = 0;

    const first = registry.resolveForAttempt(OWNER, [assetId], 44);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error);
    expect(first.assets[0].bytes[0]).toBe(0x89);
    first.assets[0].bytes[0] = 0;

    const second = registry.resolveForAttempt(OWNER, [assetId], 44);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.error);
    expect(second.assets[0].bytes[0]).toBe(0x89);
  });
  it('rejects resolved copies when authority is revoked after validation', async () => {
    let resolving = false;
    let resolutionChecks = 0;
    const registry = new HtmlExportAssetRegistry({
      assetReader: async () => ({ ok: true, bytes: pngBytes() }),
      isAttemptActive: () => {
        if (!resolving) return true;
        resolutionChecks += 1;
        return resolutionChecks < 3;
      },
    });
    const assetId = await issue(registry);

    resolving = true;
    expect(registry.resolveForAttempt(OWNER, [assetId], 44)).toEqual({
      ok: false,
      error: 'stale-attempt',
    });
    expect(resolutionChecks).toBe(3);
    resolving = false;
    expect(registry.resolveForAttempt(OWNER, [assetId], 44)).toMatchObject({
      ok: true,
      assets: [{ assetId }],
    });
  });
  it('rejects retained count and byte budget overflows without inserting the rejected asset', async () => {
    let countReaderCalls = 0;
    let countUuidCalls = 0;
    const countRegistry = new HtmlExportAssetRegistry({
      uuidFactory: () => `count-${countUuidCalls++}`,
      assetReader: async () => {
        countReaderCalls += 1;
        return { ok: true, bytes: pngBytes() };
      },
      isAttemptActive: ACTIVE_ATTEMPT,
    });
    for (let index = 0; index < 64; index += 1) {
      await issue(countRegistry, OWNER, assetGrant(`/private/selected-images/count-${index}.png`));
    }
    expect(countReaderCalls).toBe(64);
    expect(countUuidCalls).toBe(64);
    await expect(countRegistry.issueFromExplicitSelection(OWNER, assetGrant('count-overflow.png'))).resolves.toEqual({
      ok: false,
      error: 'asset-budget-exceeded',
    });
    expect(countReaderCalls).toBe(65);
    expect(countUuidCalls).toBe(64);

    const largestAsset = new Uint8Array(ASSET_SOURCE_READ_MAX_BYTES);
    largestAsset.set(pngBytes());
    let nextByteId = 0;
    const byteRegistry = new HtmlExportAssetRegistry({
      uuidFactory: () => `bytes-${nextByteId++}`,
      assetReader: async () => ({ ok: true, bytes: largestAsset.slice() }),
      isAttemptActive: ACTIVE_ATTEMPT,
    });
    const acceptedByteAssetIds: HtmlAssetId[] = [];
    for (let index = 0; index < 5; index += 1) {
      acceptedByteAssetIds.push(await issue(
        byteRegistry,
        OWNER,
        assetGrant(`/private/selected-images/bytes-${index}.png`),
      ));
    }
    await expect(byteRegistry.issueFromExplicitSelection(OWNER, assetGrant('bytes-overflow.png'))).resolves.toEqual({
      ok: false,
      error: 'asset-budget-exceeded',
    });
    expect(nextByteId).toBe(5);
    const byteResolution = byteRegistry.resolveForAttempt(
      OWNER,
      acceptedByteAssetIds,
      Number.MAX_SAFE_INTEGER,
    );
    expect(byteResolution.ok).toBe(true);
    if (!byteResolution.ok) throw new Error(byteResolution.error);
    expect(byteResolution.assets.map((asset) => asset.assetId)).toEqual(acceptedByteAssetIds);
    expectResolveError(byteRegistry, OWNER, ['bytes-5' as HtmlAssetId], 'missing-asset');

    byteRegistry.invalidateAttempt(OWNER);
    await expect(byteRegistry.issueFromExplicitSelection(
      { webContentsId: OWNER.webContentsId, attemptId: 'attempt-after-invalidation' },
      assetGrant('bytes-after-invalidation.png'),
    )).resolves.toMatchObject({ ok: true });
  });

  it('does not insert or resurrect an asset when invalidation occurs during a reader wait', async () => {
    const reader = deferred<{ readonly ok: true; readonly bytes: Uint8Array }>();
    const registry = new HtmlExportAssetRegistry({
      uuidFactory: () => 'asset-race-invalidate',
      assetReader: async () => reader.promise,
      isAttemptActive: ACTIVE_ATTEMPT,
    });

    const issuing = registry.issueFromExplicitSelection(OWNER, assetGrant());
    registry.invalidateAttempt(OWNER);
    await expect(registry.issueFromExplicitSelection(OWNER, assetGrant())).resolves.toEqual({
      ok: false,
      error: 'stale-attempt',
    });
    reader.resolve({ ok: true, bytes: pngBytes() });

    await expect(issuing).resolves.toEqual({ ok: false, error: 'stale-attempt' });
    expectResolveError(registry, OWNER, ['asset-race-invalidate' as HtmlAssetId], 'missing-asset');
    expect(registry.getActiveOwnerLifecycleCountForTesting()).toBe(0);
  });
  it('rejects an issuance when the injected active-attempt authority is revoked during its read', async () => {
    let active = true;
    const reader = deferred<{ readonly ok: true; readonly bytes: Uint8Array }>();
    const registry = new HtmlExportAssetRegistry({
      uuidFactory: () => 'active-authority-race',
      assetReader: async () => reader.promise,
      isAttemptActive: () => active,
    });

    const issuing = registry.issueFromExplicitSelection(OWNER, assetGrant());
    active = false;
    reader.resolve({ ok: true, bytes: pngBytes() });

    await expect(issuing).resolves.toEqual({ ok: false, error: 'stale-attempt' });
    active = true;
    expectResolveError(registry, OWNER, ['active-authority-race' as HtmlAssetId], 'missing-asset');
    expect(registry.getActiveOwnerLifecycleCountForTesting()).toBe(0);
  });
  it('releases invalidation fencing after every affected issuance settles', async () => {
    const readers: Deferred<{ readonly ok: true; readonly bytes: Uint8Array }>[] = [];
    const registry = new HtmlExportAssetRegistry({
      assetReader: () => {
        const reader = deferred<{ readonly ok: true; readonly bytes: Uint8Array }>();
        readers.push(reader);
        return reader.promise;
      },
      isAttemptActive: ACTIVE_ATTEMPT,
    });

    for (let index = 0; index < 128; index += 1) {
      const owner = { webContentsId: OWNER.webContentsId, attemptId: `attempt-${index}` };
      const issuing = registry.issueFromExplicitSelection(owner, assetGrant());
      expect(registry.getActiveOwnerLifecycleCountForTesting()).toBe(1);

      registry.invalidateAttempt(owner);
      readers[index].resolve({ ok: true, bytes: pngBytes() });

      await expect(issuing).resolves.toEqual({ ok: false, error: 'stale-attempt' });
      expect(registry.getActiveOwnerLifecycleCountForTesting()).toBe(0);
    }
  });
  it('keeps a same-owner invalidation fence until every concurrent issuance settles', async () => {
    const readers: Deferred<{ readonly ok: true; readonly bytes: Uint8Array }>[] = [];
    const registry = new HtmlExportAssetRegistry({
      assetReader: () => {
        const reader = deferred<{ readonly ok: true; readonly bytes: Uint8Array }>();
        readers.push(reader);
        return reader.promise;
      },
      isAttemptActive: ACTIVE_ATTEMPT,
    });

    const first = registry.issueFromExplicitSelection(OWNER, assetGrant('first.png'));
    const second = registry.issueFromExplicitSelection(OWNER, assetGrant('second.png'));
    expect(registry.getActiveOwnerLifecycleCountForTesting()).toBe(1);
    registry.invalidateAttempt(OWNER);

    readers[0].resolve({ ok: true, bytes: pngBytes() });
    await expect(first).resolves.toEqual({ ok: false, error: 'stale-attempt' });
    expect(registry.getActiveOwnerLifecycleCountForTesting()).toBe(1);
    await expect(registry.issueFromExplicitSelection(OWNER, assetGrant('third.png'))).resolves.toEqual({
      ok: false,
      error: 'stale-attempt',
    });

    readers[1].resolve({ ok: true, bytes: pngBytes() });
    await expect(second).resolves.toEqual({ ok: false, error: 'stale-attempt' });
    expect(registry.getActiveOwnerLifecycleCountForTesting()).toBe(0);
  });

  it('clears lifecycle metadata after successful, typed-failed, and budget-rejected issuances', async () => {
    const successful = registryWithBytes();
    await expect(successful.issueFromExplicitSelection(OWNER, assetGrant())).resolves.toMatchObject({ ok: true });
    expect(successful.getActiveOwnerLifecycleCountForTesting()).toBe(0);

    const typedFailure = new HtmlExportAssetRegistry({
      assetReader: async () => ({ ok: false as const, error: 'read-failed' as const }),
      isAttemptActive: ACTIVE_ATTEMPT,
    });
    await expect(typedFailure.issueFromExplicitSelection(OWNER, assetGrant())).resolves.toEqual({
      ok: false,
      error: 'read-failed',
    });
    expect(typedFailure.getActiveOwnerLifecycleCountForTesting()).toBe(0);

    const budgetRejected = registryWithBytes();
    for (let index = 0; index < 64; index += 1) {
      await issue(budgetRejected, OWNER, assetGrant(`budget-${index}.png`));
    }
    await expect(budgetRejected.issueFromExplicitSelection(OWNER, assetGrant('budget-rejected.png'))).resolves.toEqual({
      ok: false,
      error: 'asset-budget-exceeded',
    });
    expect(budgetRejected.getActiveOwnerLifecycleCountForTesting()).toBe(0);
  });
  it('releases owner in-flight admission after raster validation failures', async () => {
    let reads = 0;
    const registry = new HtmlExportAssetRegistry({
      assetReader: async () => ({
        ok: true as const,
        bytes: reads++ < 8 ? Uint8Array.of(0) : pngBytes(),
      }),
      isAttemptActive: ACTIVE_ATTEMPT,
    });
    const pending = Array.from(
      { length: 8 },
      (_, index) => registry.issueFromExplicitSelection(OWNER, assetGrant(`invalid-${index}.png`)),
    );

    await expect(registry.issueFromExplicitSelection(OWNER, assetGrant('invalid-overflow.png'))).resolves.toEqual({
      ok: false,
      error: 'asset-budget-exceeded',
    });
    expect(reads).toBe(8);
    for (const result of await Promise.all(pending)) {
      expect(result).toEqual({ ok: false, error: 'unsupported-magic' });
    }

    await expect(registry.issueFromExplicitSelection(OWNER, assetGrant('valid-after-invalid.png'))).resolves.toMatchObject({
      ok: true,
    });
    expect(reads).toBe(9);
    expect(registry.getActiveOwnerLifecycleCountForTesting()).toBe(0);
  });
  it.each([
    {
      name: 'same owner',
      owners: [{ webContentsId: 91, attemptId: 'owner-cap' }],
      issuancesPerOwner: 8,
      rejectedOwner: { webContentsId: 91, attemptId: 'owner-cap' },
    },
    {
      name: 'same sender',
      owners: Array.from({ length: 8 }, (_, index) => ({ webContentsId: 92, attemptId: `sender-cap-${index}` })),
      issuancesPerOwner: 8,
      rejectedOwner: { webContentsId: 92, attemptId: 'sender-cap-next' },
    },
    {
      name: 'global registry',
      owners: Array.from({ length: 32 }, (_, index) => ({ webContentsId: 100 + index, attemptId: 'global-cap' })),
      issuancesPerOwner: 8,
      rejectedOwner: { webContentsId: 999, attemptId: 'global-cap-next' },
    },
  ] as const)('enforces incremental in-flight release at the exact $name cap before any reader or UUID side effect', async ({
    owners,
    issuancesPerOwner,
    rejectedOwner,
  }) => {
    const readers: Deferred<{ readonly ok: true; readonly bytes: Uint8Array }>[] = [];
    let readerCalls = 0;
    let uuidCalls = 0;
    const registry = new HtmlExportAssetRegistry({
      uuidFactory: () => `in-flight-${uuidCalls++}`,
      assetReader: () => {
        readerCalls += 1;
        const reader = deferred<{ readonly ok: true; readonly bytes: Uint8Array }>();
        readers.push(reader);
        return reader.promise;
      },
      isAttemptActive: ACTIVE_ATTEMPT,
    });
    let settledIssuances = 0;
    const pending = owners.flatMap((owner) => Array.from(
      { length: issuancesPerOwner },
      (_, index) => registry.issueFromExplicitSelection(owner, assetGrant(`in-flight-${owner.webContentsId}-${index}.png`))
        .then((result) => {
          settledIssuances += 1;
          return result;
        }),
    ));

    const admittedReaders = [...readers];
    expect(admittedReaders).toHaveLength(owners.length * issuancesPerOwner);
    expect(readerCalls).toBe(admittedReaders.length);
    expect(uuidCalls).toBe(0);
    await expect(registry.issueFromExplicitSelection(rejectedOwner, assetGrant('in-flight-rejected.png'))).resolves.toEqual({
      ok: false,
      error: 'asset-budget-exceeded',
    });
    expect(readerCalls).toBe(admittedReaders.length);
    expect(uuidCalls).toBe(0);

    admittedReaders[0].resolve({ ok: true, bytes: pngBytes() });
    await expect(pending[0]).resolves.toMatchObject({ ok: true });
    expect(uuidCalls).toBe(1);
    expect(settledIssuances).toBe(1);

    const replacement = registry.issueFromExplicitSelection(rejectedOwner, assetGrant('in-flight-replacement.png'));
    const replacementReader = readers[readers.length - 1];
    if (!replacementReader) throw new Error('replacement issuance did not start reading');
    expect(readerCalls).toBe(admittedReaders.length + 1);
    await expect(registry.issueFromExplicitSelection(rejectedOwner, assetGrant('in-flight-rejected-after-replacement.png'))).resolves.toEqual({
      ok: false,
      error: 'asset-budget-exceeded',
    });
    expect(readerCalls).toBe(admittedReaders.length + 1);
    expect(uuidCalls).toBe(1);

    for (const reader of admittedReaders.slice(1)) reader.resolve({ ok: true, bytes: pngBytes() });
    replacementReader.resolve({ ok: true, bytes: pngBytes() });
    for (const result of await Promise.all([...pending.slice(1), replacement])) expect(result.ok).toBe(true);
    expect(uuidCalls).toBe(admittedReaders.length + 1);
    expect(settledIssuances).toBe(pending.length);
    expect(registry.getActiveOwnerLifecycleCountForTesting()).toBe(0);
  });

  it('accepts exactly 32,000,000 retained pixels without inserting the rejected next asset', async () => {
    let nextPixelId = 0;
    const registry = new HtmlExportAssetRegistry({
      uuidFactory: () => `pixels-${nextPixelId++}`,
      assetReader: async (selectedGrant) => ({
        ok: true as const,
        bytes: selectedGrant.realpath.includes('full-pixel') ? pngBytes(8_000, 4_000) : pngBytes(),
      }),
      isAttemptActive: ACTIVE_ATTEMPT,
    });

    const accepted = await registry.issueFromExplicitSelection(OWNER, assetGrant('full-pixel.png'));
    expect(accepted).toMatchObject({
      ok: true,
      asset: { assetId: 'pixels-0', width: 8_000, height: 4_000 },
    });
    if (!accepted.ok) throw new Error(accepted.error);
    await expect(registry.issueFromExplicitSelection(OWNER, assetGrant('one-pixel-too-many.png'))).resolves.toEqual({
      ok: false,
      error: 'asset-budget-exceeded',
    });
    expect(nextPixelId).toBe(1);
    const pixelResolution = registry.resolveForAttempt(
      OWNER,
      [accepted.asset.assetId],
      Number.MAX_SAFE_INTEGER,
    );
    expect(pixelResolution).toMatchObject({
      ok: true,
      assets: [{ assetId: 'pixels-0', width: 8_000, height: 4_000 }],
    });
    expectResolveError(registry, OWNER, ['pixels-1' as HtmlAssetId], 'missing-asset');
    expect(registry.getActiveOwnerLifecycleCountForTesting()).toBe(0);
  });

  it('does not insert an asset when webContents is released during a reader wait', async () => {
    const reader = deferred<{ readonly ok: true; readonly bytes: Uint8Array }>();
    const freshOwner: HtmlAssetOwner = { webContentsId: 42, attemptId: 'attempt-after-release' };
    let activeOwner = OWNER;
    const registry = new HtmlExportAssetRegistry({
      uuidFactory: () => 'asset-race-release',
      assetReader: async () => reader.promise,
      isAttemptActive: (owner) => owner.webContentsId === activeOwner.webContentsId
        && owner.attemptId === activeOwner.attemptId,
    });

    const issuing = registry.issueFromExplicitSelection(OWNER, assetGrant());
    registry.releaseWebContents(OWNER.webContentsId);
    await expect(registry.issueFromExplicitSelection(OWNER, assetGrant())).resolves.toEqual({
      ok: false,
      error: 'stale-attempt',
    });
    reader.resolve({ ok: true, bytes: pngBytes() });

    await expect(issuing).resolves.toEqual({ ok: false, error: 'stale-attempt' });
    activeOwner = freshOwner;
    expectResolveError(registry, freshOwner, ['asset-race-release' as HtmlAssetId], 'missing-asset');
    expect(registry.getActiveOwnerLifecycleCountForTesting()).toBe(0);
  });

  it('propagates unexpected reader rejections to the IPC boundary', async () => {
    const registry = new HtmlExportAssetRegistry({
      assetReader: async () => Promise.reject(new Error('reader defect')),
      isAttemptActive: ACTIVE_ATTEMPT,
    });

    await expect(registry.issueFromExplicitSelection(OWNER, assetGrant())).rejects.toThrow('reader defect');
    expect(registry.getActiveOwnerLifecycleCountForTesting()).toBe(0);
  });

  it('returns stale-attempt after invalidation and webContents release', async () => {
    const registry = registryWithBytes();
    const invalidatedId = await issue(registry);
    registry.invalidateAttempt(OWNER);
    expectResolveError(registry, OWNER, [invalidatedId], 'stale-attempt');

    const releasedId = await issue(registry, { webContentsId: 42, attemptId: 'attempt-c' });
    registry.releaseWebContents(42);
    expectResolveError(
      registry,
      { webContentsId: 42, attemptId: 'attempt-c' },
      [releasedId],
      'stale-attempt',
    );
  });
});
