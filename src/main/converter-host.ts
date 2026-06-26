/**
 * converter-host.ts — out-of-main document conversion (Phase 3 isolation).
 *
 * kordoc parses attacker-influenceable documents (HWP/DOCX/PDF/XLSX). Running an
 * untrusted parser in the main process means a parser crash or runaway loop takes
 * the whole app down or hangs the UI. This host runs conversion in a separate
 * worker (Electron `utilityProcess`) with:
 *   - request/response correlation by id,
 *   - a wall-clock deadline that KILLS the worker and rejects on timeout,
 *   - crash recovery: a worker exit rejects in-flight work and the next request
 *     transparently respawns a fresh worker.
 *
 * The transport + spawn are injected so the host logic is unit-testable without a
 * real utilityProcess. The Phase 0 size/precap + magic checks still gate inputs
 * before they reach the host; this adds fault isolation on top.
 */

export interface ConverterRequest {
  id: number;
  ext: string;
  /** Raw document bytes (structured-clone transferable to the worker). */
  data: Uint8Array;
}

export interface ConverterResponse {
  id: number;
  ok: boolean;
  markdown?: string;
  html?: string;
  error?: string;
}

/** Minimal worker transport (maps 1:1 onto an Electron UtilityProcess). */
export interface WorkerTransport {
  post(msg: ConverterRequest): void;
  onMessage(cb: (msg: ConverterResponse) => void): void;
  onExit(cb: () => void): void;
  kill(): void;
}

export type SpawnWorker = () => WorkerTransport;

export class ConverterHost {
  private worker: WorkerTransport | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (r: ConverterResponse) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(
    private readonly spawn: SpawnWorker,
    private readonly opts: { timeoutMs: number },
  ) {}

  private ensureWorker(): WorkerTransport {
    if (this.worker) return this.worker;
    const w = this.spawn();
    w.onMessage((m) => this.handleMessage(m));
    w.onExit(() => this.handleExit());
    this.worker = w;
    return w;
  }

  private handleMessage(m: ConverterResponse): void {
    const p = this.pending.get(m.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(m.id);
    p.resolve(m);
  }

  private handleExit(): void {
    // Worker crashed/exited: fail every in-flight request and drop the handle so
    // the next call spawns a fresh worker (crash recovery).
    const err = new Error('converter-worker-exited');
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.worker = null;
  }

  /** Convert `data` (a `.${ext}` document) to markdown/html in the worker. */
  runConvert(ext: string, data: Uint8Array): Promise<ConverterResponse> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<ConverterResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Kill the (possibly wedged) worker and force a respawn next time.
        try {
          worker.kill();
        } catch {
          /* ignore */
        }
        if (this.worker === worker) this.worker = null;
        reject(new Error('converter-timeout'));
      }, this.opts.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        worker.post({ id, ext, data });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** Pending request count (tests/diagnostics). */
  get inFlight(): number {
    return this.pending.size;
  }
}
