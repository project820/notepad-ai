import path from 'node:path';
import { handleTrusted } from './ipc-guard';
import { MAX_CONVERT_BYTES, checkBase64SizePrecap, checkMagicBytes } from './converter-bounds';
import { ConverterHost, type WorkerTransport } from './converter-host';
import { convertDocument as convertIsolatedDocument } from './converter-service';
import { CONVERTIBLE_EXTS as CONVERTIBLE_EXT_LIST } from '../shared/file-types';

const CONVERT_TIMEOUT_MS = 30_000;
const CONVERTIBLE_EXTS = new Set<string>(CONVERTIBLE_EXT_LIST);

export type ConvertDocument = (ext: string, buf: Buffer) => Promise<{ ok: boolean; markdown?: string; html?: string; error?: string }>;

export function createConverterHost(): ConverterHost {
  return new ConverterHost((): WorkerTransport => {
    const { utilityProcess } = require('electron') as typeof import('electron');
    const child = utilityProcess.fork(path.join(__dirname, 'converter-worker.js'));
    return { post: (msg) => child.postMessage(msg), onMessage: (cb) => child.on('message', (m) => cb(m)), onExit: (cb) => child.on('exit', () => cb()), kill: () => child.kill() };
  }, { timeoutMs: CONVERT_TIMEOUT_MS });
}

export function convertDocument(host: ConverterHost, ext: string, buf: Buffer) {
  return convertIsolatedDocument(host, ext as 'hwp' | 'hwpx' | 'hwpml' | 'docx' | 'pdf' | 'xlsx' | 'xls', buf);
}

export function registerConvertIpc({ converterHost }: { converterHost: ConverterHost }): void {
  handleTrusted('ai:convert-attachment', async (_e, payload: unknown) => {
    const p = (payload ?? {}) as { base64?: unknown; ext?: unknown };
    const ext = typeof p.ext === 'string' ? p.ext.toLowerCase() : '';
    const base64 = typeof p.base64 === 'string' ? p.base64 : '';
    if (!CONVERTIBLE_EXTS.has(ext)) return { ok: false, error: `Unsupported attachment type: ${ext || 'unknown'}` };
    const precap = checkBase64SizePrecap(base64, MAX_CONVERT_BYTES);
    if (!precap.ok) return { ok: false, error: precap.error };
    let buf: Buffer;
    try { buf = Buffer.from(base64, 'base64'); } catch { return { ok: false, error: 'Could not read the attached file.' }; }
    if (buf.length === 0) return { ok: false, error: 'The attached file is empty.' };
    if (buf.length > MAX_CONVERT_BYTES) return { ok: false, error: 'Attached file is too large (max 25 MB).' };
    const magic = checkMagicBytes(buf, ext);
    if (!magic.ok) return { ok: false, error: `Attachment content does not match .${ext}` };
    const conv = await convertDocument(converterHost, ext, buf);
    return conv.ok && typeof conv.markdown === 'string' ? { ok: true, markdown: conv.markdown } : { ok: false, error: conv.error ?? `Could not convert ${ext.toUpperCase()}.` };
  });
}
