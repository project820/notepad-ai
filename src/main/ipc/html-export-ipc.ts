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
  type QuarantineMeasureRequest,
  type QuarantineMeasureResult,
  type ResolvedArtifactId,
  type SaveFinalizedRequest,
  type SaveFinalizedResult,
  createHtmlExportQuarantineError,
} from '../../shared/html-export-pipeline';
import { atomicWrite, nodeAtomicBackend, type AtomicWriteBackend } from '../atomic-write';
import type { GenerationAttemptResult } from '../html-export-generation-orchestrator';
import { isAiProviderId, type AiProviderId } from '../ai/types';
import { isHtmlExportModelProviderAllowed } from '../ai/html-export-model-allowlist';
import { VIEWPORT_MAX, VIEWPORT_MIN } from '../html-export-quarantine';
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

/**
 * Additive pre-finalization quarantine gate (PR-S3b / §5.12). Optional so the
 * heavily-tested pipeline IPC keeps working without a live Electron host; when
 * absent, measurement fails closed with a renderer-safe `quarantine-unavailable`.
 */
type HtmlExportQuarantineLifecycle = {
  measure(
    webContentsId: number,
    attemptId: HtmlExportAttemptId,
    resolvedArtifactId: ResolvedArtifactId,
    viewport?: { width: number; height: number },
  ): Promise<QuarantineMeasureResult>;
  cancelWebContents(webContentsId: number): void;
  cancelAttempt(webContentsId: number, attemptId: HtmlExportAttemptId): void;
};

type HtmlExportIpcDeps = {
  windowForWebContents: (webContentsId: number) => BrowserWindow | null;
  pipelineService: Pick<
    HtmlExportPipelineService,
    'beginAttempt' | 'sanitize' | 'resolve' | 'finalize' | 'readFinalizedArtifact' | 'invalidateAttempt' | 'invalidateSender'
  >;
  assetLifecycle: HtmlExportAssetLifecycle;
  quarantine?: HtmlExportQuarantineLifecycle;
  /** Injectable atomic-write backend for the finalized save path (tests only). */
  saveBackend?: AtomicWriteBackend;
  /** Main-owned generation: streams the model, drives the pipeline, finalizes. */
  generateHtml?: (
    webContentsId: number,
    input: {
      prompt: string;
      model: { provider: AiProviderId; id: string };
      instructions?: string;
      viewport?: { width: number; height: number };
    },
  ) => Promise<GenerationAttemptResult>;
  cancelGenerateHtml?: (webContentsId: number) => void;
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

function isQuarantineMeasureRequest(input: unknown): input is QuarantineMeasureRequest {
  return hasExactStringFields(input, ['attemptId', 'resolvedArtifactId'])
    && isOpaqueHtmlExportId(input.attemptId)
    && isOpaqueHtmlExportId(input.resolvedArtifactId);
}

function isSaveFinalizedRequest(input: unknown): input is SaveFinalizedRequest {
  if (!isExactPlainObject(input) || Object.getOwnPropertySymbols(input).length !== 0) return false;
  const keys = Object.keys(input);
  if (!keys.every((key) => key === 'attemptId' || key === 'finalizedArtifactId' || key === 'defaultName')) {
    return false;
  }
  // Required IDs must be own enumerable string keys (never prototype-inherited).
  if (!Object.hasOwn(input, 'attemptId') || !Object.hasOwn(input, 'finalizedArtifactId')) return false;
  if (!isOpaqueHtmlExportId(input.attemptId) || !isOpaqueHtmlExportId(input.finalizedArtifactId)) return false;
  if ('defaultName' in input && input.defaultName !== undefined && typeof input.defaultName !== 'string') {
    return false;
  }
  return true;
}

const HTML_GENERATE_PROMPT_MAX = 4 * 1024 * 1024;

const HTML_GENERATE_VIEWPORT_MIN = VIEWPORT_MIN;
const HTML_GENERATE_VIEWPORT_MAX = VIEWPORT_MAX;

function isValidGenerateViewport(input: unknown): input is { width: number; height: number } {
  if (!isExactPlainObject(input) || Object.getOwnPropertySymbols(input).length !== 0) return false;
  const keys = Object.keys(input);
  if (keys.length !== 2 || !keys.every((key) => key === 'width' || key === 'height')) return false;
  const width = input.width;
  const height = input.height;
  return Object.hasOwn(input, 'width')
    && Object.hasOwn(input, 'height')
    && typeof width === 'number'
    && Number.isInteger(width)
    && width >= HTML_GENERATE_VIEWPORT_MIN
    && width <= HTML_GENERATE_VIEWPORT_MAX
    && typeof height === 'number'
    && Number.isInteger(height)
    && height >= HTML_GENERATE_VIEWPORT_MIN
    && height <= HTML_GENERATE_VIEWPORT_MAX;
}
function isGenerateRequest(
  input: unknown,
): input is {
  prompt: string;
  model: { provider: AiProviderId; id: string };
  instructions?: string;
  viewport?: { width: number; height: number };
  reasoningEffort?: 'low';
} {
  if (!isExactPlainObject(input) || Object.getOwnPropertySymbols(input).length !== 0) return false;
  const keys = Object.keys(input);
  if (!keys.every((key) => key === 'prompt' || key === 'model' || key === 'instructions' || key === 'viewport' || key === 'reasoningEffort')) {
    return false;
  }
  if (!Object.hasOwn(input, 'prompt') || typeof input.prompt !== 'string') return false;
  if (input.prompt.length === 0 || input.prompt.length > HTML_GENERATE_PROMPT_MAX) return false;
  if (!Object.hasOwn(input, 'model') || !isExactPlainObject(input.model)) return false;
  const model = input.model as Record<string, unknown>;
  // Fail-closed HTML-export provider allowlist (§5.3 / AC-M1c-d): the HTML surface
  // pins ONE no-fallback transport, so OpenRouter (opaque multi-vendor routing) and
  // any non-allowlisted provider are rejected here even if the renderer offers them.
  if (!isAiProviderId(model.provider) || !isHtmlExportModelProviderAllowed(model.provider)) return false;
  if (typeof model.id !== 'string' || model.id.length === 0 || model.id.length > 256) return false;
  if ('instructions' in input && input.instructions !== undefined) {
    if (typeof input.instructions !== 'string' || input.instructions.length > 65_536) return false;
  }
  if ('viewport' in input && input.viewport !== undefined && !isValidGenerateViewport(input.viewport)) return false;
  if ('reasoningEffort' in input && input.reasoningEffort !== undefined) {
    if (input.reasoningEffort !== 'low' || model.provider !== 'chatgpt' || !/^gpt-5\.6-(sol|terra|luna)$/.test(model.id)) {
      return false;
    }
  }
  return true;
}

function quarantineReject(kind: Parameters<typeof createHtmlExportQuarantineError>[0]): QuarantineMeasureResult {
  return { ok: false, error: createHtmlExportQuarantineError(kind) };
}

export function registerHtmlExportIpc({
  windowForWebContents,
  pipelineService,
  assetLifecycle,
  quarantine,
  saveBackend,
  generateHtml,
  cancelGenerateHtml,
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
    try {
      quarantine?.cancelWebContents(webContentsId);
    } catch {
      // Quarantine teardown is best effort and must not block sender cleanup.
    }
    try {
      // Abort any in-flight main-owned generation for this sender: on a window
      // close/crash the destroyed hook runs cleanup, and the provider/CLI stream
      // must not keep running after its WebContents is gone.
      cancelGenerateHtml?.(webContentsId);
    } catch {
      // Best effort — must not block sender cleanup.
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

  // PR-R1 cutover: main-owned one-call generation. The renderer submits only the
  // prompt + model (+ optional viewport for quarantine overflow gate); main streams
  // the model, drives the pipeline, and finalizes.
  handleTrusted('html:generate', async (event, input: unknown): Promise<GenerationAttemptResult> => {
    const binding = await bindSenderInvalidation(event.sender);
    if (!binding || !generateHtml) return { state: 'failed', stage: 'begin', kind: 'pipeline-reject' };
    if (!isGenerateRequest(input)) return { state: 'failed', stage: 'begin', kind: 'pipeline-reject' };
    try {
      return await generateHtml(binding.webContentsId, {
        prompt: input.prompt,
        model: input.model,
        ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
        ...(input.viewport !== undefined ? { viewport: input.viewport } : {}),
        ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
      });
    } catch {
      return { state: 'failed', stage: 'generate', kind: 'pipeline-reject' };
    }
  });

  handleTrusted('html:generate:cancel', async (event) => {
    // Abort any in-flight generation and drop the sender's active/finalized
    // attempt so abandoned wizard IDs cannot still save. Routes through
    // startSenderCleanup (which fences admission via pendingSenderCleanup and
    // runs clearSenderState: cancelGenerateHtml + invalidateSender + asset
    // release + quarantine cancel). Finalize leaves the attempt in
    // activeAttempts, so invalidateSender is enough for revocation.
    try {
      return { ok: await startSenderCleanup(event.sender.id) };
    } catch {
      return { ok: false };
    }
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
    // Cancel any in-flight quarantine measure for this attempt unconditionally:
    // a renderer-initiated cancel must tear down sandboxed work even when the
    // pipeline attempt invalidation itself reports a stale/unknown attempt.
    if (isCurrentSender(binding)) {
      try {
        quarantine?.cancelAttempt(binding.webContentsId, input.attemptId);
      } catch {
        // Quarantine cancellation is best effort.
      }
    }
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

  handleTrusted('html:quarantine:measure', async (event, input: unknown): Promise<QuarantineMeasureResult> => {
    const binding = await bindSenderInvalidation(event.sender);
    if (!binding) return quarantineReject('recoverable-failure');
    if (!isQuarantineMeasureRequest(input)) return quarantineReject('recoverable-failure');
    if (!quarantine) return quarantineReject('quarantine-unavailable');
    try {
      const result = await quarantine.measure(
        binding.webContentsId,
        input.attemptId,
        input.resolvedArtifactId,
      );
      if (!isCurrentSender(binding)) {
        try {
          quarantine.cancelWebContents(binding.webContentsId);
        } catch {
          // Best effort teardown for a superseded sender.
        }
        return quarantineReject('attempt-superseded');
      }
      if (!result.ok) return result;

      // PASS: finalize the exact resolved bytes into a FinalizedArtifactId.
      const finalized = await pipelineService.finalize(
        binding.webContentsId,
        input.attemptId,
        input.resolvedArtifactId,
      );
      if (!isCurrentSender(binding)) {
        try {
          quarantine.cancelWebContents(binding.webContentsId);
        } catch {
          // Best effort teardown for a superseded sender.
        }
        return quarantineReject('attempt-superseded');
      }
      if (!finalized.ok) {
        try {
          quarantine.cancelAttempt(binding.webContentsId, input.attemptId);
        } catch {
          // Best effort: cancel the measure if finalize fails.
        }
        return quarantineReject('recoverable-failure');
      }
      return {
        ok: true,
        value: {
          ...result.value,
          finalizedArtifactId: finalized.value.artifact.id,
        },
      };
    } catch {
      return quarantineReject('recoverable-failure');
    }
  });

  // AC-M1d: save the main-held FinalizedArtifactId bytes to a single HTML file
  // via an atomic write. The renderer submits only opaque IDs — never bytes — and
  // no partial file is ever left on failure; the returned sha256 lets a caller
  // assert preview == save-finalized digest.
  handleTrusted('html:save-finalized', async (event, input: unknown): Promise<SaveFinalizedResult> => {
    const binding = await bindSenderInvalidation(event.sender);
    if (!binding) return { saved: false as const };
    if (!isSaveFinalizedRequest(input)) return { saved: false as const };
    const win = windowForWebContents(binding.webContentsId);
    if (!win) return { saved: false as const };

    // Fail-fast UX read: if the artifact cannot be resolved, do not even open a
    // dialog. The authoritative bytes are re-read AFTER the dialog below.
    const preflight = pipelineService.readFinalizedArtifact(
      binding.webContentsId,
      input.attemptId,
      input.finalizedArtifactId,
    );
    if (!preflight.ok || !isCurrentSender(binding)) return { saved: false as const };

    const result = await dialog.showSaveDialog(win, {
      filters: [{ name: 'HTML', extensions: ['html'] }],
      defaultPath: htmlSaveFileName(input.defaultName),
    });
    if (result.canceled || !result.filePath) return { saved: false as const };
    if (!isCurrentSender(binding)) return { saved: false as const };

    // Re-read after the async dialog: the attempt may have been superseded,
    // cancelled, or the sender destroyed while the dialog was open. Only the
    // re-read main-held bytes are durable — never a pre-dialog snapshot.
    const finalized = pipelineService.readFinalizedArtifact(
      binding.webContentsId,
      input.attemptId,
      input.finalizedArtifactId,
    );
    if (!finalized.ok) return { saved: false as const };

    let target = result.filePath;
    if (!/\.html?$/i.test(target)) target += '.html';
    try {
      // Exported HTML is user-shareable: use 0o644, not atomicWrite's 0o600
      // secret-store default. No partial file is left on failure.
      await atomicWrite(target, finalized.value.bytes, {
        backend: saveBackend ?? nodeAtomicBackend(),
        mode: 0o644,
      });
    } catch {
      // Never forward the raw error: its message can carry absolute filesystem
      // paths. The atomic write leaves no partial file on failure.
      return { saved: false as const, error: 'write-failed' };
    }
    return { saved: true as const, filePath: target, sha256: finalized.value.sha256 };
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
