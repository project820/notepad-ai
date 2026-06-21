/**
 * ocr.ts — offline OCR via tesseract.js with EXPLICIT local asset paths
 * (G007 decision A2). tesseract.js defaults to fetching its worker, wasm core,
 * and language data from a CDN (unpkg); in a packaged Electron app that breaks
 * offline and violates the self-contained principle. We therefore resolve every
 * asset to a bundled local path and HARD-FAIL if any path looks like a URL.
 *
 * `resolveOcrAssetPaths` is pure + unit-tested. `runOcr` lazy-imports
 * tesseract.js so this module (and its callers) load even if OCR is unused.
 */

import { join } from 'node:path';

import type { AiImageAttachment } from './types';

export type OcrAssetPaths = { workerPath: string; corePath: string; langPath: string };

/** OCR languages: Korean + English (matches the product's primary audience). */
export const OCR_LANGS = 'kor+eng';

function assertLocal(label: string, p: string): string {
  if (!p || /^(?:https?:)?\/\//i.test(p) || /unpkg|jsdelivr|cdn/i.test(p)) {
    throw new Error(`OCR ${label} path must be a bundled local path, got: ${p || '(empty)'}`);
  }
  return p;
}

/**
 * Resolve bundled OCR asset paths. Packaged builds read from `extraResources`
 * (`process.resourcesPath/tesseract/...`); dev reads from `node_modules` +
 * `resources/tessdata`. Throws if any resolved path is a URL (no CDN fallback).
 */
export function resolveOcrAssetPaths(opts: {
  appPath: string;
  resourcesPath: string;
  packaged: boolean;
}): OcrAssetPaths {
  const base = opts.packaged ? join(opts.resourcesPath, 'tesseract') : '';
  const paths: OcrAssetPaths = opts.packaged
    ? {
        workerPath: join(base, 'worker.min.js'),
        corePath: join(base, 'core'),
        langPath: join(base, 'lang-data'),
      }
    : {
        workerPath: join(opts.appPath, 'node_modules', 'tesseract.js', 'dist', 'worker.min.js'),
        corePath: join(opts.appPath, 'node_modules', 'tesseract.js-core'),
        langPath: join(opts.appPath, 'resources', 'tessdata'),
      };
  return {
    workerPath: assertLocal('worker', paths.workerPath),
    corePath: assertLocal('core', paths.corePath),
    langPath: assertLocal('lang', paths.langPath),
  };
}

/** Lazy OCR runner type so callers/tests can inject a stub. */
export type OcrRunner = (images: AiImageAttachment[], signal?: AbortSignal) => Promise<string>;

let assetPathsForRun: OcrAssetPaths | null = null;
/** Wire the resolved asset paths once at startup (from the Electron main entry). */
export function configureOcr(paths: OcrAssetPaths): void {
  assetPathsForRun = paths;
}

/**
 * Recognize text from images (kor+eng) using the bundled tesseract worker.
 * Concurrency-1, lazy-loaded. Returns the concatenated recognized text.
 */
export const runOcr: OcrRunner = async (images, signal) => {
  if (!images.length) return '';
  if (!assetPathsForRun) throw new Error('OCR is not configured (assets not resolved).');
  // Lazy import so the bundle never eagerly loads tesseract.
  const tesseract = (await import('tesseract.js')) as typeof import('tesseract.js');
  const worker = await tesseract.createWorker(OCR_LANGS, undefined, {
    workerPath: assetPathsForRun.workerPath,
    corePath: assetPathsForRun.corePath,
    langPath: assetPathsForRun.langPath,
  });
  try {
    const parts: string[] = [];
    for (const img of images) {
      if (signal?.aborted) break;
      const dataUri = `data:${img.mime};base64,${img.base64}`;
      const { data } = await worker.recognize(dataUri);
      if (data.text.trim()) parts.push(data.text.trim());
    }
    return parts.join('\n\n');
  } finally {
    await worker.terminate();
  }
};
