import { describe, expect, it, vi } from 'vitest';

import {
  MAX_CONVERT_BYTES,
  MAX_CONVERT_BASE64_LEN,
  checkBase64SizePrecap,
  checkConvertibleExt,
  checkMagicBytes,
  withWallClockTimeout,
} from '../main/converter-bounds';

/** Base64 for `n` filler bytes — canonical (padded) encoding. */
const b64OfBytes = (n: number): string => Buffer.alloc(n, 0x41).toString('base64');

describe('size constants', () => {
  it('MAX_CONVERT_BYTES is 25 MiB and the base64 cap matches ceil(N/3)*4', () => {
    expect(MAX_CONVERT_BYTES).toBe(25 * 1024 * 1024);
    expect(MAX_CONVERT_BASE64_LEN).toBe(Math.ceil(MAX_CONVERT_BYTES / 3) * 4);
  });
});

describe('checkBase64SizePrecap', () => {
  it('rejects an empty string', () => {
    expect(checkBase64SizePrecap('', 100)).toEqual({ ok: false, error: 'empty base64 input' });
  });

  it('passes a payload comfortably under the cap', () => {
    // "QUFB" decodes to 3 bytes ("AAA"); well under 1000.
    const res = checkBase64SizePrecap('QUFB', 1000);
    expect(res.ok).toBe(true);
  });

  it('accepts exactly at the cap (boundary, padding-corrected)', () => {
    // 100 bytes → base64 length 136 with "==" padding → estimate exactly 100.
    const res = checkBase64SizePrecap(b64OfBytes(100), 100);
    expect(res.ok).toBe(true);
  });

  it('rejects when the estimated decoded size exceeds the cap', () => {
    const res = checkBase64SizePrecap(b64OfBytes(100), 99);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/exceeds cap 99B/);
  });
});

describe('checkConvertibleExt', () => {
  const allow = new Set(['hwp', 'hwpx', 'docx', 'pdf', 'xlsx']);

  it('accepts allowed extensions case-insensitively and rejects others', () => {
    expect(checkConvertibleExt('pdf', allow)).toBe(true);
    expect(checkConvertibleExt('DOCX', allow)).toBe(true);
    expect(checkConvertibleExt('exe', allow)).toBe(false);
    expect(checkConvertibleExt('', allow)).toBe(false);
  });
});

describe('checkMagicBytes', () => {
  const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // "%PDF-1.7"
  const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]); // "PK\x03\x04…"

  it('accepts a real PDF header and rejects a non-PDF body for .pdf', () => {
    expect(checkMagicBytes(pdfBytes, 'pdf')).toEqual({ ok: true });
    const bad = checkMagicBytes(zipBytes, 'pdf'); // ZIP magic in a .pdf
    expect(bad.ok).toBe(false);
    expect(bad.detail).toMatch(/%PDF/);
  });

  it('accepts a ZIP header for docx/xlsx/hwpx and rejects a bad body', () => {
    expect(checkMagicBytes(zipBytes, 'docx')).toEqual({ ok: true });
    expect(checkMagicBytes(zipBytes, 'XLSX')).toEqual({ ok: true }); // case-insensitive
    expect(checkMagicBytes(zipBytes, 'hwpx')).toEqual({ ok: true });
    const bad = checkMagicBytes(pdfBytes, 'docx'); // %PDF in a .docx
    expect(bad.ok).toBe(false);
    expect(bad.detail).toMatch(/ZIP/);
  });

  it('rejects when the buffer is too short for the signature', () => {
    expect(checkMagicBytes(new Uint8Array([0x25, 0x50]), 'pdf').ok).toBe(false);
  });

  it('passes unverifiable-but-allowed types (hwp/hwpml/xls)', () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(checkMagicBytes(ole, 'hwp')).toEqual({ ok: true });
    expect(checkMagicBytes(ole, 'xls')).toEqual({ ok: true });
    expect(checkMagicBytes(new Uint8Array([0x00]), 'hwpml')).toEqual({ ok: true });
  });
});

describe('withWallClockTimeout', () => {
  it('returns the result when fn settles before the deadline', async () => {
    const out = await withWallClockTimeout(async () => 'fast', 1000);
    expect(out).toBe('fast');
  });

  it('rejects with converter-timeout when fn ignores the abort signal', async () => {
    const slow = () =>
      new Promise<string>((resolve) => {
        // Ignores the signal entirely; unref so the stray timer cannot keep the
        // event loop (or test runner) alive after the assertion.
        const t = setTimeout(() => resolve('late'), 200);
        (t as { unref?: () => void }).unref?.();
      });
    await expect(withWallClockTimeout(slow, 10)).rejects.toThrow('converter-timeout');
  });

  it('aborts the signal on timeout (cooperative fn) yet still rejects converter-timeout', async () => {
    let aborted = false;
    const fn = (signal: AbortSignal) =>
      new Promise<string>((resolve, reject) => {
        const t = setTimeout(() => resolve('late'), 200);
        signal.addEventListener('abort', () => {
          clearTimeout(t);
          aborted = true;
          reject(new Error('aborted-by-signal'));
        });
      });
    await expect(withWallClockTimeout(fn, 10)).rejects.toThrow('converter-timeout');
    expect(aborted).toBe(true);
  });

  it('clears the timeout timer when fn wins (no timer leak)', async () => {
    const setSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    try {
      const out = await withWallClockTimeout(async () => 'done', 5000);
      expect(out).toBe('done');
      const handle = setSpy.mock.results[0]?.value;
      expect(handle).toBeDefined();
      expect(clearSpy).toHaveBeenCalledWith(handle);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });
});
