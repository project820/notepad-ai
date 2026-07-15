import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  ASSET_OPEN_FLAGS,
  readFdBoundAsset,
  type AssetFileHandle,
  type AssetReadFs,
  type FdStat,
} from '../main/asset-file-reader';
import { base64EncodedLength, validateRasterHeader } from '../main/raster-validate';
import {
  ASSET_BASE64_ENCODED_MAX_BYTES,
  ASSET_SOURCE_READ_MAX_BYTES,
  RASTER_MAX_HEIGHT,
  RASTER_MAX_PIXELS,
  RASTER_MAX_WIDTH,
} from '../shared/html-export-assets';
import type { ExplicitAssetFileGrant } from '../main/file-grants';

function stat(overrides: Partial<FdStat> = {}): FdStat {
  return {
    dev: 7n,
    ino: 9n,
    size: 3n,
    mtimeNs: 11n,
    ctimeNs: 13n,
    isFile: () => true,
    ...overrides,
  };
}

function grant(): ExplicitAssetFileGrant {
  return {
    realpath: '/authorized/image.png',
    identity: '7:9' as ExplicitAssetFileGrant['identity'],
    kind: 'file',
    source: 'asset-picker',
  };
}
type FakeHandleFailures = {
  readonly statAt?: number;
  readonly readAt?: number;
};


class FakeHandle implements AssetFileHandle {
  private statIndex = 0;
  private readIndex = 0;

  constructor(
    private readonly data: Uint8Array,
    private readonly stats: readonly FdStat[],
    private readonly calls: string[],
    private readonly closeError = false,
    private readonly failures: FakeHandleFailures = {},
  ) {}

  async stat(): Promise<FdStat> {
    this.calls.push('stat');
    const attempt = this.statIndex++;
    if (attempt === this.failures.statAt) throw new Error('stat failed');
    return this.stats[Math.min(attempt, this.stats.length - 1)];
  }

  async read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }> {
    this.calls.push(`read:${length}:${position}`);
    const attempt = this.readIndex++;
    if (attempt === this.failures.readAt) throw new Error('read failed');
    const bytesRead = Math.min(length, Math.max(0, this.data.length - position));
    buffer.set(this.data.subarray(position, position + bytesRead), offset);
    return { bytesRead };
  }

  async close(): Promise<void> {
    this.calls.push('close');
    if (this.closeError) throw new Error('close failed');
  }
}

function readerFor(
  data: Uint8Array,
  stats: readonly FdStat[] = [stat(), stat()],
  closeError = false,
  failures: FakeHandleFailures = {},
): { readonly fs: AssetReadFs; readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fs: {
      open: async (path, flags) => {
        calls.push(`open:${path}:${flags}`);
        return new FakeHandle(data, stats, calls, closeError, failures);
      },
    },
  };
}

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([0x08, 0x06, 0x00, 0x00, 0x00], 24);
  return bytes;
}

function jpeg(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08,
    height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03,
    0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
  ]);
}

function webpVp8(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 22, true);
  view.setUint32(16, 10, true);
  bytes[20] = 0x10;
  bytes.set([0x9d, 0x01, 0x2a], 23);
  view.setUint16(26, width, true);
  view.setUint16(28, height, true);
  return bytes;
}

function webpVp8l(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(26);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 18, true);
  view.setUint32(16, 5, true);
  bytes.set(vp8lPayload(width, height), 20);
  return bytes;
}

function vp8lPayload(width: number, height: number, hasAlpha = false): Uint8Array {
  const payload = new Uint8Array(5);
  payload[0] = 0x2f;
  new DataView(payload.buffer).setUint32(
    1,
    (width - 1) | ((height - 1) << 14) | (hasAlpha ? 0x10000000 : 0),
    true,
  );
  return payload;
}

function webpVp8x(width: number, height: number): Uint8Array {
  return webpContainer([
    { tag: 'VP8X', payload: vp8xPayload(0, width, height) },
    { tag: 'VP8 ', payload: vp8Payload(width, height) },
  ]);
}
type WebpChunk = { readonly tag: string; readonly payload: Uint8Array };

function webpContainer(chunks: readonly WebpChunk[]): Uint8Array {
  const length = 12 + chunks.reduce((total, chunk) => total + 8 + chunk.payload.length + (chunk.payload.length % 2), 0);
  const bytes = new Uint8Array(length);
  bytes.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  new DataView(bytes.buffer).setUint32(4, length - 8, true);
  let offset = 12;
  for (const chunk of chunks) {
    bytes.set(Array.from(chunk.tag, (character) => character.charCodeAt(0)), offset);
    new DataView(bytes.buffer).setUint32(offset + 4, chunk.payload.length, true);
    bytes.set(chunk.payload, offset + 8);
    offset += 8 + chunk.payload.length + (chunk.payload.length % 2);
  }
  return bytes;
}

function vp8Payload(width: number, height: number): Uint8Array {
  const payload = new Uint8Array(10);
  payload.set([0x10, 0, 0, 0x9d, 0x01, 0x2a]);
  const view = new DataView(payload.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return payload;
}

function vp8xPayload(flags: number, width: number, height: number): Uint8Array {
  const payload = new Uint8Array(10);
  payload[0] = flags;
  payload.set([width - 1 & 0xff, (width - 1) >> 8 & 0xff, (width - 1) >> 16 & 0xff], 4);
  payload.set([height - 1 & 0xff, (height - 1) >> 8 & 0xff, (height - 1) >> 16 & 0xff], 7);
  return payload;
}

function writeU24(bytes: Uint8Array, offset: number, value: number): void {
  bytes.set([value & 0xff, value >> 8 & 0xff, value >> 16 & 0xff], offset);
}

function anmfPayload(
  rawX: number,
  rawY: number,
  width: number,
  height: number,
  children: readonly WebpChunk[] = [{ tag: 'VP8 ', payload: vp8Payload(width, height) }],
): Uint8Array {
  const length = 16 + children.reduce((total, child) => total + 8 + child.payload.length + (child.payload.length % 2), 0);
  const payload = new Uint8Array(length);
  writeU24(payload, 0, rawX);
  writeU24(payload, 3, rawY);
  writeU24(payload, 6, width - 1);
  writeU24(payload, 9, height - 1);
  let offset = 16;
  for (const child of children) {
    payload.set(Array.from(child.tag, (character) => character.charCodeAt(0)), offset);
    new DataView(payload.buffer).setUint32(offset + 4, child.payload.length, true);
    payload.set(child.payload, offset + 8);
    offset += 8 + child.payload.length + (child.payload.length % 2);
  }
  return payload;
}

function gif(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(13);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  const view = new DataView(bytes.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return bytes;
}

describe('fd-bound HTML asset reads', () => {
  it('opens once with Node O_NOFOLLOW and reads, refstats, then closes that same handle', async () => {
    expect(ASSET_OPEN_FLAGS & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW);
    const reader = readerFor(Uint8Array.from([1, 2, 3]));

    await expect(readFdBoundAsset(grant(), reader.fs)).resolves.toEqual({
      ok: true,
      bytes: Uint8Array.from([1, 2, 3]),
    });
    expect(reader.calls).toEqual([
      `open:/authorized/image.png:${ASSET_OPEN_FLAGS}`,
      'stat',
      'read:4:0',
      'read:1:3',
      'stat',
      'close',
    ]);
  });

  const identityMismatchCases: readonly [string, Partial<FdStat>][] = [
    ['device', { dev: 8n }],
    ['inode', { ino: 10n }],
  ];
  it.each(identityMismatchCases)('rejects pre-read %s mismatch with one descriptor lifecycle', async (_name, changed) => {
    const reader = readerFor(Uint8Array.from([1, 2, 3]), [stat(changed)]);

    await expect(readFdBoundAsset(grant(), reader.fs)).resolves.toEqual({
      ok: false,
      error: 'identity-mismatch',
    });
    expect(reader.calls.filter((call) => call.startsWith('open:'))).toHaveLength(1);
    expect(reader.calls.filter((call) => call === 'close')).toHaveLength(1);
  });
  it('rejects a non-regular opened descriptor with a pathless error and one close', async () => {
    const reader = readerFor(Uint8Array.from([1, 2, 3]), [stat({ isFile: () => false })]);

    await expect(readFdBoundAsset(grant(), reader.fs)).resolves.toEqual({
      ok: false,
      error: 'not-regular-file',
    });
    expect(reader.calls).toEqual([
      `open:/authorized/image.png:${ASSET_OPEN_FLAGS}`,
      'stat',
      'close',
    ]);
  });

  const descriptorFailureCases: readonly [string, readonly FdStat[], FakeHandleFailures, readonly string[]][] = [
    ['initial stat', [stat()], { statAt: 0 }, ['stat']],
    ['post-read stat', [stat(), stat()], { statAt: 1 }, ['stat', 'read:4:0', 'read:1:3', 'stat']],
    ['read', [stat()], { readAt: 0 }, ['stat', 'read:4:0']],
  ];
  it.each(descriptorFailureCases)('returns a pathless read error and closes once when %s throws', async (
    _name,
    stats,
    failures,
    operations,
  ) => {
    const reader = readerFor(Uint8Array.from([1, 2, 3]), stats, false, failures);

    await expect(readFdBoundAsset(grant(), reader.fs)).resolves.toEqual({
      ok: false,
      error: 'read-failed',
    });
    expect(reader.calls).toEqual([
      `open:/authorized/image.png:${ASSET_OPEN_FLAGS}`,
      ...operations,
      'close',
    ]);
  });

  const changedSnapshotCases: readonly [string, Partial<FdStat>][] = [
    ['size', { size: 4n }],
    ['mtimeNs', { mtimeNs: 14n }],
    ['ctimeNs', { ctimeNs: 15n }],
  ];
  it.each(changedSnapshotCases)('rejects post-read %s changes with one descriptor lifecycle', async (_name, changed) => {
    const reader = readerFor(Uint8Array.from([1, 2, 3]), [stat(), stat(changed)]);

    await expect(readFdBoundAsset(grant(), reader.fs)).resolves.toEqual({
      ok: false,
      error: 'changed-during-read',
    });
    expect(reader.calls.filter((call) => call.startsWith('open:'))).toHaveLength(1);
    expect(reader.calls.filter((call) => call === 'close')).toHaveLength(1);
  });

  it('rejects a stream that exceeds its initially advertised source cap and closes it', async () => {
    const advertisedSize = ASSET_SOURCE_READ_MAX_BYTES;
    const reader = readerFor(
      new Uint8Array(advertisedSize + 1),
      [stat({ size: BigInt(advertisedSize) }), stat({ size: BigInt(advertisedSize) })],
    );

    await expect(readFdBoundAsset(grant(), reader.fs)).resolves.toEqual({
      ok: false,
      error: 'asset-too-large',
    });
    expect(reader.calls).toContain(`read:1:${advertisedSize}`);
    expect(reader.calls.filter((call) => call.startsWith('open:'))).toHaveLength(1);
    expect(reader.calls.filter((call) => call === 'close')).toHaveLength(1);
  });

  it('returns the exact source-cap byte count with sentinel bytes preserved and fails closed when close fails', async () => {
    const exact = new Uint8Array(1_572_864);
    exact.set([0x89, 0x50, 0x4e, 0x47], 0);
    exact.set([0xa5, 0x5a], exact.length - 2);
    const exactReader = readerFor(exact, [stat({ size: BigInt(exact.length) }), stat({ size: BigInt(exact.length) })]);
    const exactResult = await readFdBoundAsset(grant(), exactReader.fs);
    expect(exactResult).toMatchObject({ ok: true });
    if (!exactResult.ok) throw new Error(exactResult.error);
    expect(exactResult.bytes).toHaveLength(1_572_864);
    expect(exactResult.bytes.subarray(0, 4)).toEqual(Uint8Array.of(0x89, 0x50, 0x4e, 0x47));
    expect(exactResult.bytes.subarray(-2)).toEqual(Uint8Array.of(0xa5, 0x5a));

    const oversized = readerFor(Uint8Array.of(1), [stat({ size: BigInt(ASSET_SOURCE_READ_MAX_BYTES + 1) })]);
    await expect(readFdBoundAsset(grant(), oversized.fs)).resolves.toEqual({ ok: false, error: 'asset-too-large' });
    expect(oversized.calls).toEqual([`open:/authorized/image.png:${ASSET_OPEN_FLAGS}`, 'stat', 'close']);

    const closeFails = readerFor(Uint8Array.from([1, 2, 3]), [stat(), stat()], true);
    await expect(readFdBoundAsset(grant(), closeFails.fs)).resolves.toEqual({ ok: false, error: 'close-failed' });
  });
});

describe('header-only raster validation', () => {
  const rasterCases: readonly [string, Uint8Array, string, string, number][] = [
    ['PNG', png(20, 10), '.png', 'image/png', 44],
    ['JPEG', jpeg(20, 10), '.jpg', 'image/jpeg', 28],
    ['WebP VP8', webpVp8(20, 10), '.webp', 'image/webp', 40],
    ['WebP VP8L', webpVp8l(20, 10), '.webp', 'image/webp', 36],
    ['WebP VP8X', webpVp8x(20, 10), '.webp', 'image/webp', 64],
    ['GIF', gif(20, 10), '.gif', 'image/gif', 20],
  ];
  it.each(rasterCases)('accepts a valid %s header deterministically', (_name, bytes, extension, mime, base64EncodedBytes) => {
    expect(validateRasterHeader(bytes, extension)).toEqual({
      ok: true,
      value: {
        mime,
        width: 20,
        height: 10,
        sourceBytes: bytes.length,
        base64EncodedBytes,
      },
    });
  });
  it.each([
    ['opaque static', webpVp8x(20, 10), 20, 10],
    ['transparent static with ALPH preprocessing=1', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0x10, 20, 10) },
      { tag: 'ALPH', payload: Uint8Array.of(0x10, 0) },
      { tag: 'VP8 ', payload: vp8Payload(20, 10) },
    ]), 20, 10],
    ['transparent static with VP8L intrinsic alpha', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0x10, 20, 10) },
      { tag: 'VP8L', payload: vp8lPayload(20, 10, true) },
    ]), 20, 10],
    ['opaque animated', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0x02, 4, 1) },
      { tag: 'ANIM', payload: new Uint8Array(6) },
      { tag: 'ANMF', payload: anmfPayload(1, 0, 2, 1) },
    ]), 4, 1],
    ['opaque animated with two frame-local image states', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0x02, 4, 1) },
      { tag: 'ANIM', payload: new Uint8Array(6) },
      { tag: 'ANMF', payload: anmfPayload(0, 0, 2, 1) },
      { tag: 'ANMF', payload: anmfPayload(1, 0, 2, 1) },
    ]), 4, 1],
    ['mixed-alpha animated frames aggregate to the declared alpha state', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0x12, 4, 1) },
      { tag: 'ANIM', payload: new Uint8Array(6) },
      { tag: 'ANMF', payload: anmfPayload(0, 0, 2, 1, [
        { tag: 'ALPH', payload: Uint8Array.of(0x10, 0) },
        { tag: 'VP8 ', payload: vp8Payload(2, 1) },
      ]) },
      { tag: 'ANMF', payload: anmfPayload(1, 0, 2, 1) },
    ]), 4, 1],
    ['transparent animated', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0x12, 4, 1) },
      { tag: 'ANIM', payload: new Uint8Array(6) },
      { tag: 'ANMF', payload: anmfPayload(1, 0, 2, 1, [
        { tag: 'ALPH', payload: Uint8Array.of(0x10, 0) },
        { tag: 'VP8 ', payload: vp8Payload(2, 1) },
      ]) },
    ]), 4, 1],
    ['transparent animated with VP8L intrinsic alpha', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0x12, 4, 1) },
      { tag: 'ANIM', payload: new Uint8Array(6) },
      { tag: 'ANMF', payload: anmfPayload(1, 0, 2, 1, [
        { tag: 'VP8L', payload: vp8lPayload(2, 1, true) },
      ]) },
    ]), 4, 1],
  ] as const)('accepts valid %s WebP state paths', (_description, bytes, width, height) => {
    expect(validateRasterHeader(bytes, '.webp')).toMatchObject({
      ok: true,
      value: { mime: 'image/webp', width, height },
    });
  });

  it.each([
    ['duplicate simple image', webpContainer([
      { tag: 'VP8 ', payload: vp8Payload(2, 1) },
      { tag: 'VP8 ', payload: vp8Payload(2, 1) },
    ])],
    ['mixed simple images', webpContainer([
      { tag: 'VP8 ', payload: vp8Payload(2, 1) },
      { tag: 'VP8L', payload: Uint8Array.of(0x2f, 1, 0, 0, 0) },
    ])],
    ['short extended header', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0, 2, 1).subarray(0, 9) },
    ])],
    ['extended unsupported flag', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0x01, 2, 1) },
      { tag: 'VP8 ', payload: vp8Payload(2, 1) },
    ])],
    ['extended reserved flag', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0x80, 2, 1) },
      { tag: 'VP8 ', payload: vp8Payload(2, 1) },
    ])],
    ['extended alpha after image', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0x10, 2, 1) },
      { tag: 'VP8 ', payload: vp8Payload(2, 1) },
      { tag: 'ALPH', payload: Uint8Array.of(0, 0) },
    ])],
    ['extended undeclared alpha', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0, 2, 1) },
      { tag: 'ALPH', payload: Uint8Array.of(0, 0) },
      { tag: 'VP8 ', payload: vp8Payload(2, 1) },
    ])],
    ['extended missing declared alpha', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0x10, 2, 1) },
      { tag: 'VP8 ', payload: vp8Payload(2, 1) },
    ])],
    ['extended alpha flag without VP8L intrinsic alpha', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0x10, 2, 1) },
      { tag: 'VP8L', payload: Uint8Array.of(0x2f, 1, 0, 0, 0) },
    ])],
    ['extended VP8L intrinsic alpha without alpha flag', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0, 2, 1) },
      { tag: 'VP8L', payload: vp8lPayload(2, 1, true) },
    ])],
    ['extended duplicate alpha', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0x10, 2, 1) },
      { tag: 'ALPH', payload: Uint8Array.of(0, 0) },
      { tag: 'ALPH', payload: Uint8Array.of(0, 0) },
      { tag: 'VP8 ', payload: vp8Payload(2, 1) },
    ])],
    ['extended alpha with VP8L', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0x10, 2, 1) },
      { tag: 'ALPH', payload: Uint8Array.of(0, 0) },
      { tag: 'VP8L', payload: Uint8Array.of(0x2f, 1, 0, 0, 0) },
    ])],
    ['ALPH without alpha payload', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0x10, 2, 1) },
      { tag: 'ALPH', payload: Uint8Array.of(0) },
      { tag: 'VP8 ', payload: vp8Payload(2, 1) },
    ])],
    ['ALPH with unsupported compression', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0x10, 2, 1) },
      { tag: 'ALPH', payload: Uint8Array.of(0x01, 0) },
      { tag: 'VP8 ', payload: vp8Payload(2, 1) },
    ])],
    ['ALPH with unsupported compression mode 2', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0x10, 2, 1) },
      { tag: 'ALPH', payload: Uint8Array.of(0x02, 0) },
      { tag: 'VP8 ', payload: vp8Payload(2, 1) },
    ])],
    ['ALPH with unsupported compression mode 3', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0x10, 2, 1) },
      { tag: 'ALPH', payload: Uint8Array.of(0x03, 0) },
      { tag: 'VP8 ', payload: vp8Payload(2, 1) },
    ])],
    ['ALPH with unsupported preprocessing', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0x10, 2, 1) },
      { tag: 'ALPH', payload: Uint8Array.of(0x20, 0) },
      { tag: 'VP8 ', payload: vp8Payload(2, 1) },
    ])],
    ['ALPH with reserved bits', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0x10, 2, 1) },
      { tag: 'ALPH', payload: Uint8Array.of(0x40, 0) },
      { tag: 'VP8 ', payload: vp8Payload(2, 1) },
    ])],
    ['ALPH with reserved high bit', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0x10, 2, 1) },
      { tag: 'ALPH', payload: Uint8Array.of(0x80, 0) },
      { tag: 'VP8 ', payload: vp8Payload(2, 1) },
    ])],
    ['animated missing ANIM', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0x02, 4, 1) },
      { tag: 'ANMF', payload: anmfPayload(1, 0, 2, 1) },
    ])],
    ['animated short ANIM', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0x02, 2, 1) },
      { tag: 'ANIM', payload: new Uint8Array(5) },
    ])],
    ['animated top-level alpha', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0x02, 2, 1) },
      { tag: 'ANIM', payload: new Uint8Array(6) },
      { tag: 'ALPH', payload: Uint8Array.of(0) },
    ])],
    ['animated frame alpha without declaration', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0x02, 2, 1) },
      { tag: 'ANIM', payload: new Uint8Array(6) },
      { tag: 'ANMF', payload: anmfPayload(0, 0, 2, 1, [
        { tag: 'ALPH', payload: Uint8Array.of(0, 0) },
        { tag: 'VP8 ', payload: vp8Payload(2, 1) },
      ]) },
    ])],
    ['animated alpha flag without alpha in any frame', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0x12, 2, 1) },
      { tag: 'ANIM', payload: new Uint8Array(6) },
      { tag: 'ANMF', payload: anmfPayload(0, 0, 2, 1) },
    ])],
    ['animated VP8L intrinsic alpha without alpha flag', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0x02, 2, 1) },
      { tag: 'ANIM', payload: new Uint8Array(6) },
      { tag: 'ANMF', payload: anmfPayload(0, 0, 2, 1, [
        { tag: 'VP8L', payload: vp8lPayload(2, 1, true) },
      ]) },
    ])],
    ['animated alpha with VP8L', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0x12, 2, 1) },
      { tag: 'ANIM', payload: new Uint8Array(6) },
      { tag: 'ANMF', payload: anmfPayload(0, 0, 2, 1, [
        { tag: 'ALPH', payload: Uint8Array.of(0, 0) },
        { tag: 'VP8L', payload: Uint8Array.of(0x2f, 1, 0, 0, 0) },
      ]) },
    ])],
    ['animated top-level image', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0x02, 2, 1) },
      { tag: 'ANIM', payload: new Uint8Array(6) },
      { tag: 'VP8 ', payload: vp8Payload(2, 1) },
    ])],
    ['animated missing frame', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0x02, 2, 1) },
      { tag: 'ANIM', payload: new Uint8Array(6) },
    ])],
    ['extended conflicting dimensions', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0, 3, 1) },
      { tag: 'VP8 ', payload: vp8Payload(2, 1) },
    ])],
  ] as const)('rejects WebP state-machine violation: %s', (_description, bytes) => {
    expect(validateRasterHeader(bytes, '.webp')).toEqual({ ok: false, error: 'malformed-header' });
  });
  it.each([
    ['ANMF raw X offset doubles beyond the canvas', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0x02, 4, 4) },
      { tag: 'ANIM', payload: new Uint8Array(6) },
      { tag: 'ANMF', payload: anmfPayload(2, 0, 1, 1) },
    ])],
    ['ANMF raw Y offset doubles beyond the canvas', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0x02, 4, 4) },
      { tag: 'ANIM', payload: new Uint8Array(6) },
      { tag: 'ANMF', payload: anmfPayload(0, 2, 1, 1) },
    ])],
    ['truncated ANMF header', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0x02, 1, 1) },
      { tag: 'ANIM', payload: new Uint8Array(6) },
      { tag: 'ANMF', payload: new Uint8Array(15) },
    ])],
    ['complete ANMF header without an image child', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0x02, 1, 1) },
      { tag: 'ANIM', payload: new Uint8Array(6) },
      { tag: 'ANMF', payload: new Uint8Array(16) },
    ])],
    ['second ANMF cannot reuse the first frame image state', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0x02, 4, 1) },
      { tag: 'ANIM', payload: new Uint8Array(6) },
      { tag: 'ANMF', payload: anmfPayload(0, 0, 2, 1) },
      { tag: 'ANMF', payload: anmfPayload(1, 0, 2, 1, []) },
    ])],
    ['ANMF reserved header flags', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0x02, 1, 1) },
      { tag: 'ANIM', payload: new Uint8Array(6) },
      { tag: 'ANMF', payload: Uint8Array.from(anmfPayload(0, 0, 1, 1), (byte, index) => index === 15 ? 0x04 : byte) },
    ])],
    ['ANMF missing image child', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0x12, 1, 1) },
      { tag: 'ANIM', payload: new Uint8Array(6) },
      { tag: 'ANMF', payload: anmfPayload(0, 0, 1, 1, [
        { tag: 'ALPH', payload: Uint8Array.of(0, 0) },
      ]) },
    ])],
    ['ANMF duplicate image child', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0x02, 1, 1) },
      { tag: 'ANIM', payload: new Uint8Array(6) },
      { tag: 'ANMF', payload: anmfPayload(0, 0, 1, 1, [
        { tag: 'VP8 ', payload: vp8Payload(1, 1) },
        { tag: 'VP8 ', payload: vp8Payload(1, 1) },
      ]) },
    ])],
    ['ANMF mixed image children', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0x02, 1, 1) },
      { tag: 'ANIM', payload: new Uint8Array(6) },
      { tag: 'ANMF', payload: anmfPayload(0, 0, 1, 1, [
        { tag: 'VP8 ', payload: vp8Payload(1, 1) },
        { tag: 'VP8L', payload: Uint8Array.of(0x2f, 0, 0, 0, 0) },
      ]) },
    ])],
    ['ANMF malformed image child', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0x02, 1, 1) },
      { tag: 'ANIM', payload: new Uint8Array(6) },
      { tag: 'ANMF', payload: anmfPayload(0, 0, 1, 1, [
        { tag: 'VP8 ', payload: Uint8Array.of(0) },
      ]) },
    ])],
    ['ANMF image dimensions differ from its frame', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0x02, 2, 1) },
      { tag: 'ANIM', payload: new Uint8Array(6) },
      { tag: 'ANMF', payload: anmfPayload(0, 0, 2, 1, [
        { tag: 'VP8 ', payload: vp8Payload(1, 1) },
      ]) },
    ])],
    ['ANMF malformed declared alpha child', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0x12, 1, 1) },
      { tag: 'ANIM', payload: new Uint8Array(6) },
      { tag: 'ANMF', payload: anmfPayload(0, 0, 1, 1, [
        { tag: 'ALPH', payload: Uint8Array.of(0) },
        { tag: 'VP8 ', payload: vp8Payload(1, 1) },
      ]) },
    ])],
    ['VP8X without an image', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0, 1, 1) },
    ])],
    ['unknown top-level chunk in an otherwise valid static container', webpContainer([
      { tag: 'VP8 ', payload: vp8Payload(1, 1) },
      { tag: 'JUNK', payload: new Uint8Array() },
    ])],
    ['duplicate VP8X chunks in an otherwise valid extended static container', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0, 1, 1) },
      { tag: 'VP8X', payload: vp8xPayload(0, 1, 1) },
      { tag: 'VP8 ', payload: vp8Payload(1, 1) },
    ])],
    ['duplicate ANIM chunks in an otherwise valid animation container', webpContainer([
      { tag: 'VP8X', payload: vp8xPayload(0x02, 1, 1) },
      { tag: 'ANIM', payload: new Uint8Array(6) },
      { tag: 'ANIM', payload: new Uint8Array(6) },
      { tag: 'ANMF', payload: anmfPayload(0, 0, 1, 1) },
    ])],
    ['ANMF before its animation declaration', webpContainer([
      { tag: 'ANMF', payload: anmfPayload(0, 0, 1, 1) },
      { tag: 'VP8X', payload: vp8xPayload(0x02, 1, 1) },
      { tag: 'ANIM', payload: new Uint8Array(6) },
    ])],
  ] as const)('rejects discriminating animated WebP state-machine violation: %s', (_description, bytes) => {
    expect(validateRasterHeader(bytes, '.webp')).toEqual({ ok: false, error: 'malformed-header' });
  });

  it.each([
    [0, 3, 4],
    [1, 4, 8],
    [2, 5, 8],
  ] as const)('calculates the literal base64 length for source remainder %i', (_remainder, sourceBytes, expectedLength) => {
    expect(base64EncodedLength(sourceBytes)).toBe(expectedLength);
  });

  const headerVariants: readonly [string, (width: number, height: number) => Uint8Array, string][] = [
    ['PNG', png, '.png'],
    ['GIF', gif, '.gif'],
    ['JPEG', jpeg, '.jpg'],
    ['WebP VP8X', webpVp8x, '.webp'],
    ['WebP VP8', webpVp8, '.webp'],
    ['WebP VP8L', webpVp8l, '.webp'],
  ];
  it.each(headerVariants)('accepts exact and rejects max+1 raster boundaries for %s', (_name, createHeader, extension) => {
    expect(RASTER_MAX_WIDTH).toBe(8_192);
    expect(RASTER_MAX_HEIGHT).toBe(8_192);
    expect(RASTER_MAX_PIXELS).toBe(32_000_000);

    expect(validateRasterHeader(createHeader(8_192, 1), extension)).toMatchObject({
      ok: true,
      value: { width: 8_192, height: 1 },
    });
    expect(validateRasterHeader(createHeader(8_193, 1), extension)).toEqual({
      ok: false,
      error: 'dimension-limit',
    });

    expect(validateRasterHeader(createHeader(1, 8_192), extension)).toMatchObject({
      ok: true,
      value: { width: 1, height: 8_192 },
    });
    expect(validateRasterHeader(createHeader(1, 8_193), extension)).toEqual({
      ok: false,
      error: 'dimension-limit',
    });

    expect(validateRasterHeader(createHeader(8_000, 4_000), extension)).toMatchObject({
      ok: true,
      value: { width: 8_000, height: 4_000 },
    });
    expect(validateRasterHeader(createHeader(8_000, 4_001), extension)).toEqual({
      ok: false,
      error: 'pixel-limit',
    });
  });

  const malformedCases: readonly [string, Uint8Array, string][] = [
    ['PNG IHDR CRC', png(1, 1).subarray(0, 32), '.png'],
    ['JPEG SOF with truncated component descriptors', Uint8Array.from([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x08, 0x08,
      0x00, 0x0a, 0x00, 0x14, 0x03,
    ]), '.jpg'],
    ['GIF logical screen', gif(1, 1).subarray(0, 12), '.gif'],
    ['WebP VP8 payload', webpVp8(1, 1).subarray(0, 29), '.webp'],
    ['WebP VP8L padded payload', webpVp8l(1, 1).subarray(0, 25), '.webp'],
    ['WebP VP8X payload', webpVp8x(1, 1).subarray(0, 29), '.webp'],
  ];
  it.each(malformedCases)('rejects truncated or inconsistent %s headers', (_name, bytes, extension) => {
    expect(validateRasterHeader(bytes, extension)).toEqual({ ok: false, error: 'malformed-header' });
  });
  it('rejects malformed JPEG prefixes and WebP fixed fields', () => {
    const prefixedJpeg = jpeg(1, 1);
    prefixedJpeg[2] = 0xc0;
    expect(validateRasterHeader(prefixedJpeg, '.jpg')).toEqual({ ok: false, error: 'malformed-header' });

    const vp8lWithVersion = webpVp8l(1, 1);
    vp8lWithVersion[24] = 0x20;
    expect(validateRasterHeader(vp8lWithVersion, '.webp')).toEqual({ ok: false, error: 'malformed-header' });

    const vp8xWithReservedByte = webpVp8x(1, 1);
    vp8xWithReservedByte[21] = 1;
    expect(validateRasterHeader(vp8xWithReservedByte, '.webp')).toEqual({ ok: false, error: 'malformed-header' });
  });

  const zeroDimensionCases: readonly [string, Uint8Array, string][] = [
    ['PNG', png(0, 1), '.png'],
    ['JPEG', jpeg(0, 1), '.jpg'],
    ['GIF', gif(0, 1), '.gif'],
    ['WebP VP8', webpVp8(0, 1), '.webp'],
  ];
  it.each(zeroDimensionCases)('rejects zero dimensions in %s headers', (_name, bytes, extension) => {
    expect(validateRasterHeader(bytes, extension)).toEqual({ ok: false, error: 'malformed-header' });
  });

  it('rejects malformed magic containers and extension mismatches', () => {
    expect(validateRasterHeader(Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]), '.png')).toEqual({
      ok: false,
      error: 'malformed-header',
    });
    expect(validateRasterHeader(Uint8Array.from([1, 2, 3]), '.png')).toEqual({
      ok: false,
      error: 'unsupported-magic',
    });
    expect(validateRasterHeader(png(1, 1), '.gif')).toEqual({ ok: false, error: 'extension-mismatch' });
  });

  it('enforces exact base64 limits without decoding', () => {
    const encodedCapLiteral = 2_097_152;
    const largestSourceBytes = 1_572_864;
    expect(ASSET_BASE64_ENCODED_MAX_BYTES).toBe(encodedCapLiteral);
    expect(ASSET_SOURCE_READ_MAX_BYTES).toBe(largestSourceBytes);

    const exact = new Uint8Array(largestSourceBytes);
    exact.set(png(1, 1));
    expect(base64EncodedLength(exact.length)).toBe(encodedCapLiteral);
    expect(validateRasterHeader(exact, '.png')).toMatchObject({ ok: true });

    const over = new Uint8Array(largestSourceBytes + 1);
    over.set(png(1, 1));
    expect(base64EncodedLength(over.length)).toBe(encodedCapLiteral + 4);
    expect(validateRasterHeader(over, '.png')).toEqual({ ok: false, error: 'encoded-too-large' });
  });
});
