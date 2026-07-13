import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { html, parse, type DefaultTreeAdapterTypes } from 'parse5';
import { describe, expect, it, vi } from 'vitest';
import {
  CappedTreeAdapter,
  countReachableHtmlExportDocument,
  HTML_EXPORT_PARSE_LIMITS,
} from '../main/html-export-capped-tree-adapter';
import {
  HtmlExportParseHost,
  type HtmlExportParseWorker,
} from '../main/html-export-parse-host';

type Listener = (...args: never[]) => void;

function parseCapped(source: string): { document: DefaultTreeAdapterTypes.Document; adapter: CappedTreeAdapter } {
  const adapter = new CappedTreeAdapter();
  return { document: parse(source, { treeAdapter: adapter }), adapter };
}

function attrs(count: number): Array<{ name: string; value: string }> {
  return Array.from({ length: count }, (_, index) => ({ name: `data-${index}`, value: String(index) }));
}

function fakeWorker(post: (emit: (message: unknown) => void, crash: (error: Error) => void) => void): HtmlExportParseWorker & { terminate: ReturnType<typeof vi.fn> } {
  const listeners = new Map<string, Listener>();
  const worker = {
    postMessage: () => post(
      (message) => (listeners.get('message') as ((value: unknown) => void) | undefined)?.(message),
      (error) => (listeners.get('error') as ((value: Error) => void) | undefined)?.(error),
    ),
    on(event: string, listener: Listener) {
      listeners.set(event, listener);
      return this;
    },
    off(event: string, listener: Listener) {
      if (listeners.get(event) === listener) listeners.delete(event);
      return this;
    },
    terminate: vi.fn(() => Promise.resolve(0)),
  };
  return worker as unknown as HtmlExportParseWorker & { terminate: ReturnType<typeof vi.fn> };
}

describe('CappedTreeAdapter', () => {
  it('freezes the approved literal construction limits', () => {
    expect(HTML_EXPORT_PARSE_LIMITS).toEqual({
      maxNodes: 20_000,
      maxDepth: 64,
      maxAttributesPerElement: 256,
      maxAttributes: 8_192,
    });
  });
  it.each([
    '<!doctype html><title>ok</title><p class=x>hello <b>world</b></p>',
    '<table><tr><td>one<td>two</tr></table><p>after',
    '<template><div data-x="1">template text</div></template>',
  ])('preserves parse5 default trees for accepted input: %s', (source) => {
    expect(parseCapped(source).document).toEqual(parse(source));
  });

  it('accepts the exact node cap and rejects cap plus one during construction', () => {
    const adapter = new CappedTreeAdapter();
    const document = adapter.createDocument();
    for (let index = 1; index < HTML_EXPORT_PARSE_LIMITS.maxNodes; index++) {
      adapter.appendChild(document, adapter.createCommentNode(String(index)));
    }
    expect(adapter.counts.nodeCount).toBe(HTML_EXPORT_PARSE_LIMITS.maxNodes);
    expect(() => adapter.createCommentNode('one too many')).toThrow('node count exceeds');
  });

  it('accepts the exact depth cap and rejects cap plus one during attachment', () => {
    const adapter = new CappedTreeAdapter();
    let parent: DefaultTreeAdapterTypes.ParentNode = adapter.createDocument();
    for (let depth = 1; depth <= HTML_EXPORT_PARSE_LIMITS.maxDepth; depth++) {
      const element = adapter.createElement('div', html.NS.HTML, []);
      adapter.appendChild(parent, element);
      parent = element;
    }
    expect(adapter.counts.maxDepth).toBe(HTML_EXPORT_PARSE_LIMITS.maxDepth);
    const tooDeep = adapter.createElement('div', html.NS.HTML, []);
    expect(() => adapter.appendChild(parent, tooDeep)).toThrow('tree depth exceeds');
  });

  it('accepts exact per-element and total attribute caps, then rejects cap plus one', () => {
    const perElement = new CappedTreeAdapter();
    expect(() => perElement.createElement('div', html.NS.HTML, attrs(HTML_EXPORT_PARSE_LIMITS.maxAttributesPerElement))).not.toThrow();
    expect(() => perElement.createElement('div', html.NS.HTML, attrs(HTML_EXPORT_PARSE_LIMITS.maxAttributesPerElement + 1))).toThrow('element attribute count exceeds');

    const total = new CappedTreeAdapter();
    for (let index = 0; index < HTML_EXPORT_PARSE_LIMITS.maxAttributes / HTML_EXPORT_PARSE_LIMITS.maxAttributesPerElement; index++) {
      total.createElement('div', html.NS.HTML, attrs(HTML_EXPORT_PARSE_LIMITS.maxAttributesPerElement));
    }
    expect(total.counts.attributeCount).toBe(HTML_EXPORT_PARSE_LIMITS.maxAttributes);
    expect(() => total.createElement('div', html.NS.HTML, attrs(1))).toThrow('attribute count exceeds');
  });

  it('aborts a million tiny nodes before materializing a full default tree', () => {
    const source = '<i></i>'.repeat(1_000_000);
    expect(() => parseCapped(source)).toThrow('node count exceeds');
  });
  it('enforces caps when parse5 adopts additional attributes', () => {
    const adapter = new CappedTreeAdapter();
    const element = adapter.createElement('div', html.NS.HTML, attrs(HTML_EXPORT_PARSE_LIMITS.maxAttributesPerElement - 1));
    adapter.adoptAttributes(element, [{ name: 'data-final', value: 'ok' }]);
    expect(element.attrs).toHaveLength(HTML_EXPORT_PARSE_LIMITS.maxAttributesPerElement);
    expect(() => adapter.adoptAttributes(element, [{ name: 'data-over', value: 'no' }])).toThrow('element attribute count exceeds');
  });
  it('counts template fragments and stops an oversized template before returning it', () => {
    expect(() => parseCapped(`<template>${'<i></i>'.repeat(HTML_EXPORT_PARSE_LIMITS.maxNodes)}</template>`)).toThrow('node count exceeds');
  });

  it('aborts extreme nesting during construction', () => {
    const source = '<div>'.repeat(100_000) + '</div>'.repeat(100_000);
    expect(() => parseCapped(source)).toThrow('tree depth exceeds');
  });
  it('uses final reachable counts when parse5 detaches a provisional body for a frameset', () => {
    const adapter = new CappedTreeAdapter();
    const detachNode = vi.spyOn(adapter, 'detachNode');
    const document = parse('<!doctype html><html><head></head></body><frameset><frame></frameset>', { treeAdapter: adapter });
    const finalCounts = countReachableHtmlExportDocument(document);

    expect(detachNode).toHaveBeenCalledOnce();
    expect(adapter.counts.nodeCount).toBeGreaterThan(finalCounts.nodeCount);
    expect(finalCounts).toEqual({ nodeCount: 6, maxDepth: 3, attributeCount: 0 });
  });
});

describe('HtmlExportParseHost', () => {
  it('maps worker oversize failures without parsing in the main process', async () => {
    const worker = fakeWorker((emit) => emit({ ok: false, error: 'pipeline-oversize', detail: 'node count exceeds 20000' }));
    const result = await new HtmlExportParseHost({ spawn: () => worker }).parse('<p>x</p>');
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ ok: false, error: { kind: 'pipeline-oversize' } });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it('returns a bounded parse5-compatible document supplied by the worker', async () => {
    const document = parse('<p>worker document</p>');
    const worker = fakeWorker((emit) => emit({
      ok: true,
      document,
      counts: { nodeCount: 6, maxDepth: 4, attributeCount: 0 },
    }));
    const result = await new HtmlExportParseHost({ spawn: () => worker }).parse('<p>worker document</p>');
    expect(result).toMatchObject({ ok: true, value: { document, counts: { nodeCount: 6 } } });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it('accepts parse5 final metrics after a construction-only body is detached', async () => {
    const { document, adapter } = parseCapped('<!doctype html><html><head></head></body><frameset><frame></frameset>');
    const counts = countReachableHtmlExportDocument(document);
    const worker = fakeWorker((emit) => emit({ ok: true, document, counts }));

    const result = await new HtmlExportParseHost({ spawn: () => worker }).parse('<frameset><frame>');

    expect(adapter.counts.nodeCount).toBeGreaterThan(counts.nodeCount);
    expect(result).toMatchObject({ ok: true, value: { counts } });
  });
  it('uses the production worker path, 128 MiB limit, and exact default deadline', async () => {
    const worker = fakeWorker((emit) => emit({ ok: false, error: 'pipeline-reject', detail: 'done' }));
    let workerPath: string | undefined;
    let workerOptions: { resourceLimits?: { maxOldGenerationSizeMb?: number } } | undefined;
    let timeoutMs: number | undefined;
    const result = await new HtmlExportParseHost({
      workerFactory: (filename, options) => {
        workerPath = filename;
        workerOptions = options;
        return worker;
      },
      setTimeout: (_callback, timeout) => {
        timeoutMs = timeout;
        return {} as ReturnType<typeof setTimeout>;
      },
      clearTimeout: vi.fn(),
    }).parse('<p>x</p>');

    expect(result).toMatchObject({ ok: false, error: { kind: 'pipeline-reject' } });
    expect(workerPath).toMatch(/html-export-parse-worker\.js$/);
    expect(workerOptions).toMatchObject({ resourceLimits: { maxOldGenerationSizeMb: 128 } });
    expect(timeoutMs).toBe(2_000);
  });

  it('accepts one structured-clone reply from a one-shot Worker fixture', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'html-export-parse-worker-'));
    const fixture = path.join(directory, 'fixture.js');
    await writeFile(fixture, [
      "const { parentPort } = require('node:worker_threads');",
      "parentPort.once('message', ({ html }) => {",
      "  parentPort.postMessage({ ok: true, document: { nodeName: '#document', childNodes: [{ nodeName: '#comment', data: html }] }, counts: { nodeCount: 2, maxDepth: 1, attributeCount: 0 } });",
      '  parentPort.close();',
      '});',
    ].join('\n'));

    try {
      const result = await new HtmlExportParseHost({ spawn: () => new Worker(fixture) as unknown as HtmlExportParseWorker })
        .parse('<p>structured clone</p>');

      expect(result).toMatchObject({
        ok: true,
        value: {
          counts: { nodeCount: 2, maxDepth: 1, attributeCount: 0 },
          document: { childNodes: [{ data: '<p>structured clone</p>' }] },
        },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('maps termination rejection to pipeline-reject after a worker reply', async () => {
    const document = parse('<p>worker document</p>');
    const worker = fakeWorker((emit) => emit({
      ok: true,
      document,
      counts: { nodeCount: 6, maxDepth: 4, attributeCount: 0 },
    }));
    worker.terminate.mockRejectedValue(new Error('termination failed'));

    const result = await new HtmlExportParseHost({ spawn: () => worker }).parse('<p>x</p>');

    expect(result).toEqual({ ok: false, error: { kind: 'pipeline-reject', detail: 'termination failed' } });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('terminates and rejects typed when the deadline fires', async () => {
    let fireTimeout: (() => void) | undefined;
    const worker = fakeWorker(() => undefined);
    const timer = {} as ReturnType<typeof setTimeout>;
    const host = new HtmlExportParseHost({
      spawn: () => worker,
      setTimeout: (callback) => {
        fireTimeout = callback;
        return timer;
      },
      clearTimeout: vi.fn(),
    });
    const pending = host.parse('<p>x</p>');
    fireTimeout?.();
    const result = await pending;
    expect(result).toMatchObject({ ok: false, error: { kind: 'pipeline-reject' } });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it.each([
    ['crash', (emit: (message: unknown) => void, crash: (error: Error) => void) => crash(new Error('boom'))],
    ['invalid reply', (emit: (message: unknown) => void) => emit({ ok: true, document: null, counts: {} })],
  ])('maps a worker %s to pipeline-reject', async (_name, behavior) => {
    const worker = fakeWorker(behavior);
    const result = await new HtmlExportParseHost({ spawn: () => worker }).parse('<p>x</p>');
    expect(result).toMatchObject({ ok: false, error: { kind: 'pipeline-reject' } });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
