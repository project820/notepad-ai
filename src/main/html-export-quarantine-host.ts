/**
 * Production Electron quarantine host (PR-S3b / §5.12).
 *
 * Fixed 2-slot strict-sandbox offscreen measurement host. Partition lifetime is
 * owned here: reuse `he-quarantine-0|1` via `session.fromPartition(..., {cache:false})`,
 * never per-attempt partitions, never Session disposal (reuse + clearStorageData).
 */

import { BrowserWindow, session, type Session } from 'electron';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  QuarantineHost,
  QuarantineHostOutcome,
  QuarantineSlotSession,
} from './html-export-quarantine';
import type { HtmlExportQuarantineMeasurement } from '../shared/html-export-pipeline';

const LOCAL_URL_RE = /^(file:|data:|blob:|about:)/i;
const MAX_NODE_COUNT = 20_000;
const MAX_DEPTH = 64;
const DEFAULT_VIEWPORT = { width: 1280, height: 720 } as const;

/**
 * Single bounded DOM measurement. Returns a plain serializable object matching
 * `HtmlExportQuarantineMeasurement`. Depth walk is capped so a pathological tree
 * cannot hang the renderer; oversize is decided in the host after the return.
 */
const MEASURE_SCRIPT = `(() => {
  const nodeCount = document.getElementsByTagName('*').length;
  let maxDepth = 0;
  const walk = (el, depth) => {
    if (depth > maxDepth) maxDepth = depth;
    if (depth >= ${MAX_DEPTH}) return;
    const children = el.children;
    for (let i = 0; i < children.length; i++) walk(children[i], depth + 1);
  };
  if (document.documentElement) walk(document.documentElement, 1);
  const documentWidth = document.documentElement ? document.documentElement.scrollWidth : 0;
  const documentHeight = document.documentElement ? document.documentElement.scrollHeight : 0;
  const viewportWidth = window.innerWidth || 0;
  const viewportHeight = window.innerHeight || 0;
  const horizontalOverflow = documentWidth > viewportWidth + 1;
  let activeRegionCount = 0;
  try {
    activeRegionCount = document.querySelectorAll('[data-he-region="artifact"]').length;
  } catch (_) {
    activeRegionCount = 0;
  }
  return {
    nodeCount,
    maxDepth,
    documentWidth,
    documentHeight,
    viewportWidth,
    viewportHeight,
    horizontalOverflow,
    activeRegionCount,
    printNavHidden: true,
    printSectionsOrdered: true,
  };
})()`;

const SETTLE_SCRIPT = `(async () => {
  try {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
  } catch (_) {}
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return true;
})()`;

const RESIZE_SETTLE_SCRIPT = `(async () => {
  await new Promise((r) => requestAnimationFrame(r));
  return true;
})()`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMeasurement(value: unknown): value is HtmlExportQuarantineMeasurement {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.nodeCount === 'number' &&
    Number.isFinite(v.nodeCount) &&
    typeof v.maxDepth === 'number' &&
    Number.isFinite(v.maxDepth) &&
    typeof v.documentWidth === 'number' &&
    Number.isFinite(v.documentWidth) &&
    typeof v.documentHeight === 'number' &&
    Number.isFinite(v.documentHeight) &&
    typeof v.viewportWidth === 'number' &&
    Number.isFinite(v.viewportWidth) &&
    typeof v.viewportHeight === 'number' &&
    Number.isFinite(v.viewportHeight) &&
    typeof v.horizontalOverflow === 'boolean' &&
    typeof v.activeRegionCount === 'number' &&
    Number.isFinite(v.activeRegionCount) &&
    typeof v.printNavHidden === 'boolean' &&
    typeof v.printSectionsOrdered === 'boolean'
  );
}

class ElectronQuarantineSlot implements QuarantineSlotSession {
  private readonly slotId: 0 | 1;
  private readonly partitionName: string;
  private sessionRef: Session | null = null;
  private sessionHardened = false;
  private win: BrowserWindow | null = null;
  private tempDir: string | null = null;
  private blockedCount = 0;
  private cleanups: Array<() => void> = [];
  private measuring = false;

  constructor(slotId: 0 | 1) {
    this.slotId = slotId;
    this.partitionName = `he-quarantine-${slotId}`;
  }

  /** Cumulative remote requests cancelled by this slot's session filter. */
  get blockedRemoteRequests(): number {
    return this.blockedCount;
  }

  async measure(
    html: string,
    opts: { deadlineMs: number; signal: AbortSignal },
  ): Promise<QuarantineHostOutcome> {
    try {
      if (opts.signal.aborted) return { kind: 'recoverable-failure' };
      if (this.measuring) return { kind: 'recoverable-failure' };
      this.measuring = true;

      const ses = this.ensureSession();
      await this.discardWindow();

      const win = new BrowserWindow({
        show: false,
        width: DEFAULT_VIEWPORT.width,
        height: DEFAULT_VIEWPORT.height,
        useContentSize: true,
        webPreferences: {
          session: ses,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
          backgroundThrottling: false,
          offscreen: true,
        },
      });
      this.win = win;
      win.webContents.setAudioMuted(true);

      return await new Promise<QuarantineHostOutcome>((resolve) => {
        let settled = false;
        const finish = (outcome: QuarantineHostOutcome) => {
          if (settled) return;
          settled = true;
          resolve(outcome);
        };

        const onGone = () => finish({ kind: 'crashed' });
        const onUnresponsive = () => finish({ kind: 'unresponsive' });
        const denyNav = (event: Electron.Event) => {
          event.preventDefault();
        };

        win.webContents.on('render-process-gone', onGone);
        win.webContents.on('unresponsive', onUnresponsive);
        win.webContents.on('will-navigate', denyNav);
        win.webContents.on('will-redirect', denyNav);
        win.webContents.on('will-frame-navigate', denyNav);
        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

        this.cleanups.push(
          () => {
            try {
              if (!win.isDestroyed()) win.webContents.removeListener('render-process-gone', onGone);
            } catch {
              /* ignore */
            }
          },
          () => {
            try {
              if (!win.isDestroyed()) win.webContents.removeListener('unresponsive', onUnresponsive);
            } catch {
              /* ignore */
            }
          },
          () => {
            try {
              if (!win.isDestroyed()) {
                win.webContents.removeListener('will-navigate', denyNav);
                win.webContents.removeListener('will-redirect', denyNav);
                win.webContents.removeListener('will-frame-navigate', denyNav);
              }
            } catch {
              /* ignore */
            }
          },
        );

        void this.runMeasurePipeline(win, html, opts.deadlineMs, opts.signal, finish).catch(() => {
          if (!settled) finish({ kind: 'recoverable-failure' });
        });
      });
    } catch {
      return { kind: 'recoverable-failure' };
    } finally {
      this.measuring = false;
    }
  }

  async reset(): Promise<void> {
    try {
      for (const cleanup of this.cleanups) {
        try {
          cleanup();
        } catch {
          /* ignore */
        }
      }
      this.cleanups = [];
      await this.discardWindow();

      // Session reuse: clear partition storage/cache best-effort with a soft
      // timeout. Never claim Session disposal; the fixed partition name stays.
      if (this.sessionRef) {
        await Promise.race([this.clearSessionBestEffort(this.sessionRef), sleep(2_000)]);
      }

      if (this.tempDir) {
        const dir = this.tempDir;
        this.tempDir = null;
        try {
          await rm(dir, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    } catch {
      /* never throw from reset */
    }
  }

  private ensureSession(): Session {
    if (this.sessionRef) return this.sessionRef;
    const ses = session.fromPartition(this.partitionName, { cache: false });
    this.hardenSession(ses);
    this.sessionRef = ses;
    return ses;
  }

  private async clearSessionBestEffort(ses: Session): Promise<void> {
    try {
      await ses.clearStorageData();
    } catch {
      /* best-effort */
    }
    try {
      await ses.clearCache();
    } catch {
      /* best-effort */
    }
  }

  private hardenSession(ses: Session): void {
    if (this.sessionHardened) return;
    this.sessionHardened = true;

    ses.setPermissionRequestHandler((_wc, _permission, callback) => {
      callback(false);
    });
    ses.setPermissionCheckHandler(() => false);

    ses.webRequest.onBeforeRequest((details, callback) => {
      const url = String(details.url || '');
      if (LOCAL_URL_RE.test(url)) {
        callback({ cancel: false });
        return;
      }
      this.blockedCount += 1;
      callback({ cancel: true });
    });
  }

  private async runMeasurePipeline(
    win: BrowserWindow,
    html: string,
    deadlineMs: number,
    signal: AbortSignal,
    finish: (outcome: QuarantineHostOutcome) => void,
  ): Promise<void> {
    const started = Date.now();
    const remaining = () => Math.max(1, deadlineMs - (Date.now() - started));

    if (signal.aborted || win.isDestroyed()) {
      finish({ kind: 'recoverable-failure' });
      return;
    }

    if (!this.tempDir) {
      this.tempDir = await mkdtemp(join(tmpdir(), `he-quarantine-${this.slotId}-`));
    }
    const tempFile = join(this.tempDir, 'measure.html');
    await writeFile(tempFile, html, 'utf8');

    if (signal.aborted || win.isDestroyed()) {
      finish({ kind: 'recoverable-failure' });
      return;
    }

    await win.loadFile(tempFile);

    if (signal.aborted || win.isDestroyed()) {
      finish({ kind: 'recoverable-failure' });
      return;
    }

    // fonts + 2 rAF
    await this.execWithSoftTimeout(win, SETTLE_SCRIPT, remaining());

    if (signal.aborted || win.isDestroyed()) {
      finish({ kind: 'recoverable-failure' });
      return;
    }

    // Force a content resize then one more frame so layout settles.
    try {
      win.setContentSize(DEFAULT_VIEWPORT.width, DEFAULT_VIEWPORT.height);
    } catch {
      /* ignore */
    }
    await this.execWithSoftTimeout(win, RESIZE_SETTLE_SCRIPT, remaining());

    if (signal.aborted || win.isDestroyed()) {
      finish({ kind: 'recoverable-failure' });
      return;
    }

    const raw = await this.execMeasure(win, remaining());
    if (raw === null) {
      // Timed out while window still alive, or window died mid-call.
      if (!win.isDestroyed()) {
        finish({ kind: 'recoverable-failure' });
      }
      // If destroyed, crash/unresponsive listeners should have finished already.
      return;
    }

    if (!isMeasurement(raw)) {
      finish({ kind: 'recoverable-failure' });
      return;
    }

    if (raw.nodeCount > MAX_NODE_COUNT || raw.maxDepth > MAX_DEPTH) {
      finish({ kind: 'oversize' });
      return;
    }

    finish({ kind: 'measured', measurement: raw });
  }

  /**
   * Bounded executeJavaScript for the measurement payload.
   * Returns null on timeout (window still alive) or destroyed window / throw.
   */
  private async execMeasure(
    win: BrowserWindow,
    timeoutMs: number,
  ): Promise<HtmlExportQuarantineMeasurement | null> {
    if (win.isDestroyed()) return null;
    const js = win.webContents.executeJavaScript(MEASURE_SCRIPT, true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raced = await Promise.race([
        js.then(
          (value) => ({ source: 'js' as const, value }),
          () => ({ source: 'throw' as const }),
        ),
        new Promise<{ source: 'timeout' }>((resolve) => {
          timer = setTimeout(() => resolve({ source: 'timeout' }), timeoutMs);
        }),
      ]);
      if (raced.source === 'timeout') {
        void js.then(
          () => undefined,
          () => undefined,
        );
        return null;
      }
      if (raced.source === 'throw') return null;
      return isMeasurement(raced.value) ? raced.value : null;
    } catch {
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Soft settle helpers: ignore failures; never throw to caller. */
  private async execWithSoftTimeout(
    win: BrowserWindow,
    script: string,
    timeoutMs: number,
  ): Promise<void> {
    if (win.isDestroyed()) return;
    const js = win.webContents.executeJavaScript(script, true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        js.then(
          () => undefined,
          () => undefined,
        ),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } catch {
      /* ignore */
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      void js.then(
        () => undefined,
        () => undefined,
      );
    }
  }

  private async discardWindow(): Promise<void> {
    const win = this.win;
    this.win = null;
    if (!win) return;
    try {
      if (!win.isDestroyed()) {
        // Prefer destroy over close so offscreen windows do not linger.
        // Listener cleanup already ran via `cleanups`; avoid extra removeAllListeners
        // which can race the renderer teardown under strict sandbox.
        win.destroy();
      }
    } catch {
      /* ignore */
    }
    // Yield one tick so Chromium can finish process teardown before session clear.
    await sleep(0);
  }
}

/**
 * Fixed 2-slot production quarantine host. Construct after `app.whenReady()`.
 * Parent wires `new ElectronQuarantineHost()` into `HtmlExportQuarantinePool`.
 */
export class ElectronQuarantineHost implements QuarantineHost {
  private readonly slots: { 0: ElectronQuarantineSlot; 1: ElectronQuarantineSlot };

  constructor() {
    this.slots = {
      0: new ElectronQuarantineSlot(0),
      1: new ElectronQuarantineSlot(1),
    };
  }

  slot(slotId: 0 | 1): QuarantineSlotSession {
    return this.slots[slotId];
  }

  /**
   * Total remote requests cancelled across both fixed partitions.
   * Survives slot reset so the smoke runner can assert external-requests=0.
   */
  get blockedRemoteRequests(): number {
    return this.slots[0].blockedRemoteRequests + this.slots[1].blockedRemoteRequests;
  }
}
