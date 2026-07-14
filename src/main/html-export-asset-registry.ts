import { randomUUID } from 'node:crypto';
import { basename, extname } from 'node:path';

import {
  nodeAssetReadFs,
  readFdBoundAsset,
  type AssetReadErrorKind,
  type AssetReadResult,
} from './asset-file-reader';
import type { ExplicitAssetFileGrant } from './file-grants';
import {
  validateRasterHeader,
  type RasterValidationError,
} from './raster-validate';
import {
  HTML_EXPORT_RETAINED_ASSET_MAX_COUNT,
  RASTER_MAX_PIXELS,
  type HtmlAssetId,
  type HtmlAssetSummary,
} from '../shared/html-export-assets';
import { HTML_EXPORT_STAGE_ARTIFACT_MAX_BYTES } from '../shared/html-export-pipeline';

export interface HtmlAssetOwner {
  readonly webContentsId: number;
  readonly attemptId: string;
}

export interface ResolvedRasterAsset extends HtmlAssetSummary {
  readonly bytes: Uint8Array;
}

export type AssetResolutionError =
  | 'missing-asset'
  | 'duplicate-asset'
  | 'wrong-owner'
  | 'stale-attempt'
  | 'asset-budget-exceeded';

export type HtmlAssetUuidFactory = () => string;
export type HtmlAssetReader = (grant: ExplicitAssetFileGrant) => Promise<AssetReadResult>;
export type HtmlAssetAttemptActiveChecker = (owner: HtmlAssetOwner) => boolean;
export type AssetIssueError = AssetReadErrorKind | RasterValidationError | 'stale-attempt' | 'asset-budget-exceeded';

interface AssetRecord {
  readonly owner: HtmlAssetOwner;
  readonly summary: HtmlAssetSummary;
  bytes?: Buffer;
}
interface OwnerLifecycle {
  readonly owner: HtmlAssetOwner;
  invalidated: boolean;
  released: boolean;
  issuanceCount: number;
}


const ASSET_TOMBSTONE_CAP = 64;
const HTML_EXPORT_IN_FLIGHT_ASSET_MAX_PER_OWNER = 8;
const HTML_EXPORT_IN_FLIGHT_ASSET_MAX_PER_SENDER = HTML_EXPORT_RETAINED_ASSET_MAX_COUNT;
const HTML_EXPORT_IN_FLIGHT_ASSET_MAX_GLOBAL = HTML_EXPORT_RETAINED_ASSET_MAX_COUNT * 4;
const OWNER_KEY_SEPARATOR = '\u0000';

function copySummary(summary: HtmlAssetSummary): HtmlAssetSummary {
  return { ...summary };
}

function sameOwner(left: HtmlAssetOwner, right: HtmlAssetOwner): boolean {
  return left.webContentsId === right.webContentsId && left.attemptId === right.attemptId;
}
function zeroBytes(bytes: readonly Uint8Array[]): void {
  for (const value of bytes) value.fill(0);
}


function defaultAssetReader(grant: ExplicitAssetFileGrant): Promise<AssetReadResult> {
  return readFdBoundAsset(grant, nodeAssetReadFs);
}

/**
 * Main-process-only ownership for raster bytes selected through the OS picker.
 * Renderer-visible values are copied metadata and opaque IDs; paths and bytes
 * never leave this registry.
 */
export class HtmlExportAssetRegistry {
  private readonly assets = new Map<HtmlAssetId, AssetRecord>();
  private readonly tombstoneIds: HtmlAssetId[] = [];
  private readonly uuidFactory: HtmlAssetUuidFactory;
  private readonly assetReader: HtmlAssetReader;
  private readonly activeOwnerLifecycles = new Map<string, OwnerLifecycle>();
  private readonly isAttemptActive: HtmlAssetAttemptActiveChecker;
  private readonly inFlightBySender = new Map<number, number>();
  private inFlightIssuanceCount = 0;

  constructor({
    uuidFactory = randomUUID,
    assetReader = defaultAssetReader,
    isAttemptActive = () => false,
  }: {
    uuidFactory?: HtmlAssetUuidFactory;
    assetReader?: HtmlAssetReader;
    isAttemptActive?: HtmlAssetAttemptActiveChecker;
  } = {}) {
    this.uuidFactory = uuidFactory;
    this.assetReader = assetReader;
    this.isAttemptActive = isAttemptActive;
  }

  async issueFromExplicitSelection(
    owner: HtmlAssetOwner,
    grant: ExplicitAssetFileGrant,
  ): Promise<
    | { readonly ok: true; readonly asset: HtmlAssetSummary }
    | { readonly ok: false; readonly error: AssetIssueError }
  > {
    if (grant.kind !== 'file' || grant.source !== 'asset-picker') {
      return { ok: false, error: 'identity-mismatch' };
    }

    const admission = this.beginIssuance(owner);
    if (!admission.lifecycle) return { ok: false, error: admission.error };

    const { lifecycle } = admission;
    try {
      const readResult = await this.assetReader(grant);
      if (!readResult.ok) return readResult;

      try {
        if (!this.isCurrentLifecycle(lifecycle)) return { ok: false, error: 'stale-attempt' };

        const validation = validateRasterHeader(readResult.bytes, extname(grant.realpath));
        if (!validation.ok) return validation;

        const pixels = BigInt(validation.value.width) * BigInt(validation.value.height);
        if (!this.isCurrentLifecycle(lifecycle)) return { ok: false, error: 'stale-attempt' };
        if (!this.canRetain(lifecycle.owner, validation.value.base64EncodedBytes, pixels)) {
          return { ok: false, error: 'asset-budget-exceeded' };
        }

        const assetId = this.nextAssetId();
        const summary: HtmlAssetSummary = {
          assetId,
          basename: basename(grant.realpath),
          mime: validation.value.mime,
          width: validation.value.width,
          height: validation.value.height,
          encodedBytes: validation.value.base64EncodedBytes,
        };
        this.assets.set(assetId, {
          owner: { ...lifecycle.owner },
          summary,
          bytes: Buffer.from(readResult.bytes),
        });

        return { ok: true, asset: copySummary(summary) };
      } finally {
        readResult.bytes.fill(0);
      }
    } finally {
      this.finishIssuance(lifecycle);
    }
  }

  resolveForAttempt(
    owner: HtmlAssetOwner,
    assetIds: readonly HtmlAssetId[],
    maxBase64Bytes: number,
  ):
    | { readonly ok: true; readonly assets: readonly ResolvedRasterAsset[] }
    | { readonly ok: false; readonly error: AssetResolutionError } {
    if (!this.isAttemptActiveNow(owner)) return { ok: false, error: 'stale-attempt' };
    if (
      !Number.isSafeInteger(maxBase64Bytes)
      || maxBase64Bytes < 0
      || assetIds.length > HTML_EXPORT_RETAINED_ASSET_MAX_COUNT
    ) {
      return { ok: false, error: 'asset-budget-exceeded' };
    }

    const seen = new Set<HtmlAssetId>();
    for (const assetId of assetIds) {
      if (seen.has(assetId)) return { ok: false, error: 'duplicate-asset' };
      seen.add(assetId);
    }

    const records: AssetRecord[] = [];
    let totalBase64Bytes = 0;
    let totalPixels = 0n;
    for (const assetId of assetIds) {
      const record = this.assets.get(assetId);
      if (!record) return { ok: false, error: 'missing-asset' };
      if (record.owner.webContentsId !== owner.webContentsId) {
        return { ok: false, error: 'wrong-owner' };
      }
      if (record.owner.attemptId !== owner.attemptId || !record.bytes) {
        return { ok: false, error: 'stale-attempt' };
      }

      totalBase64Bytes += record.summary.encodedBytes;
      totalPixels += BigInt(record.summary.width) * BigInt(record.summary.height);
      if (
        totalBase64Bytes > maxBase64Bytes
        || totalPixels > BigInt(RASTER_MAX_PIXELS)
      ) {
        return { ok: false, error: 'asset-budget-exceeded' };
      }
      records.push(record);
    }

    if (!this.isAttemptActiveNow(owner)) return { ok: false, error: 'stale-attempt' };

    const copiedBytes: Uint8Array[] = [];
    const resolved: ResolvedRasterAsset[] = [];
    try {
      for (const record of records) {
        const summary = copySummary(record.summary);
        const bytes = Buffer.from(record.bytes!);
        copiedBytes.push(bytes);
        resolved.push({ ...summary, bytes });
      }
      if (!this.isAttemptActiveNow(owner)) {
        zeroBytes(copiedBytes);
        return { ok: false, error: 'stale-attempt' };
      }
      return { ok: true, assets: resolved };
    } catch (error) {
      zeroBytes(copiedBytes);
      throw error;
    }
  }

  invalidateAttempt(owner: HtmlAssetOwner): void {
    const lifecycle = this.activeOwnerLifecycles.get(this.ownerKey(owner));
    if (lifecycle) lifecycle.invalidated = true;
    for (const [assetId, record] of this.assets) {
      if (sameOwner(record.owner, owner)) this.tombstone(assetId, record);
    }
  }

  releaseWebContents(webContentsId: number): void {
    for (const lifecycle of this.activeOwnerLifecycles.values()) {
      if (lifecycle.owner.webContentsId === webContentsId) lifecycle.released = true;
    }
    for (const [assetId, record] of this.assets) {
      if (record.owner.webContentsId === webContentsId) this.tombstone(assetId, record);
    }
  }

  /** Test-only lifecycle visibility. */
  getActiveOwnerLifecycleCountForTesting(): number {
    return this.activeOwnerLifecycles.size;
  }

  private beginIssuance(
    owner: HtmlAssetOwner,
  ): { readonly lifecycle: OwnerLifecycle; readonly error?: never } | {
    readonly lifecycle?: never;
    readonly error: 'stale-attempt' | 'asset-budget-exceeded';
  } {
    if (!this.isAttemptActiveNow(owner)) return { error: 'stale-attempt' };

    const ownerKey = this.ownerKey(owner);
    const existing = this.activeOwnerLifecycles.get(ownerKey);
    if (existing && !this.isCurrentLifecycle(existing)) return { error: 'stale-attempt' };

    const ownerInFlight = existing?.issuanceCount ?? 0;
    const senderInFlight = this.inFlightBySender.get(owner.webContentsId) ?? 0;
    if (
      ownerInFlight >= HTML_EXPORT_IN_FLIGHT_ASSET_MAX_PER_OWNER
      || senderInFlight >= HTML_EXPORT_IN_FLIGHT_ASSET_MAX_PER_SENDER
      || this.inFlightIssuanceCount >= HTML_EXPORT_IN_FLIGHT_ASSET_MAX_GLOBAL
    ) {
      return { error: 'asset-budget-exceeded' };
    }

    const lifecycle = existing ?? {
      owner: { ...owner },
      invalidated: false,
      released: false,
      issuanceCount: 0,
    };
    lifecycle.issuanceCount += 1;
    this.inFlightIssuanceCount += 1;
    this.inFlightBySender.set(owner.webContentsId, senderInFlight + 1);
    this.activeOwnerLifecycles.set(ownerKey, lifecycle);
    return { lifecycle };
  }

  private finishIssuance(lifecycle: OwnerLifecycle): void {
    lifecycle.issuanceCount -= 1;
    this.inFlightIssuanceCount -= 1;

    const senderInFlight = this.inFlightBySender.get(lifecycle.owner.webContentsId) ?? 0;
    if (senderInFlight <= 1) this.inFlightBySender.delete(lifecycle.owner.webContentsId);
    else this.inFlightBySender.set(lifecycle.owner.webContentsId, senderInFlight - 1);

    if (lifecycle.issuanceCount === 0) {
      this.activeOwnerLifecycles.delete(this.ownerKey(lifecycle.owner));
    }
  }

  private ownerKey(owner: HtmlAssetOwner): string {
    return `${owner.webContentsId}${OWNER_KEY_SEPARATOR}${owner.attemptId}`;
  }

  private isCurrentLifecycle(lifecycle: OwnerLifecycle): boolean {
    return !lifecycle.invalidated && !lifecycle.released && this.isAttemptActiveNow(lifecycle.owner);
  }

  private isAttemptActiveNow(owner: HtmlAssetOwner): boolean {
    try {
      return this.isAttemptActive(owner);
    } catch {
      return false;
    }
  }

  private canRetain(owner: HtmlAssetOwner, encodedBytes: number, pixels: bigint): boolean {
    let count = 0;
    let totalEncodedBytes = 0;
    let totalPixels = 0n;
    for (const record of this.assets.values()) {
      if (sameOwner(record.owner, owner) && record.bytes) {
        count += 1;
        totalEncodedBytes += record.summary.encodedBytes;
        totalPixels += BigInt(record.summary.width) * BigInt(record.summary.height);
      }
    }
    return count < HTML_EXPORT_RETAINED_ASSET_MAX_COUNT
      && totalEncodedBytes + encodedBytes <= HTML_EXPORT_STAGE_ARTIFACT_MAX_BYTES
      && totalPixels + pixels <= BigInt(RASTER_MAX_PIXELS);
  }
  private nextAssetId(): HtmlAssetId {
    const id = this.uuidFactory() as HtmlAssetId;
    if (!id || this.assets.has(id)) {
      throw new Error('HTML asset UUID factory returned a duplicate or empty asset ID');
    }
    return id;
  }

  private tombstone(assetId: HtmlAssetId, record: AssetRecord): void {
    if (!record.bytes) return;
    record.bytes.fill(0);
    record.bytes = undefined;
    this.tombstoneIds.push(assetId);

    while (this.tombstoneIds.length > ASSET_TOMBSTONE_CAP) {
      const expiredAssetId = this.tombstoneIds.shift();
      if (expiredAssetId) this.assets.delete(expiredAssetId);
    }
  }
}
