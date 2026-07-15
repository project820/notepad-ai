import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_VIEWPORT,
  HTML_EXPORT_QUARANTINE_MAX_BYTES,
  HtmlExportQuarantinePool,
  normalizeQuarantineViewport,
  type QuarantineHost,
  type QuarantineHostOutcome,
  type QuarantineRegistryReader,
  type QuarantineSlotSession,
  type QuarantineViewport,
} from '../main/html-export-quarantine';
import {
  HTML_EXPORT_STAGE_ARTIFACT_MAX_BYTES,
  type HtmlExportAttemptId,
  type HtmlExportQuarantineMeasurement,
  type ResolvedArtifactId,
} from '../shared/html-export-pipeline';

const PASS_MEASUREMENT: HtmlExportQuarantineMeasurement = {
  nodeCount: 12,
  maxDepth: 4,
  documentWidth: 800,
  documentHeight: 600,
  viewportWidth: 800,
  viewportHeight: 600,
  horizontalOverflow: false,
  activeRegionCount: 1,
  printNavHidden: true,
  printSectionsOrdered: true,
};

function attempt(id: string): HtmlExportAttemptId {
  return id as HtmlExportAttemptId;
}

function artifact(id: string): ResolvedArtifactId {
  return id as ResolvedArtifactId;
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function errorKind(result: Awaited<ReturnType<HtmlExportQuarantinePool['measure']>>): string {
  return result.ok ? 'ok' : result.error.kind;
}

type SlotHooks = {
  measureImpl?: (
    html: string,
    opts: { deadlineMs: number; signal: AbortSignal; viewport?: QuarantineViewport },
  ) => Promise<QuarantineHostOutcome>;
  resetImpl?: () => Promise<void>;
};

class FakeSlot implements QuarantineSlotSession {
  readonly measureCalls: Array<{ html: string; deadlineMs: number; viewport?: QuarantineViewport }> = [];
  readonly resetCalls: number[] = [];
  private resetCount = 0;
  private entered!: { resolve: () => void; promise: Promise<void> };
  private settle!: {
    resolve: (outcome: QuarantineHostOutcome) => void;
    reject: (error: unknown) => void;
    promise: Promise<QuarantineHostOutcome>;
  };
  private hang = false;
  measureImpl?: SlotHooks['measureImpl'];
  resetImpl?: SlotHooks['resetImpl'];

  constructor() {
    this.resetControl();
  }

  /** Next measure hangs until {@link resolveHang} / {@link rejectHang}. */
  hangNextMeasure(): void {
    this.hang = true;
    this.resetControl();
  }

  /** Resolves once the hung measure has been entered (admission complete). */
  whenEntered(): Promise<void> {
    return this.entered.promise;
  }

  resolveHang(outcome: QuarantineHostOutcome): void {
    this.settle.resolve(outcome);
  }

  rejectHang(error: unknown): void {
    this.settle.reject(error);
  }

  private resetControl(): void {
    let enteredResolve!: () => void;
    this.entered = {
      resolve: () => enteredResolve(),
      promise: new Promise<void>((r) => {
        enteredResolve = r;
      }),
    };
    let settleResolve!: (outcome: QuarantineHostOutcome) => void;
    let settleReject!: (error: unknown) => void;
    this.settle = {
      resolve: (outcome) => settleResolve(outcome),
      reject: (error) => settleReject(error),
      promise: new Promise<QuarantineHostOutcome>((resolve, reject) => {
        settleResolve = resolve;
        settleReject = reject;
      }),
    };
  }

  async measure(
    html: string,
    opts: { deadlineMs: number; signal: AbortSignal; viewport?: QuarantineViewport },
  ): Promise<QuarantineHostOutcome> {
    this.measureCalls.push({ html, deadlineMs: opts.deadlineMs, viewport: opts.viewport });
    if (this.measureImpl) return this.measureImpl(html, opts);

    if (this.hang) {
      this.entered.resolve();
      return await this.settle.promise;
    }

    // Default hang (deadline/cancel tests): wait forever unless settle is used.
    this.entered.resolve();
    return await this.settle.promise;
  }

  async reset(): Promise<void> {
    this.resetCount += 1;
    this.resetCalls.push(this.resetCount);
    // Prepare a fresh control plane so a reused slot can hang again.
    this.resetControl();
    if (this.resetImpl) await this.resetImpl();
  }

  get resets(): number {
    return this.resetCount;
  }
}

class FakeHost implements QuarantineHost {
  readonly slots: { 0: FakeSlot; 1: FakeSlot };

  constructor(hooks: Partial<Record<0 | 1, SlotHooks>> = {}) {
    this.slots = {
      0: Object.assign(new FakeSlot(), hooks[0] ?? {}),
      1: Object.assign(new FakeSlot(), hooks[1] ?? {}),
    };
  }

  slot(slotId: 0 | 1): QuarantineSlotSession {
    return this.slots[slotId];
  }

  totalResets(): number {
    return this.slots[0].resets + this.slots[1].resets;
  }
}

class FakeRegistry implements QuarantineRegistryReader {
  private readonly artifacts = new Map<
    string,
    {
      webContentsId: number;
      attemptId: HtmlExportAttemptId;
      bytes: Buffer;
    }
  >();
  nextError?: { kind: string };
  readCalls = 0;

  put(
    webContentsId: number,
    attemptId: HtmlExportAttemptId,
    artifactId: ResolvedArtifactId,
    bytes: Buffer | string,
  ): void {
    const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes;
    this.artifacts.set(artifactId, { webContentsId, attemptId, bytes: buf });
  }

  read(
    webContentsId: number,
    attemptId: HtmlExportAttemptId,
    artifactId: ResolvedArtifactId,
    expectedStage: 'resolved',
  ):
    | {
        ok: true;
        value: { ref: { byteLength: number; sha256: string }; bytes: Buffer };
      }
    | { ok: false; error: { kind: string } } {
    this.readCalls += 1;
    expect(expectedStage).toBe('resolved');
    if (this.nextError) {
      const error = this.nextError;
      this.nextError = undefined;
      return { ok: false, error };
    }
    const artifact = this.artifacts.get(artifactId);
    if (!artifact) return { ok: false, error: { kind: 'unknown-artifact' } };
    if (artifact.webContentsId !== webContentsId) {
      return { ok: false, error: { kind: 'wrong-sender' } };
    }
    if (artifact.attemptId !== attemptId) {
      return { ok: false, error: { kind: 'stale-artifact' } };
    }
    return {
      ok: true,
      value: {
        ref: {
          byteLength: artifact.bytes.byteLength,
          sha256: digest(artifact.bytes),
        },
        bytes: Buffer.from(artifact.bytes),
      },
    };
  }
}

function poolFor(opts: {
  registry?: FakeRegistry;
  host?: FakeHost;
  deadlineMs?: number;
}): {
  pool: HtmlExportQuarantinePool;
  registry: FakeRegistry;
  host: FakeHost;
} {
  const registry = opts.registry ?? new FakeRegistry();
  const host = opts.host ?? new FakeHost();
  const pool = new HtmlExportQuarantinePool({
    registry,
    host,
    deadlineMs: opts.deadlineMs,
  });
  return { pool, registry, host };
}

function seedPass(
  registry: FakeRegistry,
  webContentsId: number,
  attemptId: string,
  artifactId: string,
  html = '<p>ok</p>',
): void {
  registry.put(webContentsId, attempt(attemptId), artifact(artifactId), html);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('HtmlExportQuarantinePool — constants', () => {
  it('aliases the stage artifact cap (S4 will supersede with final-artifact cap)', () => {
    expect(HTML_EXPORT_QUARANTINE_MAX_BYTES).toBe(HTML_EXPORT_STAGE_ARTIFACT_MAX_BYTES);
    expect(HTML_EXPORT_QUARANTINE_MAX_BYTES).toBe(10 * 1024 * 1024);
  });
});

describe('HtmlExportQuarantinePool — admission', () => {
  it('returns quarantine-busy on a second concurrent same-webContents call', async () => {
    const host = new FakeHost();
    host.slots[0].hangNextMeasure();
    const { pool, registry } = poolFor({ host });
    seedPass(registry, 1, 'a1', 'r1');
    seedPass(registry, 1, 'a1', 'r2', '<p>second</p>');

    const first = pool.measure(1, attempt('a1'), artifact('r1'));
    await host.slots[0].whenEntered();

    const busy = await pool.measure(1, attempt('a1'), artifact('r2'));
    expect(errorKind(busy)).toBe('quarantine-busy');

    host.slots[0].resolveHang({ kind: 'measured', measurement: PASS_MEASUREMENT });
    const firstResult = await first;
    expect(firstResult.ok).toBe(true);
  });

  it('returns quarantine-busy on a third global call while both slots are busy', async () => {
    const host = new FakeHost();
    host.slots[0].hangNextMeasure();
    host.slots[1].hangNextMeasure();
    const { pool, registry } = poolFor({ host });
    seedPass(registry, 1, 'a1', 'r1');
    seedPass(registry, 2, 'a2', 'r2');
    seedPass(registry, 3, 'a3', 'r3');

    const first = pool.measure(1, attempt('a1'), artifact('r1'));
    const second = pool.measure(2, attempt('a2'), artifact('r2'));
    await Promise.all([host.slots[0].whenEntered(), host.slots[1].whenEntered()]);

    const busy = await pool.measure(3, attempt('a3'), artifact('r3'));
    expect(errorKind(busy)).toBe('quarantine-busy');
    // Busy path never reserved a slot, so no reset for a third slot.
    expect(host.totalResets()).toBe(0);

    host.slots[0].resolveHang({ kind: 'measured', measurement: PASS_MEASUREMENT });
    host.slots[1].resolveHang({ kind: 'measured', measurement: PASS_MEASUREMENT });
    await Promise.all([first, second]);
    expect(host.totalResets()).toBe(2);
  });

  it('reuses a freed slot for the next call after completion', async () => {
    const host = new FakeHost({
      0: {
        measureImpl: async () => ({ kind: 'measured', measurement: PASS_MEASUREMENT }),
      },
      1: {
        measureImpl: async () => ({ kind: 'measured', measurement: PASS_MEASUREMENT }),
      },
    });
    const { pool, registry } = poolFor({ host });
    seedPass(registry, 1, 'a1', 'r1');
    seedPass(registry, 1, 'a1', 'r2');

    const first = await pool.measure(1, attempt('a1'), artifact('r1'));
    expect(first.ok).toBe(true);
    expect(host.slots[0].measureCalls).toHaveLength(1);
    expect(host.slots[0].resets).toBe(1);
    expect(host.slots[1].measureCalls).toHaveLength(0);

    const second = await pool.measure(1, attempt('a1'), artifact('r2'));
    expect(second.ok).toBe(true);
    // Slot 0 freed and reused; slot 1 never needed.
    expect(host.slots[0].measureCalls).toHaveLength(2);
    expect(host.slots[0].resets).toBe(2);
    expect(host.slots[1].measureCalls).toHaveLength(0);
  });
});

describe('HtmlExportQuarantinePool — registry failures', () => {
  it.each([
    'unknown-artifact',
    'stale-artifact',
    'wrong-sender',
    'attempt-superseded',
    'pipeline-reject',
  ] as const)('maps registry %s to the same quarantine error kind', async (kind) => {
    const host = new FakeHost({
      0: {
        measureImpl: async () => ({ kind: 'measured', measurement: PASS_MEASUREMENT }),
      },
    });
    const registry = new FakeRegistry();
    registry.nextError = { kind };
    const { pool } = poolFor({ registry, host });

    const result = await pool.measure(1, attempt('a1'), artifact('missing'));
    expect(errorKind(result)).toBe(kind);
    expect(host.slots[0].measureCalls).toHaveLength(0);
    expect(host.slots[0].resets).toBe(1);
  });

  it('maps an unknown registry error kind to recoverable-failure', async () => {
    const host = new FakeHost({
      0: {
        measureImpl: async () => ({ kind: 'measured', measurement: PASS_MEASUREMENT }),
      },
    });
    const registry = new FakeRegistry();
    registry.nextError = { kind: 'pipeline-oversize' };
    const { pool } = poolFor({ registry, host });

    const result = await pool.measure(1, attempt('a1'), artifact('x'));
    expect(errorKind(result)).toBe('recoverable-failure');
    expect(host.slots[0].resets).toBe(1);
  });
});

describe('HtmlExportQuarantinePool — byte cap and decode', () => {
  it('returns quarantine-oversize when resolved bytes exceed the cap', async () => {
    const host = new FakeHost({
      0: {
        measureImpl: async () => ({ kind: 'measured', measurement: PASS_MEASUREMENT }),
      },
    });
    const { pool, registry } = poolFor({ host });
    registry.put(
      1,
      attempt('a1'),
      artifact('big'),
      Buffer.alloc(HTML_EXPORT_QUARANTINE_MAX_BYTES + 1, 0x61),
    );

    const result = await pool.measure(1, attempt('a1'), artifact('big'));
    expect(errorKind(result)).toBe('quarantine-oversize');
    expect(host.slots[0].measureCalls).toHaveLength(0);
    expect(host.slots[0].resets).toBe(1);
  });

  it('allows exactly the cap bytes', async () => {
    const host = new FakeHost({
      0: {
        measureImpl: async () => ({ kind: 'measured', measurement: PASS_MEASUREMENT }),
      },
    });
    const { pool, registry } = poolFor({ host });
    // Valid UTF-8 at exact cap (all ASCII 'a').
    registry.put(
      1,
      attempt('a1'),
      artifact('exact'),
      Buffer.alloc(HTML_EXPORT_QUARANTINE_MAX_BYTES, 0x61),
    );

    const result = await pool.measure(1, attempt('a1'), artifact('exact'));
    expect(result.ok).toBe(true);
    expect(host.slots[0].measureCalls).toHaveLength(1);
  });

  it('returns recoverable-failure on fatal UTF-8 decode failure', async () => {
    const host = new FakeHost({
      0: {
        measureImpl: async () => ({ kind: 'measured', measurement: PASS_MEASUREMENT }),
      },
    });
    const { pool, registry } = poolFor({ host });
    // Invalid UTF-8 lead byte.
    registry.put(1, attempt('a1'), artifact('bad'), Buffer.from([0xff, 0xfe, 0xfd]));

    const result = await pool.measure(1, attempt('a1'), artifact('bad'));
    expect(errorKind(result)).toBe('recoverable-failure');
    expect(host.slots[0].measureCalls).toHaveLength(0);
    expect(host.slots[0].resets).toBe(1);
  });
});

describe('HtmlExportQuarantinePool — host outcome mapping', () => {
  it.each([
    {
      name: 'measured pass',
      outcome: { kind: 'measured' as const, measurement: PASS_MEASUREMENT },
      expectOk: true,
      expectKind: 'ok',
    },
    {
      name: 'oversize',
      outcome: { kind: 'oversize' as const },
      expectOk: false,
      expectKind: 'quarantine-oversize',
    },
    {
      name: 'layout-violation',
      outcome: { kind: 'layout-violation' as const },
      expectOk: false,
      expectKind: 'layout-violation',
    },
    {
      name: 'crashed',
      outcome: { kind: 'crashed' as const },
      expectOk: false,
      expectKind: 'quarantine-crashed',
    },
    {
      name: 'unresponsive',
      outcome: { kind: 'unresponsive' as const },
      expectOk: false,
      expectKind: 'quarantine-unresponsive',
    },
    {
      name: 'recoverable-failure',
      outcome: { kind: 'recoverable-failure' as const },
      expectOk: false,
      expectKind: 'recoverable-failure',
    },
  ])('maps host $name', async ({ outcome, expectOk, expectKind }) => {
    const host = new FakeHost({
      0: {
        measureImpl: async () => outcome,
      },
    });
    const { pool, registry } = poolFor({ host });
    seedPass(registry, 1, 'a1', 'r1');

    const result = await pool.measure(1, attempt('a1'), artifact('r1'));
    if (expectOk) {
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.verdict).toBe('pass');
        expect(result.value.measurement).toEqual(PASS_MEASUREMENT);
      }
    } else {
      expect(errorKind(result)).toBe(expectKind);
    }
    expect(host.slots[0].resets).toBe(1);
  });

  it('maps a host throw to recoverable-failure', async () => {
    const host = new FakeHost({
      0: {
        measureImpl: async () => {
          throw new Error('host boom');
        },
      },
    });
    const { pool, registry } = poolFor({ host });
    seedPass(registry, 1, 'a1', 'r1');

    const result = await pool.measure(1, attempt('a1'), artifact('r1'));
    expect(errorKind(result)).toBe('recoverable-failure');
    expect(host.slots[0].resets).toBe(1);
  });
});

describe('HtmlExportQuarantinePool — deadline and cancel', () => {
  it('returns quarantine-timeout when the host hangs past the deadline and still resets', async () => {
    vi.useFakeTimers();
    const host = new FakeHost(); // default measure hangs
    const { pool, registry } = poolFor({ host, deadlineMs: 8_000 });
    seedPass(registry, 1, 'a1', 'r1');

    const pending = pool.measure(1, attempt('a1'), artifact('r1'));
    // Flush microtasks so the host race + timer are armed.
    await Promise.resolve();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(8_000);
    const result = await pending;

    expect(errorKind(result)).toBe('quarantine-timeout');
    expect(host.slots[0].resets).toBe(1);
  });

  it('cancelWebContents during a hung measure returns quarantine-cancelled and resets', async () => {
    const host = new FakeHost();
    const { pool, registry } = poolFor({ host, deadlineMs: 60_000 });
    seedPass(registry, 1, 'a1', 'r1');

    const pending = pool.measure(1, attempt('a1'), artifact('r1'));
    await Promise.resolve();
    await Promise.resolve();

    pool.cancelWebContents(1);
    const result = await pending;

    expect(errorKind(result)).toBe('quarantine-cancelled');
    expect(host.slots[0].resets).toBe(1);
  });

  it('cancelAttempt during a hung measure returns quarantine-cancelled and resets', async () => {
    const host = new FakeHost();
    const { pool, registry } = poolFor({ host, deadlineMs: 60_000 });
    seedPass(registry, 1, 'a1', 'r1');

    const pending = pool.measure(1, attempt('a1'), artifact('r1'));
    await Promise.resolve();
    await Promise.resolve();

    // Wrong attempt id is a no-op.
    pool.cancelAttempt(1, attempt('other'));
    await Promise.resolve();

    pool.cancelAttempt(1, attempt('a1'));
    const result = await pending;

    expect(errorKind(result)).toBe('quarantine-cancelled');
    expect(host.slots[0].resets).toBe(1);
  });
});

describe('HtmlExportQuarantinePool — teardown guarantees', () => {
  it('runs reset on every terminal path (success, registry fail, oversize, host fail)', async () => {
    const host = new FakeHost({
      0: {
        measureImpl: async () => ({ kind: 'measured', measurement: PASS_MEASUREMENT }),
      },
    });
    const registry = new FakeRegistry();
    const { pool } = poolFor({ registry, host });

    // success
    seedPass(registry, 1, 'a1', 'r1');
    await pool.measure(1, attempt('a1'), artifact('r1'));

    // registry fail
    registry.nextError = { kind: 'unknown-artifact' };
    await pool.measure(1, attempt('a1'), artifact('gone'));

    // oversize
    registry.put(
      1,
      attempt('a1'),
      artifact('big'),
      Buffer.alloc(HTML_EXPORT_QUARANTINE_MAX_BYTES + 1, 0x61),
    );
    await pool.measure(1, attempt('a1'), artifact('big'));

    // host recoverable
    host.slots[0].measureImpl = async () => ({ kind: 'crashed' });
    seedPass(registry, 1, 'a1', 'r2');
    await pool.measure(1, attempt('a1'), artifact('r2'));

    expect(host.slots[0].resets).toBe(4);
  });

  it('does not mask the measure verdict when reset throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const host = new FakeHost({
      0: {
        measureImpl: async () => ({ kind: 'measured', measurement: PASS_MEASUREMENT }),
        resetImpl: async () => {
          throw new Error('reset blew up');
        },
      },
    });
    const { pool, registry } = poolFor({ host });
    seedPass(registry, 1, 'a1', 'r1');

    const result = await pool.measure(1, attempt('a1'), artifact('r1'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.verdict).toBe('pass');
    }
    expect(host.slots[0].resets).toBe(1);
    expect(errorSpy).toHaveBeenCalled();

    // Slot must still be freed for the next call despite the throw.
    host.slots[0].resetImpl = async () => {};
    seedPass(registry, 1, 'a1', 'r2');
    const second = await pool.measure(1, attempt('a1'), artifact('r2'));
    expect(second.ok).toBe(true);

    errorSpy.mockRestore();
  });

  it('does not mask a typed host error when reset throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const host = new FakeHost({
      0: {
        measureImpl: async () => ({ kind: 'layout-violation' }),
        resetImpl: async () => {
          throw new Error('reset blew up');
        },
      },
    });
    const { pool, registry } = poolFor({ host });
    seedPass(registry, 1, 'a1', 'r1');

    const result = await pool.measure(1, attempt('a1'), artifact('r1'));
    expect(errorKind(result)).toBe('layout-violation');
    errorSpy.mockRestore();
  });
});

describe('HtmlExportQuarantinePool — viewport', () => {
  it('forwards a portrait viewport to the host measure (overflow gate at 720 wide)', async () => {
    const host = new FakeHost({
      0: {
        measureImpl: async (_html, opts) => {
          // Simulate a 1000px-wide document: passes at 1280, overflows at 720.
          const viewportWidth = opts.viewport?.width ?? DEFAULT_VIEWPORT.width;
          const horizontalOverflow = 1000 > viewportWidth + 1;
          return {
            kind: 'measured',
            measurement: {
              ...PASS_MEASUREMENT,
              documentWidth: 1000,
              viewportWidth,
              viewportHeight: opts.viewport?.height ?? DEFAULT_VIEWPORT.height,
              horizontalOverflow,
            },
          };
        },
      },
    });
    const { pool, registry } = poolFor({ host });
    seedPass(registry, 1, 'a1', 'r1');

    const portrait = await pool.measure(1, attempt('a1'), artifact('r1'), { width: 720, height: 1280 });
    expect(portrait.ok).toBe(true);
    if (portrait.ok) {
      expect(portrait.value.measurement.horizontalOverflow).toBe(true);
      expect(portrait.value.measurement.viewportWidth).toBe(720);
    }
    expect(host.slots[0].measureCalls[0]?.viewport).toEqual({ width: 720, height: 1280 });

    seedPass(registry, 1, 'a1', 'r2');
    const landscape = await pool.measure(1, attempt('a1'), artifact('r2'), { width: 1280, height: 720 });
    expect(landscape.ok).toBe(true);
    if (landscape.ok) {
      expect(landscape.value.measurement.horizontalOverflow).toBe(false);
    }
  });

  it('omits viewport on the host call when the caller supplies none (host falls back to DEFAULT)', async () => {
    const host = new FakeHost({
      0: {
        measureImpl: async () => ({ kind: 'measured', measurement: PASS_MEASUREMENT }),
      },
    });
    const { pool, registry } = poolFor({ host });
    seedPass(registry, 1, 'a1', 'r1');

    await pool.measure(1, attempt('a1'), artifact('r1'));
    expect(host.slots[0].measureCalls[0]?.viewport).toBeUndefined();
  });
});

describe('normalizeQuarantineViewport', () => {
  it('returns DEFAULT_VIEWPORT for absent/invalid input and clamps to the sane range', () => {
    expect(normalizeQuarantineViewport(undefined)).toEqual(DEFAULT_VIEWPORT);
    expect(normalizeQuarantineViewport(null)).toEqual(DEFAULT_VIEWPORT);
    expect(normalizeQuarantineViewport({})).toEqual(DEFAULT_VIEWPORT);
    expect(normalizeQuarantineViewport({ width: 0, height: 720 })).toEqual(DEFAULT_VIEWPORT);
    expect(normalizeQuarantineViewport({ width: 1280, height: -1 })).toEqual(DEFAULT_VIEWPORT);
    expect(normalizeQuarantineViewport({ width: 5000, height: 720 })).toEqual(DEFAULT_VIEWPORT);
    expect(normalizeQuarantineViewport({ width: 1280.9, height: 720.1 })).toEqual({ width: 1280, height: 720 });
    expect(normalizeQuarantineViewport({ width: 720, height: 1280 })).toEqual({ width: 720, height: 1280 });
    expect(normalizeQuarantineViewport({ width: 320, height: 4096 })).toEqual({ width: 320, height: 4096 });
    expect(normalizeQuarantineViewport({ width: 319, height: 720 })).toEqual(DEFAULT_VIEWPORT);
  });
});
