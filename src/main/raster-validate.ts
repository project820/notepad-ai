import {
  ASSET_BASE64_ENCODED_MAX_BYTES,
  RASTER_MAX_HEIGHT,
  RASTER_MAX_PIXELS,
  RASTER_MAX_WIDTH,
  type RasterMime,
} from '../shared/html-export-assets';

interface ValidatedRasterHeader {
  readonly mime: RasterMime;
  readonly width: number;
  readonly height: number;
  readonly sourceBytes: number;
  readonly base64EncodedBytes: number;
}

export type RasterValidationError =
  | 'encoded-too-large'
  | 'unsupported-magic'
  | 'extension-mismatch'
  | 'malformed-header'
  | 'dimension-limit'
  | 'pixel-limit';

export type RasterValidationResult =
  | { readonly ok: true; readonly value: ValidatedRasterHeader }
  | { readonly ok: false; readonly error: RasterValidationError };

interface RasterDimensions {
  readonly mime: RasterMime;
  readonly width: number;
  readonly height: number;
}
interface WebpImage extends RasterDimensions {
  readonly hasAlpha: boolean;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG_SIGNATURE = [0xff, 0xd8] as const;
const WEBP_RIFF = [0x52, 0x49, 0x46, 0x46] as const;
const WEBP_MAGIC = [0x57, 0x45, 0x42, 0x50] as const;

function hasBytes(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  return offset >= 0
    && offset + expected.length <= bytes.length
    && expected.every((byte, index) => bytes[offset + index] === byte);
}

function readU16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readU16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]);
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]
    + (bytes[offset + 1] << 8)
    + (bytes[offset + 2] << 16)
    + (bytes[offset + 3] * 0x1000000);
}

function validPngIhdr(bytes: Uint8Array): boolean {
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  const validBitDepth = (colorType === 0 && [1, 2, 4, 8, 16].includes(bitDepth))
    || ((colorType === 2 || colorType === 4 || colorType === 6) && (bitDepth === 8 || bitDepth === 16))
    || (colorType === 3 && [1, 2, 4, 8].includes(bitDepth));
  return validBitDepth && bytes[26] === 0 && bytes[27] === 0 && (bytes[28] === 0 || bytes[28] === 1);
}

function parsePng(bytes: Uint8Array): RasterDimensions | null {
  if (!hasBytes(bytes, 0, PNG_SIGNATURE)) return null;
  if (bytes.length < 33
    || readU32BE(bytes, 8) !== 13
    || !hasBytes(bytes, 12, [0x49, 0x48, 0x44, 0x52])
    || !validPngIhdr(bytes)) return null;
  return {
    mime: 'image/png',
    width: readU32BE(bytes, 16),
    height: readU32BE(bytes, 20),
  };
}

function isSofMarker(marker: number): boolean {
  return (marker >= 0xc0 && marker <= 0xc3)
    || (marker >= 0xc5 && marker <= 0xc7)
    || (marker >= 0xc9 && marker <= 0xcb)
    || (marker >= 0xcd && marker <= 0xcf);
}

function parseJpeg(bytes: Uint8Array): RasterDimensions | null {
  if (!hasBytes(bytes, 0, JPEG_SIGNATURE)) return null;

  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;

    const marker = bytes[offset];
    offset += 1;
    if (marker === 0x00) return null;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return null;

    const segmentLength = readU16BE(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if (isSofMarker(marker)) {
      if (segmentLength < 8) return null;
      const componentCount = bytes[offset + 7];
      const expectedSegmentLength = 8 + (3 * componentCount);
      if (componentCount === 0 || segmentLength !== expectedSegmentLength) return null;
      return {
        mime: 'image/jpeg',
        width: readU16BE(bytes, offset + 5),
        height: readU16BE(bytes, offset + 3),
      };
    }
    offset += segmentLength;
  }
  return null;
}

function parseVp8Dimensions(bytes: Uint8Array, payload: number, chunkLength: number): WebpImage | null {
  if (chunkLength < 10
    || (bytes[payload] & 0x11) !== 0x10
    || !hasBytes(bytes, payload + 3, [0x9d, 0x01, 0x2a])) return null;
  return {
    mime: 'image/webp',
    width: readU16LE(bytes, payload + 6) & 0x3fff,
    height: readU16LE(bytes, payload + 8) & 0x3fff,
    hasAlpha: false,
  };
}

function parseVp8lDimensions(bytes: Uint8Array, payload: number, chunkLength: number): WebpImage | null {
  if (chunkLength < 5 || bytes[payload] !== 0x2f) return null;
  const packed = readU32LE(bytes, payload + 1);
  if ((packed >>> 29) !== 0) return null;
  return {
    mime: 'image/webp',
    width: 1 + (packed & 0x3fff),
    height: 1 + ((packed >>> 14) & 0x3fff),
    hasAlpha: (packed & 0x10000000) !== 0,
  };
}

function sameDimensions(left: RasterDimensions, right: RasterDimensions): boolean {
  return left.width === right.width && left.height === right.height;
}
function validWebpAlphaChunk(bytes: Uint8Array, payload: number, chunkLength: number): boolean {
  if (chunkLength < 2) return false;
  const header = bytes[payload];
  const compressionMethod = header & 0x03;
  const preprocessingMethod = (header >>> 4) & 0x03;
  return compressionMethod === 0
    && preprocessingMethod <= 1
    && (header & 0xc0) === 0;
}

function parseAnimatedWebpFrame(
  bytes: Uint8Array,
  payload: number,
  chunkLength: number,
  canvas: RasterDimensions,
  alphaDeclared: boolean,
): RasterValidationError | boolean {
  if (chunkLength < 17 || (bytes[payload + 15] & 0xfc) !== 0) return 'malformed-header';

  const frame: RasterDimensions = {
    mime: 'image/webp',
    width: 1 + readU24LE(bytes, payload + 6),
    height: 1 + readU24LE(bytes, payload + 9),
  };
  const frameError = validateDimensions(frame);
  if (frameError) return frameError;

  const frameX = readU24LE(bytes, payload) * 2;
  const frameY = readU24LE(bytes, payload + 3) * 2;
  if (frameX + frame.width > canvas.width || frameY + frame.height > canvas.height) {
    return 'malformed-header';
  }

  let offset = payload + 16;
  const end = payload + chunkLength;
  let image: WebpImage | null = null;
  let sawAlpha = false;
  while (offset < end) {
    if (offset + 8 > end) return 'malformed-header';

    const chunk = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    const childLength = readU32LE(bytes, offset + 4);
    const childPayload = offset + 8;
    const paddedLength = childLength + (childLength % 2);
    if (childPayload + paddedLength > end) return 'malformed-header';

    if (chunk === 'ALPH') {
      if (!alphaDeclared || sawAlpha || image || !validWebpAlphaChunk(bytes, childPayload, childLength)) {
        return 'malformed-header';
      }
      sawAlpha = true;
    } else if (chunk === 'VP8 ' || chunk === 'VP8L') {
      if (image || (sawAlpha && chunk === 'VP8L')) return 'malformed-header';
      image = chunk === 'VP8 '
        ? parseVp8Dimensions(bytes, childPayload, childLength)
        : parseVp8lDimensions(bytes, childPayload, childLength);
      if (!image) return 'malformed-header';
      const imageError = validateDimensions(image);
      if (imageError) return imageError;
      if (!sameDimensions(frame, image)) return 'malformed-header';
    } else {
      return 'malformed-header';
    }

    offset = childPayload + paddedLength;
  }
  return offset === end && image ? sawAlpha || image.hasAlpha : 'malformed-header';
}

function parseWebp(bytes: Uint8Array): RasterDimensions | RasterValidationError | null {
  if (!hasBytes(bytes, 0, WEBP_RIFF) || !hasBytes(bytes, 8, WEBP_MAGIC) || bytes.length < 20) {
    return 'malformed-header';
  }

  const riffSize = readU32LE(bytes, 4);
  const end = riffSize + 8;
  if (riffSize < 12 || end !== bytes.length) return 'malformed-header';

  let offset = 12;
  let state: 'start' | 'extended-static' | 'animation-header' | 'animation-frames' | 'static-complete' = 'start';
  let canvas: RasterDimensions | null = null;
  let image: WebpImage | null = null;
  let sawAlpha = false;
  let alphaDeclared = false;
  let frameCount = 0;
  let sawFrameAlpha = false;

  while (offset < end) {
    if (offset + 8 > end) return 'malformed-header';

    const chunk = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    const chunkLength = readU32LE(bytes, offset + 4);
    const payload = offset + 8;
    const paddedLength = chunkLength + (chunkLength % 2);
    if (payload + paddedLength > end) return 'malformed-header';

    if (chunk === 'VP8 ' || chunk === 'VP8L') {
      if (state !== 'start' && state !== 'extended-static') return 'malformed-header';
      if (sawAlpha && chunk === 'VP8L') return 'malformed-header';
      image = chunk === 'VP8 '
        ? parseVp8Dimensions(bytes, payload, chunkLength)
        : parseVp8lDimensions(bytes, payload, chunkLength);
      if (!image) return 'malformed-header';
      const imageError = validateDimensions(image);
      if (imageError) return imageError;
      if (state === 'extended-static' && (!canvas || !sameDimensions(canvas, image))) {
        return 'malformed-header';
      }
      state = 'static-complete';
    } else if (chunk === 'VP8X') {
      if (
        state !== 'start'
        || chunkLength !== 10
        || (bytes[payload] & ~0x12) !== 0
        || bytes[payload + 1] !== 0
        || bytes[payload + 2] !== 0
        || bytes[payload + 3] !== 0
      ) {
        return 'malformed-header';
      }
      canvas = {
        mime: 'image/webp',
        width: 1 + readU24LE(bytes, payload + 4),
        height: 1 + readU24LE(bytes, payload + 7),
      };
      const canvasError = validateDimensions(canvas);
      if (canvasError) return canvasError;
      alphaDeclared = (bytes[payload] & 0x10) !== 0;
      state = (bytes[payload] & 0x02) !== 0 ? 'animation-header' : 'extended-static';
    } else if (chunk === 'ALPH') {
      if (state !== 'extended-static' || !alphaDeclared || sawAlpha || !validWebpAlphaChunk(bytes, payload, chunkLength)) {
        return 'malformed-header';
      }
      sawAlpha = true;
    } else if (chunk === 'ANIM') {
      if (state !== 'animation-header' || chunkLength !== 6) return 'malformed-header';
      state = 'animation-frames';
    } else if (chunk === 'ANMF') {
      if (state !== 'animation-frames' || !canvas) return 'malformed-header';
      const frameAlpha = parseAnimatedWebpFrame(bytes, payload, chunkLength, canvas, alphaDeclared);
      if (typeof frameAlpha === 'string') return frameAlpha;
      sawFrameAlpha ||= frameAlpha;
      frameCount += 1;
    } else {
      return 'malformed-header';
    }

    offset = payload + paddedLength;
  }

  if (offset !== end) return 'malformed-header';
  if (state === 'static-complete' && image) {
    if (canvas && alphaDeclared !== (sawAlpha || image.hasAlpha)) return 'malformed-header';
    return image;
  }
  if (state === 'animation-frames' && canvas && frameCount > 0 && alphaDeclared === sawFrameAlpha) return canvas;
  return 'malformed-header';
}

function parseGif(bytes: Uint8Array): RasterDimensions | null {
  if ((!hasBytes(bytes, 0, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61])
      && !hasBytes(bytes, 0, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))
    || bytes.length < 13) return null;
  return {
    mime: 'image/gif',
    width: readU16LE(bytes, 6),
    height: readU16LE(bytes, 8),
  };
}

function detectedHeader(bytes: Uint8Array): RasterDimensions | RasterValidationError | null {
  if (hasBytes(bytes, 0, PNG_SIGNATURE)) return parsePng(bytes);
  if (hasBytes(bytes, 0, JPEG_SIGNATURE)) return parseJpeg(bytes);
  if (hasBytes(bytes, 0, WEBP_RIFF) && hasBytes(bytes, 8, WEBP_MAGIC)) return parseWebp(bytes);
  if (hasBytes(bytes, 0, [0x47, 0x49, 0x46])) return parseGif(bytes);
  return null;
}

function extensionMatches(mime: RasterMime, selectedExtension: string): boolean {
  const extension = selectedExtension.toLowerCase();
  switch (mime) {
    case 'image/png': return extension === '.png';
    case 'image/jpeg': return extension === '.jpg' || extension === '.jpeg';
    case 'image/webp': return extension === '.webp';
    case 'image/gif': return extension === '.gif';
  }
}

function validateDimensions(header: RasterDimensions): RasterValidationError | null {
  if (header.width === 0 || header.height === 0) return 'malformed-header';
  if (header.width > RASTER_MAX_WIDTH || header.height > RASTER_MAX_HEIGHT) return 'dimension-limit';

  const pixels = BigInt(header.width) * BigInt(header.height);
  if (pixels > BigInt(RASTER_MAX_PIXELS)) return 'pixel-limit';
  return null;
}

/** Exact 4 * ceil(sourceBytes / 3) base64 payload length. */
export function base64EncodedLength(sourceBytes: number): number {
  if (!Number.isSafeInteger(sourceBytes) || sourceBytes < 0) {
    throw new RangeError('sourceBytes must be a non-negative safe integer');
  }
  return 4 * Math.ceil(sourceBytes / 3);
}

/**
 * Validates only a raster container header. It performs no filesystem access,
 * decoding, resizing, or re-encoding.
 */
export function validateRasterHeader(
  bytes: Uint8Array,
  selectedExtension: string,
): RasterValidationResult {
  const encodedBytes = base64EncodedLength(bytes.byteLength);
  if (encodedBytes > ASSET_BASE64_ENCODED_MAX_BYTES) {
    return { ok: false, error: 'encoded-too-large' };
  }

  const header = detectedHeader(bytes);
  if (!header) {
    return {
      ok: false,
      error: hasBytes(bytes, 0, PNG_SIGNATURE)
        || hasBytes(bytes, 0, JPEG_SIGNATURE)
        || (hasBytes(bytes, 0, WEBP_RIFF) && hasBytes(bytes, 8, WEBP_MAGIC))
        || hasBytes(bytes, 0, [0x47, 0x49, 0x46])
        ? 'malformed-header'
        : 'unsupported-magic',
    };
  }
  if (typeof header === 'string') return { ok: false, error: header };
  if (!extensionMatches(header.mime, selectedExtension)) {
    return { ok: false, error: 'extension-mismatch' };
  }

  const dimensionError = validateDimensions(header);
  if (dimensionError) return { ok: false, error: dimensionError };
  return {
    ok: true,
    value: {
      mime: header.mime,
      width: header.width,
      height: header.height,
      sourceBytes: bytes.byteLength,
      base64EncodedBytes: encodedBytes,
    },
  };
}
