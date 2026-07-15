import { parentPort } from 'node:worker_threads';
import { parse, type DefaultTreeAdapterTypes } from 'parse5';
import {
  CappedTreeAdapter,
  countReachableHtmlExportDocument,
  HtmlExportParseLimitError,
  type HtmlExportParseCounts,
} from './html-export-capped-tree-adapter';

type HtmlExportParseWorkerRequest = { html: string };
type HtmlExportParseWorkerSuccess = {
  ok: true;
  document: DefaultTreeAdapterTypes.Document;
  counts: HtmlExportParseCounts;
};
type HtmlExportParseWorkerFailure = {
  ok: false;
  error: 'pipeline-oversize' | 'pipeline-reject';
  detail: string;
};
export type HtmlExportParseWorkerResponse = HtmlExportParseWorkerSuccess | HtmlExportParseWorkerFailure;

function parseHtml(html: string): HtmlExportParseWorkerResponse {
  try {
    const treeAdapter = new CappedTreeAdapter();
    const document = parse(html, { treeAdapter });
    return { ok: true, document, counts: countReachableHtmlExportDocument(document) };
  } catch (error) {
    if (error instanceof HtmlExportParseLimitError) {
      return { ok: false, error: error.code, detail: error.message };
    }
    return {
      ok: false,
      error: 'pipeline-reject',
      detail: error instanceof Error ? error.message : 'HTML parser failed',
    };
  }
}

const port = parentPort;
if (!port) {
  throw new Error('html-export-parse-worker requires a parent port');
}

port.once('message', (message: unknown) => {
  const response: HtmlExportParseWorkerResponse = isRequest(message)
    ? parseHtml(message.html)
    : { ok: false, error: 'pipeline-reject', detail: 'Invalid parse worker request' };
  try {
    port.postMessage(response);
  } finally {
    port.close();
  }
});

function isRequest(value: unknown): value is HtmlExportParseWorkerRequest {
  return typeof value === 'object' && value !== null && 'html' in value && typeof value.html === 'string';
}
