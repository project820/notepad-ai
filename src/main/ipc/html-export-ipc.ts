import { dialog, shell, type BrowserWindow, type WebContents } from 'electron';
import { existsSync, promises as fs } from 'node:fs';
import https from 'node:https';
import { handleTrusted } from '../ipc-guard';
import type { HtmlExportPipelineService } from '../html-export-pipeline-service';
import {
  createHtmlExportPipelineError,
  isOpaqueHtmlExportId,
  type BeginAttemptRequest,
  type CancelAttemptRequest,
  type HtmlExportAttemptId,
  type HtmlExportPipelineError,
  type HtmlExportPipelineResult,
  type ResolveRequest,
  type ResolveResult,
  type SanitizeRequest,
  type SanitizeResult,
} from '../../shared/html-export-pipeline';
import {
  designListContentsUrl,
  isAllowedDesignFetchUrl,
  isAllowedDesignListFetchUrl,
  isOpenableSavedPath,
  normalizeDesignMdUrl,
  parseDesignListFromContents,
} from '../safe-external';

type HtmlExportAssetLifecycle = {
  getActiveAttempt(webContentsId: number): HtmlExportAttemptId | undefined | Promise<HtmlExportAttemptId | undefined>;
  invalidateAttempt(owner: { webContentsId: number; attemptId: HtmlExportAttemptId }): void | Promise<void>;
  releaseWebContents(webContentsId: number): void | Promise<void>;
};

type HtmlExportIpcDeps = {
  windowForWebContents: (webContentsId: number) => BrowserWindow | null;
  pipelineService: Pick<
    HtmlExportPipelineService,
    'beginAttempt' | 'sanitize' | 'resolve' | 'invalidateAttempt' | 'invalidateSender'
  >;
  assetLifecycle: HtmlExportAssetLifecycle;
};


/** GET a small text resource with a hard timeout and body cap (never throws past the promise). */
function fetchTextLimited(url: string, opts: { timeoutMs: number; maxBytes: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'Notepad-AI', Accept: 'text/plain, text/markdown, */*' } },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`Design fetch failed (HTTP ${status}).`));
          return;
        }
        let bytes = 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > opts.maxBytes) {
            req.destroy(new Error('Design file is too large.'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        res.on('error', reject);
      },
    );
    req.setTimeout(opts.timeoutMs, () => req.destroy(new Error('Design fetch timed out.')));
    req.on('error', reject);
  });
}

/** In-memory cache of the design index (slugs) for the session. */
let designListCache: { slug: string; name: string; pageUrl: string }[] | null = null;

/** Force a safe `.html` basename for the save dialog default. */
function htmlSaveFileName(name: unknown): string {
  const fallback = 'notepad-ai-export.html';
  if (typeof name !== 'string') return fallback;
  const base = name.trim().replace(/[/\\]/g, '').slice(0, 120);
  if (!base) return fallback;
  return /\.html?$/i.test(base) ? base : `${base}.html`;
}
function pipelineReject(): { ok: false; error: HtmlExportPipelineError } {
  return { ok: false, error: createHtmlExportPipelineError('pipeline-reject') };
}

function canonicalPipelineError(kind: unknown): HtmlExportPipelineError {
  switch (kind) {
    case 'unknown-artifact':
    case 'stale-artifact':
    case 'wrong-sender':
    case 'attempt-superseded':
    case 'pipeline-oversize':
    case 'pipeline-reject':
      return createHtmlExportPipelineError(kind);
    default:
      return createHtmlExportPipelineError('pipeline-reject');
  }
}

function normalizePipelineResult<T>(result: HtmlExportPipelineResult<T>): HtmlExportPipelineResult<T> {
  if (result.ok) return result;
  return { ok: false, error: canonicalPipelineError(result.error.kind) };
}

async function containsPipelineException<T>(
  operation: () => HtmlExportPipelineResult<T> | Promise<HtmlExportPipelineResult<T>>,
  afterSuccess?: () => void | Promise<void>,
): Promise<HtmlExportPipelineResult<T>> {
  try {
    const result = await operation();
    if (!result.ok) return normalizePipelineResult(result);
    await afterSuccess?.();
    return result;
  } catch {
    return pipelineReject();
  }
}

function isExactPlainObject(input: unknown): input is Record<string, unknown> {
  return !!input
    && typeof input === 'object'
    && !Array.isArray(input)
    && (Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null);
}

function hasExactStringFields(input: unknown, fields: readonly string[]): input is Record<string, string> {
  if (!isExactPlainObject(input) || Object.getOwnPropertySymbols(input).length !== 0) return false;
  const keys = Object.keys(input);
  return keys.length === fields.length
    && keys.every((key) => fields.includes(key))
    && fields.every((field) => Object.hasOwn(input, field) && typeof input[field] === 'string');
}

function isBeginAttemptRequest(input: unknown): input is BeginAttemptRequest {
  return isExactPlainObject(input)
    && Object.keys(input).length === 0
    && Object.getOwnPropertySymbols(input).length === 0;
}

function isSanitizeRequest(input: unknown): input is SanitizeRequest {
  return hasExactStringFields(input, ['attemptId', 'rawArtifactId'])
    && isOpaqueHtmlExportId(input.attemptId)
    && isOpaqueHtmlExportId(input.rawArtifactId);
}

function isResolveRequest(input: unknown): input is ResolveRequest {
  return hasExactStringFields(input, ['attemptId', 'sanitizedCandidateId'])
    && isOpaqueHtmlExportId(input.attemptId)
    && isOpaqueHtmlExportId(input.sanitizedCandidateId);
}

function isCancelAttemptRequest(input: unknown): input is CancelAttemptRequest {
  return hasExactStringFields(input, ['attemptId']) && isOpaqueHtmlExportId(input.attemptId);
}

export function registerHtmlExportIpc({
  windowForWebContents,
  pipelineService,
  assetLifecycle,
}: HtmlExportIpcDeps): void {

  type SenderBinding = {
    readonly sender: WebContents;
    readonly webContentsId: number;
    readonly generation: number;
  };
  const senderBindings = new Map<number, SenderBinding>();
  const pendingSenderCleanup = new Map<number, Promise<boolean>>();
  let nextSenderGeneration = 0;

  const clearSenderState = (webContentsId: number): Promise<boolean> => {
    let pipelineCleanup: void | Promise<void> = undefined;
    let assetCleanup: void | Promise<void> = undefined;
    let invoked = true;
    try {
      pipelineCleanup = pipelineService.invalidateSender(webContentsId);
    } catch {
      invoked = false;
    }
    try {
      assetCleanup = assetLifecycle.releaseWebContents(webContentsId);
    } catch {
      invoked = false;
    }
    return Promise.allSettled([pipelineCleanup, assetCleanup]).then(
      (results) => invoked && results.every((result) => result.status === 'fulfilled'),
    );
  };
  const startSenderCleanup = (webContentsId: number): Promise<boolean> => {
    const pending = pendingSenderCleanup.get(webContentsId);
    if (pending) return pending;
    let cleanup!: Promise<boolean>;
    cleanup = clearSenderState(webContentsId).then(
      (succeeded) => {
        if (succeeded && pendingSenderCleanup.get(webContentsId) === cleanup) {
          pendingSenderCleanup.delete(webContentsId);
        }
        return succeeded;
      },
      () => false,
    );
    pendingSenderCleanup.set(webContentsId, cleanup);
    return cleanup;
  };

  const isCurrentSender = (binding: SenderBinding): boolean => {
    const current = senderBindings.get(binding.webContentsId);
    return current?.sender === binding.sender && current.generation === binding.generation;
  };

  const bindSenderInvalidation = async (sender: WebContents): Promise<SenderBinding | null> => {
    const webContentsId = sender.id;
    const pendingCleanup = pendingSenderCleanup.get(webContentsId);
    if (pendingCleanup && !(await pendingCleanup)) return null;
    const current = senderBindings.get(webContentsId);
    if (current?.sender === sender) return current;
    if (current) {
      senderBindings.delete(webContentsId);
      if (!(await startSenderCleanup(webContentsId))) return null;
    }

    const binding: SenderBinding = {
      sender,
      webContentsId,
      generation: ++nextSenderGeneration,
    };
    senderBindings.set(webContentsId, binding);
    try {
      sender.once('destroyed', () => {
        if (!isCurrentSender(binding)) return;
        senderBindings.delete(webContentsId);
        void startSenderCleanup(webContentsId);
      });
      return binding;
    } catch {
      if (isCurrentSender(binding)) senderBindings.delete(webContentsId);
      return null;
    }
  };

  const invalidateAttemptBestEffort = async (webContentsId: number, attemptId: HtmlExportAttemptId): Promise<void> => {
    await Promise.allSettled([
      Promise.resolve().then(() => pipelineService.invalidateAttempt(webContentsId, attemptId)),
      Promise.resolve().then(() => assetLifecycle.invalidateAttempt({ webContentsId, attemptId })),
    ]);
  };


  handleTrusted('design:fetch', async (_e, input: unknown) => {
    const rawUrl = normalizeDesignMdUrl(input);
    if (!rawUrl || !isAllowedDesignFetchUrl(rawUrl)) {
      return {
        ok: false as const,
        error: 'That design source is not supported. Paste a getdesign.md name or its DESIGN.md link.',
      };
    }
    try {
      const designMd = await fetchTextLimited(rawUrl, { timeoutMs: 8000, maxBytes: 200 * 1024 });
      return { ok: true as const, designMd, rawUrl };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : 'Could not fetch the design.' };
    }
  });

  handleTrusted('design:list', async () => {
    if (designListCache) return { ok: true as const, designs: designListCache };
    const url = designListContentsUrl();
    if (!isAllowedDesignListFetchUrl(url)) {
      return { ok: false as const, error: 'Design index source is not allowed.' };
    }
    try {
      const text = await fetchTextLimited(url, { timeoutMs: 8000, maxBytes: 512 * 1024 });
      const designs = parseDesignListFromContents(JSON.parse(text));
      if (designs.length > 0) designListCache = designs;
      return { ok: true as const, designs };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : 'Could not load the design list.' };
    }
  });
  handleTrusted('html:attempt:generate', async (event, input: unknown) => {
    const binding = await bindSenderInvalidation(event.sender);
    if (!binding) return pipelineReject();
    if (!isBeginAttemptRequest(input)) return pipelineReject();
    let priorAttemptId: HtmlExportAttemptId | undefined;
    return await containsPipelineException(
      async () => {
        priorAttemptId = await assetLifecycle.getActiveAttempt(binding.webContentsId);
        if (!isCurrentSender(binding)) return pipelineReject();
        const result = await pipelineService.beginAttempt(binding.webContentsId);
        if (isCurrentSender(binding)) return result;
        if (result.ok) await invalidateAttemptBestEffort(binding.webContentsId, result.value.attemptId);
        return pipelineReject();
      },
      async () => {
        if (priorAttemptId && isCurrentSender(binding)) {
          await assetLifecycle.invalidateAttempt({
            webContentsId: binding.webContentsId,
            attemptId: priorAttemptId,
          });
        }
      },
    );
  });

  handleTrusted('html:pipeline:sanitize', async (event, input: unknown): Promise<SanitizeResult> => {
    const binding = await bindSenderInvalidation(event.sender);
    if (!binding) return pipelineReject();
    if (!isSanitizeRequest(input)) return pipelineReject();
    return await containsPipelineException(async () => {
      const result = await pipelineService.sanitize(
        binding.webContentsId,
        input.attemptId,
        input.rawArtifactId,
      );
      if (isCurrentSender(binding)) return result;
      await invalidateAttemptBestEffort(binding.webContentsId, input.attemptId);
      return pipelineReject();
    });
  });

  handleTrusted('html:pipeline:resolve', async (event, input: unknown): Promise<ResolveResult> => {
    const binding = await bindSenderInvalidation(event.sender);
    if (!binding) return pipelineReject();
    if (!isResolveRequest(input)) return pipelineReject();
    return await containsPipelineException(async () => {
      const result = await pipelineService.resolve(
        binding.webContentsId,
        input.attemptId,
        input.sanitizedCandidateId,
      );
      if (isCurrentSender(binding)) return result;
      await invalidateAttemptBestEffort(binding.webContentsId, input.attemptId);
      return pipelineReject();
    });
  });

  handleTrusted('html:attempt:cancel', async (event, input: unknown) => {
    const binding = await bindSenderInvalidation(event.sender);
    if (!binding) return pipelineReject();
    if (!isCancelAttemptRequest(input)) return pipelineReject();
    return containsPipelineException(
      async () => {
        const result = await pipelineService.invalidateAttempt(binding.webContentsId, input.attemptId);
        return isCurrentSender(binding) ? result : pipelineReject();
      },
      async () => {
        if (isCurrentSender(binding)) {
          await assetLifecycle.invalidateAttempt({
            webContentsId: binding.webContentsId,
            attemptId: input.attemptId,
          });
        }
      },
    );
  });

  handleTrusted('html:save', async (event, args: { html?: string; defaultName?: string }) => {
    const win = windowForWebContents(event.sender.id);
    if (!win || typeof args?.html !== 'string') return { saved: false as const };
    const result = await dialog.showSaveDialog(win, {
      filters: [{ name: 'HTML', extensions: ['html'] }],
      defaultPath: htmlSaveFileName(args.defaultName),
    });
    if (result.canceled || !result.filePath) return { saved: false as const };
    let target = result.filePath;
    if (!/\.html?$/i.test(target)) target += '.html';
    try {
      await fs.writeFile(target, args.html, 'utf-8');
    } catch (e) {
      return { saved: false as const, error: e instanceof Error ? e.message : 'write-failed' };
    }
    return { saved: true as const, filePath: target };
  });

  handleTrusted('html:open-saved', async (_e, filePath: unknown) => {
    if (!isOpenableSavedPath(filePath)) return { opened: false as const, error: 'Not an openable HTML file.' };
    const target = (filePath as string).trim();
    if (!existsSync(target)) return { opened: false as const, error: 'The saved file no longer exists.' };
    const result = await shell.openPath(target);
    if (result) return { opened: false as const, error: result };
    return { opened: true as const };
  });
}
