/**
 * converter-worker.ts — Electron utilityProcess child that runs kordoc OUT of the
 * main process (Phase 3 isolation). It receives `{ id, ext, data }`, converts the
 * document with kordoc, and posts back `{ id, ok, markdown?, html?, error? }`.
 *
 * A crash/hang here cannot take down the main process: the ConverterHost kills a
 * wedged worker on its wall-clock deadline and respawns on the next request.
 *
 * This file is an entry point (not unit-tested directly — the host logic is).
 */

import type { ConverterRequest, ConverterResponse } from './converter-host';
type KordocModule = typeof import('kordoc') & { default?: typeof import('kordoc') };

// In a utilityProcess child, the parent channel is on `process.parentPort`.
const parentPort = (process as unknown as { parentPort?: { on(ev: 'message', cb: (e: { data: ConverterRequest }) => void): void; postMessage(msg: ConverterResponse): void } }).parentPort;

function reply(msg: ConverterResponse): void {
  parentPort?.postMessage(msg);
}

if (parentPort) {
  parentPort.on('message', async (e) => {
    const { id, ext, data } = e.data;
    try {
      const buf = Buffer.from(data);
      // kordoc ships an ESM-only entry; use a native dynamic import (hidden from
      // the TS CommonJS transform via new Function) — mirrors the main path.
      const nativeImport: (s: string) => Promise<unknown> = new Function('s', 'return import(s)') as (s: string) => Promise<unknown>;
      const kordoc = (await nativeImport('kordoc')) as KordocModule;
      const parseFn = kordoc.parse ?? kordoc.default?.parse;
      const renderHtml = kordoc.renderHtml ?? kordoc.default?.renderHtml;
      if (typeof parseFn !== 'function') {
        reply({ id, ok: false, error: 'Document converter unavailable.' });
        return;
      }
      const r = await parseFn(buf, { removeHeaderFooter: true });
      if (r?.success && typeof r.markdown === 'string') {
        let html: string | undefined;
        if (typeof renderHtml === 'function') {
          try {
            html = renderHtml(r.markdown, { preset: 'gov-formal' });
          } catch {
            /* fall back to raw markdown */
          }
        }
        reply({ id, ok: true, markdown: r.markdown, html });
      } else {
        const msg = ('error' in (r ?? {}) && (r as any).error?.message) || 'unknown error';
        reply({ id, ok: false, error: `Could not convert ${ext.toUpperCase()}: ${msg}` });
      }
    } catch (err: any) {
      reply({ id, ok: false, error: `Failed to convert ${ext.toUpperCase()}: ${err?.message ?? err}` });
    }
  });
}
