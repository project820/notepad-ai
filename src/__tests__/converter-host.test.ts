/**
 * converter-host.test.ts — out-of-main converter isolation host (Phase 3).
 *
 * Exercises the host's correlation, wall-clock timeout (kill + reject), and
 * crash-recovery (worker exit rejects in-flight + next call respawns) using a
 * fake worker transport — no real utilityProcess needed.
 */

import { describe, it, expect } from 'vitest';
import {
  ConverterHost,
  type WorkerTransport,
  type ConverterRequest,
  type ConverterResponse,
} from '../main/converter-host';

/** A controllable fake worker: capture posts, push responses, simulate exit. */
class FakeWorker implements WorkerTransport {
  posts: ConverterRequest[] = [];
  killed = false;
  private msgCb: ((m: ConverterResponse) => void) | null = null;
  private exitCb: (() => void) | null = null;
  post(msg: ConverterRequest): void {
    this.posts.push(msg);
  }
  onMessage(cb: (m: ConverterResponse) => void): void {
    this.msgCb = cb;
  }
  onExit(cb: () => void): void {
    this.exitCb = cb;
  }
  kill(): void {
    this.killed = true;
  }
  emit(m: ConverterResponse): void {
    this.msgCb?.(m);
  }
  exit(): void {
    this.exitCb?.();
  }
}

const bytes = new Uint8Array([1, 2, 3]);

describe('ConverterHost', () => {
  it('spawns one worker lazily and correlates a response by id', async () => {
    const workers: FakeWorker[] = [];
    const host = new ConverterHost(() => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    }, { timeoutMs: 1000 });

    const p = host.runConvert('docx', bytes);
    expect(workers).toHaveLength(1);
    const sent = workers[0].posts[0];
    expect(sent.ext).toBe('docx');
    workers[0].emit({ id: sent.id, ok: true, markdown: '# hi' });
    await expect(p).resolves.toEqual({ id: sent.id, ok: true, markdown: '# hi' });
    expect(host.inFlight).toBe(0);
  });

  it('reuses a single worker across sequential requests', async () => {
    let spawnCount = 0;
    const w = new FakeWorker();
    const host = new ConverterHost(() => {
      spawnCount += 1;
      return w;
    }, { timeoutMs: 1000 });
    const p1 = host.runConvert('pdf', bytes);
    w.emit({ id: w.posts[0].id, ok: true, markdown: 'a' });
    await p1;
    const p2 = host.runConvert('pdf', bytes);
    w.emit({ id: w.posts[1].id, ok: true, markdown: 'b' });
    await p2;
    expect(spawnCount).toBe(1);
  });

  it('times out: kills the worker, rejects, and respawns on the next call', async () => {
    const workers: FakeWorker[] = [];
    const host = new ConverterHost(() => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    }, { timeoutMs: 10 });

    await expect(host.runConvert('hwp', bytes)).rejects.toThrow('converter-timeout');
    expect(workers[0].killed).toBe(true);
    expect(host.inFlight).toBe(0);

    // Next call must spawn a FRESH worker (the killed one was dropped).
    const p = host.runConvert('hwp', bytes);
    expect(workers).toHaveLength(2);
    workers[1].emit({ id: workers[1].posts[0].id, ok: true, markdown: 'ok' });
    await expect(p).resolves.toMatchObject({ ok: true });
  });

  it('crash recovery: a worker exit rejects in-flight work and respawns next time', async () => {
    const workers: FakeWorker[] = [];
    const host = new ConverterHost(() => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    }, { timeoutMs: 1000 });

    const p = host.runConvert('xlsx', bytes);
    workers[0].exit();
    await expect(p).rejects.toThrow('converter-worker-exited');
    expect(host.inFlight).toBe(0);

    const p2 = host.runConvert('xlsx', bytes);
    expect(workers).toHaveLength(2);
    workers[1].emit({ id: workers[1].posts[0].id, ok: false, error: 'bad doc' });
    await expect(p2).resolves.toMatchObject({ ok: false, error: 'bad doc' });
  });

  it('surfaces a worker conversion error as a resolved ok:false response', async () => {
    const w = new FakeWorker();
    const host = new ConverterHost(() => w, { timeoutMs: 1000 });
    const p = host.runConvert('docx', bytes);
    w.emit({ id: w.posts[0].id, ok: false, error: 'kordoc parse failed' });
    await expect(p).resolves.toEqual({ id: w.posts[0].id, ok: false, error: 'kordoc parse failed' });
  });
});
