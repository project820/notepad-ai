import type { ConverterHost } from './converter-host';

export type DocumentConversion = {
  ok: boolean;
  markdown?: string;
  html?: string;
  error?: string;
};

/**
 * Convert only through the isolated worker. Parsing attacker-controlled documents
 * in the main process would defeat the worker isolation boundary.
 */
export async function convertDocument(
  converterHost: Pick<ConverterHost, 'runConvert'>,
  ext: string,
  buf: Buffer,
): Promise<DocumentConversion> {
  try {
    const result = await converterHost.runConvert(ext, buf);
    return result.ok
      ? { ok: true, markdown: result.markdown, html: result.html }
      : { ok: false, error: result.error };
  } catch {
    return { ok: false, error: 'converter-worker-failed' };
  }
}
