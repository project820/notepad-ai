/**
 * Main-owned bounded quarantine pool core (PR-S3b / §5.12).
 *
 * Electron-free and dependency-injected: the real sandboxed measurement host is
 * supplied by the parent. This module only owns admission, byte/decode checks,
 * deadline/cancel racing, outcome mapping, and deterministic slot teardown.
 *
 * Renderer-safe: only {@link QuarantineMeasureResult} leaves this boundary.
 */

import {
  createHtmlExportQuarantineError,
  HTML_EXPORT_STAGE_ARTIFACT_MAX_BYTES,
  type HtmlExportAttemptId,
  type HtmlExportQuarantineErrorKind,
  type HtmlExportQuarantineMeasurement,
  type QuarantineMeasureResult,
  type ResolvedArtifactId,
} from '../shared/html-export-pipeline';
export type QuarantineViewport = { width: number; height: number };

/** Fallback measurement viewport (landscape 720p). Hosts and callers share this. */
export const DEFAULT_VIEWPORT: QuarantineViewport = { width: 1280, height: 720 };

export const VIEWPORT_MIN = 320;
export const VIEWPORT_MAX = 4096;

/**
 * Validate/clamp a renderer- or caller-supplied viewport. Invalid/absent input
 * falls back to {@link DEFAULT_VIEWPORT}. Never pass unclamped values to Electron.
 */
export function normalizeQuarantineViewport(input: unknown): QuarantineViewport {
  if (!input || typeof input !== 'object') return { ...DEFAULT_VIEWPORT };
  const rec = input as Record<string, unknown>;
  const width = clampViewportDim(rec.width);
  const height = clampViewportDim(rec.height);
  if (width === undefined || height === undefined) return { ...DEFAULT_VIEWPORT };
  return { width, height };
}

function clampViewportDim(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const n = Math.trunc(value);
  if (n < VIEWPORT_MIN || n > VIEWPORT_MAX) return undefined;
  return n;
}


/** Host-side measurement outcome. Bytes and native detail stay inside the host. */
export type QuarantineHostOutcome =
  | { kind: 'measured'; measurement: HtmlExportQuarantineMeasurement }
  | { kind: 'oversize' }
  | { kind: 'layout-violation' }
  | { kind: 'crashed' }
  | { kind: 'unresponsive' }
  | { kind: 'recoverable-failure' };

/** One fixed pool slot's sandboxed session. Partition lifetime is owned by the host. */
export interface QuarantineSlotSession {
  measure(
    html: string,
    opts: { deadlineMs: number; signal: AbortSignal; viewport?: QuarantineViewport },
  ): Promise<QuarantineHostOutcome>;
  reset(): Promise<void>;
}

/** Fixed 2-slot host. Slot ids are always 0 and 1; never create per-attempt partitions here. */
export interface QuarantineHost {
  slot(slotId: 0 | 1): QuarantineSlotSession;
}

/**
 * Narrow structural registry read used by the pool. Matches
 * `HtmlExportAttemptRegistry.read(..., 'resolved')`.
 */
export type QuarantineRegistryReader = {
  read(
    webContentsId: number,
    attemptId: HtmlExportAttemptId,
    artifactId: ResolvedArtifactId,
    expectedStage: 'resolved',
  ):
    | {
        ok: true;
        value: {
          ref: { byteLength: number; sha256: string };
          bytes: Buffer;
        };
      }
    | { ok: false; error: { kind: string } };
};

/**
 * Byte cap for the resolved artifact measured by quarantine.
 * S4 will supersede with the final-artifact cap once finalized bytes exist.
 */
export const HTML_EXPORT_QUARANTINE_MAX_BYTES = HTML_EXPORT_STAGE_ARTIFACT_MAX_BYTES;

const DEFAULT_DEADLINE_MS = 8_000;
const SLOT_IDS = [0, 1] as const;
type SlotId = (typeof SLOT_IDS)[number];

const REGISTRY_MAPPED_KINDS = new Set<HtmlExportQuarantineErrorKind>([
  'unknown-artifact',
  'stale-artifact',
  'wrong-sender',
  'attempt-superseded',
  'pipeline-reject',
]);

type InFlightEntry = {
  webContentsId: number;
  attemptId: HtmlExportAttemptId;
  abortController: AbortController;
  slotId: SlotId;
};

export type HtmlExportQuarantinePoolOptions = {
  registry: QuarantineRegistryReader;
  host: QuarantineHost;
  /** Measurement deadline; defaults to 8000 ms. */
  deadlineMs?: number;
};

/**
 * Fixed 2-slot in-memory quarantine pool.
 *
 * - Per-webContents concurrency 1; global concurrency 2.
 * - Queue depth 0: inadmissible work returns `quarantine-busy` immediately.
 * - Teardown runs in `finally` on every terminal path after slot reservation.
 */
export class HtmlExportQuarantinePool {
  private readonly registry: QuarantineRegistryReader;
  private readonly host: QuarantineHost;
  private readonly deadlineMs: number;
  private readonly busySlots = new Set<SlotId>();
  private readonly inFlightByWebContents = new Map<number, InFlightEntry>();

  constructor(options: HtmlExportQuarantinePoolOptions) {
    this.registry = options.registry;
    this.host = options.host;
    this.deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  }

  async measure(
    webContentsId: number,
    attemptId: HtmlExportAttemptId,
    resolvedArtifactId: ResolvedArtifactId,
    viewport?: QuarantineViewport,
  ): Promise<QuarantineMeasureResult> {
    // (a)(b) Admission + reservation are fully synchronous so a re-entrant call is rejected.
    if (this.inFlightByWebContents.has(webContentsId)) {
      return fail('quarantine-busy');
    }
    const slotId = this.reserveFreeSlot();
    if (slotId === undefined) {
      return fail('quarantine-busy');
    }

    const abortController = new AbortController();
    const entry: InFlightEntry = { webContentsId, attemptId, abortController, slotId };
    this.inFlightByWebContents.set(webContentsId, entry);

    let result: QuarantineMeasureResult = fail('recoverable-failure');
    try {
      // (c) Registry read (bytes stay main-process-only).
      const read = this.registry.read(webContentsId, attemptId, resolvedArtifactId, 'resolved');
      if (!read.ok) {
        result = fail(mapRegistryErrorKind(read.error.kind));
        return result;
      }

      const { bytes } = read.value;

      // (d) Byte cap.
      if (bytes.byteLength > HTML_EXPORT_QUARANTINE_MAX_BYTES) {
        result = fail('quarantine-oversize');
        return result;
      }

      // (e) Strict UTF-8 decode.
      let html: string;
      try {
        html = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        result = fail('recoverable-failure');
        return result;
      }

      // (i) External cancel before host settles → cancelled (still teardowns in finally).
      if (abortController.signal.aborted) {
        result = fail('quarantine-cancelled');
        return result;
      }

      // (f) Host measure raced against deadline and external cancel.
      result = await this.runHostMeasure(slotId, html, abortController.signal, viewport);
      return result;
    } catch {
      // Unexpected throw outside the host race → recoverable, then teardown.
      result = fail('recoverable-failure');
      return result;
    } finally {
      // (h) Deterministic teardown on EVERY terminal path after reservation.
      await this.teardown(slotId, webContentsId);
    }
  }

  cancelWebContents(webContentsId: number): void {
    const entry = this.inFlightByWebContents.get(webContentsId);
    if (entry) entry.abortController.abort();
  }

  cancelAttempt(webContentsId: number, attemptId: HtmlExportAttemptId): void {
    const entry = this.inFlightByWebContents.get(webContentsId);
    if (entry && entry.attemptId === attemptId) {
      entry.abortController.abort();
    }
  }

  private reserveFreeSlot(): SlotId | undefined {
    for (const slotId of SLOT_IDS) {
      if (!this.busySlots.has(slotId)) {
        this.busySlots.add(slotId);
        return slotId;
      }
    }
    return undefined;
  }

  private async runHostMeasure(
    slotId: SlotId,
    html: string,
    signal: AbortSignal,
    viewport?: QuarantineViewport,
  ): Promise<QuarantineMeasureResult> {
    const session = this.host.slot(slotId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;

    try {
      const hostPromise = session.measure(html, {
        deadlineMs: this.deadlineMs,
        signal,
        ...(viewport ? { viewport } : {}),
      });

      const raced = await new Promise<
        | { source: 'host'; outcome: QuarantineHostOutcome }
        | { source: 'timeout' }
        | { source: 'cancelled' }
        | { source: 'throw' }
      >((resolve) => {
        let settled = false;
        const finish = (
          value:
            | { source: 'host'; outcome: QuarantineHostOutcome }
            | { source: 'timeout' }
            | { source: 'cancelled' }
            | { source: 'throw' },
        ) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };

        timer = setTimeout(() => finish({ source: 'timeout' }), this.deadlineMs);

        onAbort = () => finish({ source: 'cancelled' });
        if (signal.aborted) {
          finish({ source: 'cancelled' });
        } else {
          signal.addEventListener('abort', onAbort, { once: true });
        }

        void hostPromise.then(
          (outcome) => finish({ source: 'host', outcome }),
          () => finish({ source: 'throw' }),
        );
      });

      if (raced.source === 'timeout') return fail('quarantine-timeout');
      if (raced.source === 'cancelled') return fail('quarantine-cancelled');
      if (raced.source === 'throw') return fail('recoverable-failure');
      return mapHostOutcome(raced.outcome);
    } catch {
      // (f) Host promise rejects/throws → recoverable-failure.
      return fail('recoverable-failure');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  private async teardown(slotId: SlotId, webContentsId: number): Promise<void> {
    try {
      await this.host.slot(slotId).reset();
    } catch (error) {
      // A reset throw must never mask the measure verdict.
      console.error('[html-export-quarantine] slot reset failed', {
        slotId,
        webContentsId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.busySlots.delete(slotId);
      this.inFlightByWebContents.delete(webContentsId);
    }
  }
}

function fail(kind: HtmlExportQuarantineErrorKind): QuarantineMeasureResult {
  return { ok: false, error: createHtmlExportQuarantineError(kind) };
}

function mapRegistryErrorKind(kind: string): HtmlExportQuarantineErrorKind {
  if (REGISTRY_MAPPED_KINDS.has(kind as HtmlExportQuarantineErrorKind)) {
    return kind as HtmlExportQuarantineErrorKind;
  }
  return 'recoverable-failure';
}

function mapHostOutcome(outcome: QuarantineHostOutcome): QuarantineMeasureResult {
  switch (outcome.kind) {
    case 'measured':
      return {
        ok: true,
        value: { verdict: 'pass', measurement: outcome.measurement },
      };
    case 'oversize':
      return fail('quarantine-oversize');
    case 'layout-violation':
      return fail('layout-violation');
    case 'crashed':
      return fail('quarantine-crashed');
    case 'unresponsive':
      return fail('quarantine-unresponsive');
    case 'recoverable-failure':
      return fail('recoverable-failure');
    default: {
      const _exhaustive: never = outcome;
      return fail('recoverable-failure');
    }
  }
}
