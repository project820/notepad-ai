/**
 * stream-limits.test.ts — stream resource bounds (Phase 3).
 *
 * Covers the capped error-body reader and the STREAM_LIMITS contract that the
 * SSE/NDJSON streamers use to keep a hostile provider from exhausting the main
 * process. (The full SSE/NDJSON happy-path streaming is covered in
 * ai-provider.test.ts; here we exercise the bounding helper directly.)
 */

import { describe, it, expect } from 'vitest';
import { readCappedText, STREAM_LIMITS } from '../main/ai/stream-http';

/** Build a Response whose body streams `chunks` of bytes. */
function streamingResponse(chunks: Uint8Array[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  return new Response(body, { status: 500 });
}

const enc = (s: string) => new TextEncoder().encode(s);

describe('STREAM_LIMITS', () => {
  it('exposes sane positive byte caps with output >= buffer >= errorBody', () => {
    expect(STREAM_LIMITS.errorBodyMax).toBeGreaterThan(0);
    expect(STREAM_LIMITS.bufferMax).toBeGreaterThanOrEqual(STREAM_LIMITS.errorBodyMax);
    expect(STREAM_LIMITS.outputMax).toBeGreaterThanOrEqual(STREAM_LIMITS.bufferMax);
  });
});

describe('readCappedText', () => {
  it('returns the whole body when it is under the cap', async () => {
    const r = streamingResponse([enc('short error detail')]);
    expect(await readCappedText(r, 1024)).toBe('short error detail');
  });

  it('caps an oversized body to maxBytes (never buffers the whole stream)', async () => {
    // Emit far more than the cap across many chunks.
    const chunks = Array.from({ length: 100 }, () => enc('x'.repeat(1000)));
    const r = streamingResponse(chunks);
    const out = await readCappedText(r, 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out).toBe('x'.repeat(50));
  });

  it('tolerates an empty body', async () => {
    const r = new Response(null, { status: 500 });
    expect(await readCappedText(r, 64)).toBe('');
  });
});
