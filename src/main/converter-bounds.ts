/**
 * converter-bounds.ts — kordoc/OCR input pre-bounds + wall-clock timeout
 * (⑦ converter-safety, RALPLAN Phase 0 safety net).
 *
 * Pure, dependency-free guards the main process applies BEFORE handing an
 * attached/opened document to the (expensive, native-import) kordoc converter:
 *   - `checkBase64SizePrecap` rejects oversized payloads from their encoded
 *     length alone, so we never base64-decode a multi-hundred-MB blob just to
 *     discover it is too big.
 *   - `checkConvertibleExt` is the extension allowlist gate.
 *   - `checkMagicBytes` is a cheap content sniff that rejects obvious
 *     ext/content mismatches where the format has a stable signature.
 *   - `withWallClockTimeout` bounds any async conversion so a hung/looping
 *     converter cannot wedge the main process forever.
 *
 * Everything here is unit-tested in a pure Node env: no electron, no DOM, no
 * filesystem. The only Node global used is `setTimeout`/`clearTimeout`.
 */

/** Hard cap on a single document's decoded size (25 MiB) before conversion. */
export const MAX_CONVERT_BYTES = 25 * 1024 * 1024;

/**
 * Max base64-encoded length corresponding to {@link MAX_CONVERT_BYTES}.
 * Standard base64 packs 3 bytes into 4 chars, so the encoded form of N bytes is
 * `ceil(N / 3) * 4` chars. Useful as a first-line length guard before any
 * per-character work.
 */
export const MAX_CONVERT_BASE64_LEN = Math.ceil(MAX_CONVERT_BYTES / 3) * 4;

/**
 * Reject oversized base64 BEFORE decoding by estimating the decoded byte count
 * from the encoded length. Standard base64 maps 4 encoded chars → 3 decoded
 * bytes; trailing `=` padding chars carry no data, so we subtract one byte per
 * `=`. The estimate is exact for canonical (padded) base64 and at most ~2 bytes
 * high for unpadded input — i.e. conservative for a size cap, never under.
 *
 * Empty input is rejected: there is nothing to convert.
 */
export function checkBase64SizePrecap(
  base64: string,
  maxDecodedBytes: number,
): { ok: true } | { ok: false; error: string } {
  if (typeof base64 !== 'string' || base64.length === 0) {
    return { ok: false, error: 'empty base64 input' };
  }
  const len = base64.length;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const estimatedBytes = Math.floor((len * 3) / 4) - padding;
  if (estimatedBytes > maxDecodedBytes) {
    return {
      ok: false,
      error: `decoded size ~${estimatedBytes}B exceeds cap ${maxDecodedBytes}B`,
    };
  }
  return { ok: true };
}

/**
 * True when `ext` (lower- or mixed-case, no leading dot) is in the allowlist of
 * convertible document extensions. Case-insensitive.
 */
export function checkConvertibleExt(ext: string, allow: ReadonlySet<string>): boolean {
  return allow.has(ext.toLowerCase());
}

/** "%PDF" — every PDF file begins with this. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46] as const;
/** "PK\x03\x04" — ZIP local-file-header (OOXML docx/xlsx, OWPML hwpx). */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const;

/** True when `buf` begins with the exact byte signature `sig`. */
function startsWith(buf: Uint8Array, sig: readonly number[]): boolean {
  if (buf.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (buf[i] !== sig[i]) return false;
  }
  return true;
}

/**
 * Cheap content sniff to catch obvious extension/content mismatches before
 * conversion. Only validates formats with a stable, well-known signature:
 *   - PDF (`pdf`)               → must start with "%PDF".
 *   - ZIP containers            → docx/xlsx (OOXML) and hwpx (OWPML) must start
 *                                 with the ZIP local-file-header "PK\x03\x04".
 *
 * Other allowed types (hwp, hwpml, xls, …) are not hard-validated: we return
 * `ok: true` so an unrecognized-but-permitted type is never blocked just
 * because we cannot fingerprint it.
 * (GUESS: legacy hwp/xls are OLE2/CFBF "D0 CF 11 E0 A1 B1 1A E1"; intentionally
 * left unverified here to stay permissive for proprietary binaries.)
 */
export function checkMagicBytes(buf: Uint8Array, ext: string): { ok: boolean; detail?: string } {
  const e = ext.toLowerCase();
  if (e === 'pdf') {
    return startsWith(buf, PDF_MAGIC) ? { ok: true } : { ok: false, detail: 'expected %PDF header' };
  }
  if (e === 'docx' || e === 'xlsx' || e === 'hwpx') {
    return startsWith(buf, ZIP_MAGIC)
      ? { ok: true }
      : { ok: false, detail: 'expected ZIP (PK\\x03\\x04) header' };
  }
  // Unknown / unverifiable-but-allowed type → pass.
  return { ok: true };
}

/**
 * Run `fn` with a hard wall-clock deadline. On timeout the shared
 * `AbortController` is aborted (so a cooperative `fn` can cancel its work) and
 * the returned promise rejects with `Error('converter-timeout')`. If `fn`
 * ignores the signal, the racing timer still guarantees rejection. When `fn`
 * settles first the timer is cleared so no stray timer leaks.
 *
 * Ordering note: the timeout promise is rejected BEFORE `controller.abort()` so
 * that, even if `fn` rejects synchronously on abort, `Promise.race` is already
 * locked to the deterministic `converter-timeout` error rather than `fn`'s
 * abort-time rejection.
 */
export async function withWallClockTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('converter-timeout'));
      controller.abort();
    }, ms);
  });
  try {
    return await Promise.race([fn(controller.signal), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
