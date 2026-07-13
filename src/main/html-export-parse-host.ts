import path from 'node:path';
import { Worker, type WorkerOptions } from 'node:worker_threads';
import type { DefaultTreeAdapterTypes } from 'parse5';
import {
  createHtmlExportPipelineError,
  type HtmlExportPipelineResult,
} from '../shared/html-export-pipeline';
import {
  HTML_EXPORT_PARSE_LIMITS,
  type HtmlExportParseCounts,
} from './html-export-capped-tree-adapter';
import type {
  HtmlExportParseWorkerResponse,
} from './html-export-parse-worker';

export type HtmlExportParseValue = {
  document: DefaultTreeAdapterTypes.Document;
  counts: HtmlExportParseCounts;
};

export interface HtmlExportParseWorker {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: unknown) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (exitCode: number) => void): this;
  off(event: 'message' | 'error' | 'exit', listener: (...args: never[]) => void): this;
  terminate(): Promise<number> | void;
}

export type HtmlExportParseWorkerSpawn = () => HtmlExportParseWorker;
type HtmlExportParseWorkerFactory = (
  filename: string,
  options: WorkerOptions,
) => HtmlExportParseWorker;
type ScheduleTimeout = (callback: () => void, timeoutMs: number) => ReturnType<typeof setTimeout>;
type CancelTimeout = (timeout: ReturnType<typeof setTimeout>) => void;

export type HtmlExportParseHostOptions = {
  spawn?: HtmlExportParseWorkerSpawn;
  workerFactory?: HtmlExportParseWorkerFactory;
  timeoutMs?: number;
  setTimeout?: ScheduleTimeout;
  clearTimeout?: CancelTimeout;
};

const DEFAULT_TIMEOUT_MS = 2_000;

/** Runs parse5 outside the Electron main process; no in-process parser fallback exists. */
export class HtmlExportParseHost {
  private readonly spawn: HtmlExportParseWorkerSpawn;
  private readonly timeoutMs: number;
  private readonly scheduleTimeout: ScheduleTimeout;
  private readonly cancelTimeout: CancelTimeout;

  constructor(options: HtmlExportParseHostOptions = {}) {
    const workerFactory: HtmlExportParseWorkerFactory = options.workerFactory ?? ((filename, workerOptions) =>
      new Worker(filename, workerOptions) as unknown as HtmlExportParseWorker);
    this.spawn = options.spawn ?? (() => workerFactory(path.join(__dirname, 'html-export-parse-worker.js'), {
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    }));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.scheduleTimeout = options.setTimeout ?? setTimeout;
    this.cancelTimeout = options.clearTimeout ?? clearTimeout;
  }

  parse(html: string): Promise<HtmlExportPipelineResult<HtmlExportParseValue>> {
    return new Promise((resolve) => {
      let worker: HtmlExportParseWorker;
      try {
        worker = this.spawn();
      } catch (error) {
        resolve(reject(error));
        return;
      }

      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: HtmlExportPipelineResult<HtmlExportParseValue>) => {
        if (settled) return;
        settled = true;
        try {
          if (timer !== undefined) this.cancelTimeout(timer);
        } catch {
          // Cleanup must still terminate a worker when a test transport misbehaves.
        }
        try {
          worker.off('message', onMessage as never);
          worker.off('error', onError as never);
          worker.off('exit', onExit as never);
        } catch {
          // Termination below remains the final containment boundary.
        }
        try {
          void Promise.resolve(worker.terminate()).then(
            () => resolve(result),
            (error: unknown) => resolve(reject(error)),
          );
        } catch (error) {
          resolve(reject(error));
        }
      };
      const onMessage = (message: unknown) => {
        if (!isWorkerResponse(message)) {
          finish(reject(new Error('Invalid parse worker response')));
          return;
        }
        if (!message.ok) {
          finish({ ok: false, error: createHtmlExportPipelineError(message.error, message.detail) });
          return;
        }
        finish({ ok: true, value: { document: message.document, counts: message.counts } });
      };
      const onError = (error: Error) => finish(reject(error));
      const onExit = (exitCode: number) => finish(reject(new Error(`Parse worker exited (${exitCode})`)));

      worker.on('message', onMessage);
      worker.on('error', onError);
      worker.on('exit', onExit);
      try {
        timer = this.scheduleTimeout(
          () => finish(reject(new Error(`Parse worker timed out after ${this.timeoutMs}ms`))),
          this.timeoutMs,
        );
      } catch (error) {
        finish(reject(error));
        return;
      }
      if (settled) {
        try {
          this.cancelTimeout(timer);
        } catch {
          // The parse result is already settled.
        }
        return;
      }
      try {
        worker.postMessage({ html });
      } catch (error) {
        finish(reject(error));
      }
    });
  }
}

function reject(error: unknown): HtmlExportPipelineResult<never> {
  const detail = error instanceof Error ? error.message : 'HTML parser worker failed';
  return { ok: false, error: createHtmlExportPipelineError('pipeline-reject', detail) };
}

function isWorkerResponse(value: unknown): value is HtmlExportParseWorkerResponse {
  if (typeof value !== 'object' || value === null || !('ok' in value)) return false;
  if (value.ok === false) {
    return (
      'error' in value
      && (value.error === 'pipeline-oversize' || value.error === 'pipeline-reject')
      && 'detail' in value
      && typeof value.detail === 'string'
    );
  }
  if (value.ok !== true || !('document' in value) || !('counts' in value)) return false;
  const { document, counts } = value;
  return isCounts(counts) && isBoundedDocument(document, counts);
}

function isCounts(value: unknown): value is HtmlExportParseCounts {
  if (typeof value !== 'object' || value === null) return false;
  const { nodeCount, maxDepth, attributeCount } = value as Partial<HtmlExportParseCounts>;
  return (
    typeof nodeCount === 'number'
    && Number.isInteger(nodeCount)
    && nodeCount >= 1
    && nodeCount <= HTML_EXPORT_PARSE_LIMITS.maxNodes
    && typeof maxDepth === 'number'
    && Number.isInteger(maxDepth)
    && maxDepth >= 0
    && maxDepth <= HTML_EXPORT_PARSE_LIMITS.maxDepth
    && typeof attributeCount === 'number'
    && Number.isInteger(attributeCount)
    && attributeCount >= 0
    && attributeCount <= HTML_EXPORT_PARSE_LIMITS.maxAttributes
  );
}
function isBoundedDocument(document: unknown, expected: HtmlExportParseCounts): document is DefaultTreeAdapterTypes.Document {
  if (
    typeof document !== 'object'
    || document === null
    || !('nodeName' in document)
    || document.nodeName !== '#document'
    || !('childNodes' in document)
    || !Array.isArray(document.childNodes)
  ) {
    return false;
  }

  let nodeCount = 0;
  let attributeCount = 0;
  let maxDepth = 0;
  const seen = new Set<object>();
  const pending: Array<{ node: unknown; depth: number }> = [{ node: document, depth: 0 }];

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (typeof current.node !== 'object' || current.node === null || seen.has(current.node)) return false;
    seen.add(current.node);
    if (!('nodeName' in current.node) || typeof current.node.nodeName !== 'string') return false;

    nodeCount++;
    maxDepth = Math.max(maxDepth, current.depth);
    if (nodeCount > HTML_EXPORT_PARSE_LIMITS.maxNodes || current.depth > HTML_EXPORT_PARSE_LIMITS.maxDepth) return false;

    if ('attrs' in current.node) {
      if (!Array.isArray(current.node.attrs) || current.node.attrs.length > HTML_EXPORT_PARSE_LIMITS.maxAttributesPerElement) {
        return false;
      }
      attributeCount += current.node.attrs.length;
      if (attributeCount > HTML_EXPORT_PARSE_LIMITS.maxAttributes) return false;
    }

    if ('childNodes' in current.node) {
      if (!Array.isArray(current.node.childNodes)) return false;
      for (const child of current.node.childNodes) pending.push({ node: child, depth: current.depth + 1 });
    }
    if (current.node.nodeName === 'template') {
      if (!('content' in current.node)) return false;
      pending.push({ node: current.node.content, depth: current.depth + 1 });
    }
  }

  return (
    nodeCount === expected.nodeCount
    && maxDepth === expected.maxDepth
    && attributeCount === expected.attributeCount
  );
}
