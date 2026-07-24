/**
 * Window registry — v0.3 multi-window groundwork (G001).
 *
 * The ADR splits ownership: each window's renderer owns its document state, while
 * `main` owns a registry of live windows plus IPC routing, file-path ownership
 * (locking), and the session aggregate. This module is the in-memory registry.
 *
 * It is deliberately free of Electron / `BrowserWindow` dependencies: records are
 * plain objects keyed by numeric ids, so the routing + path-ownership logic is
 * unit-testable in plain Node. The runtime (G002) constructs records from real
 * `BrowserWindow` / `webContents` ids and wires lifecycle events.
 */

import type { SessionWindowSnapshot } from './session-schema';

/** One queued main→renderer message held until the target window reports ready. */
type OutboundMessage = { channel: string; payload: unknown };

/** Performs the actual delivery of a main→renderer message (e.g. `webContents.send`). */
export type OutboundSink = (channel: string, payload: unknown) => void;

/** Result of {@link WindowRegistry.resolvePathClaim}: open/save may proceed, or must focus the owner. */
export type PathClaimDecision =
  | { kind: 'proceed' }
  | { kind: 'focus-owner'; ownerWindowId: number };

export type WindowRecord = {
  /** `BrowserWindow.id` at runtime (any stable numeric id in tests). */
  windowId: number;
  /** `webContents.id` — used to route sender-scoped IPC back to its window. */
  webContentsId: number;
  /** Absolute path this window currently owns (locks), or null/undefined when none. */
  currentPath?: string | null;
  /** Monotonic focus timestamp; highest wins for `focusedOrLast()`. */
  lastFocusedAt: number;
  /** Stable session id for this window; keys the v2 session-aggregate upsert. */
  windowKey: string;
  /** True once the renderer reported `window:ready`; gates outbound delivery. */
  ready: boolean;
  /** Outbound messages queued while the renderer was not yet ready (FIFO). */
  pendingOutbound: OutboundMessage[];
  /** Snapshot to restore into this window on launch (session aggregate). */
  restoreSnapshot?: SessionWindowSnapshot;
  /** One-shot restore mode assigned by main for this window only. */
  restoreReason?: 'shutdown';
  /** Most recent snapshot reported by this window's renderer. */
  lastSnapshot?: SessionWindowSnapshot;
};

/**
 * In-memory map of live windows. Single-process owned by `main`; all methods are
 * synchronous and side-effect-free apart from the registry's own state.
 */
export class WindowRegistry {
  private readonly byWindowId = new Map<number, WindowRecord>();

  /** Register (or replace) a record by its `windowId`. Returns the stored record. */
  register(record: WindowRecord): WindowRecord {
    this.byWindowId.set(record.windowId, record);
    return record;
  }

  /** Remove a window and release any path it owned. No-op for unknown ids. */
  unregister(windowId: number): void {
    const rec = this.byWindowId.get(windowId);
    if (rec) rec.currentPath = null;
    this.byWindowId.delete(windowId);
  }

  get(windowId: number): WindowRecord | null {
    return this.byWindowId.get(windowId) ?? null;
  }

  /** Route an inbound IPC message (identified by sender) to its window record. */
  getByWebContents(webContentsId: number): WindowRecord | null {
    for (const rec of this.byWindowId.values()) {
      if (rec.webContentsId === webContentsId) return rec;
    }
    return null;
  }

  /** All live records, in insertion order. */
  all(): WindowRecord[] {
    return [...this.byWindowId.values()];
  }

  /** The most recently focused window, or null when the registry is empty. */
  focusedOrLast(): WindowRecord | null {
    let best: WindowRecord | null = null;
    for (const rec of this.byWindowId.values()) {
      if (!best || rec.lastFocusedAt > best.lastFocusedAt) best = rec;
    }
    return best;
  }

  /** Record a focus event so menu actions target the right window. */
  touchFocus(windowId: number, ts: number): void {
    const rec = this.byWindowId.get(windowId);
    if (rec) rec.lastFocusedAt = ts;
  }

  /** The window that currently owns `path`, or null when nobody does. */
  ownerOfPath(path: string): WindowRecord | null {
    for (const rec of this.byWindowId.values()) {
      if (rec.currentPath != null && rec.currentPath === path) return rec;
    }
    return null;
  }

  /**
   * Claim ownership of `path` for `windowId`. Returns false (no change) when an
   * unknown window claims, or when another window already owns the path — the
   * caller must focus the existing owner instead of silently overwriting it.
   */
  claimPath(windowId: number, path: string): boolean {
    const rec = this.byWindowId.get(windowId);
    if (!rec) return false;
    const owner = this.ownerOfPath(path);
    if (owner && owner.windowId !== windowId) return false;
    rec.currentPath = path;
    return true;
  }

  /** Release whatever path `windowId` owned. No-op for unknown ids. */
  releasePath(windowId: number): void {
    const rec = this.byWindowId.get(windowId);
    if (rec) rec.currentPath = null;
  }
  /** Restore the previous path claim after a failed Save As write. */
  restorePathClaim(windowId: number, previousPath: string | null): void {
    if (previousPath) this.claimPath(windowId, previousPath);
    else this.releasePath(windowId);
  }
  /** Release a path once the owning renderer snapshots a new unsaved document. */
  syncSnapshotPath(windowId: number, snapshot: Pick<SessionWindowSnapshot, 'path'>): void {
    if (snapshot.path === null) this.releasePath(windowId);
  }

  /**
   * Decide whether `windowId` may claim `path`. Returns `focus-owner` (with the
   * owning window id) when another live window already owns it, so the caller
   * focuses that owner instead of silently overwriting — otherwise `proceed`.
   */
  resolvePathClaim(windowId: number, path: string): PathClaimDecision {
    const owner = this.ownerOfPath(path);
    if (owner && owner.windowId !== windowId) {
      return { kind: 'focus-owner', ownerWindowId: owner.windowId };
    }
    return { kind: 'proceed' };
  }

  /** Mark the window (by webContents id) ready. Returns the record so the caller can flush. */
  markReady(webContentsId: number): WindowRecord | null {
    const rec = this.getByWebContents(webContentsId);
    if (rec) rec.ready = true;
    return rec;
  }
}

/** Factory convenience for callers that prefer not to use `new`. */
export function createWindowRegistry(): WindowRegistry {
  return new WindowRegistry();
}

/**
 * Send `payload` on `channel` immediately when the record is ready, otherwise
 * enqueue it (FIFO) to be flushed after the renderer reports `window:ready`.
 * Pure aside from the injected `sink`, so the ready-gate is unit-testable.
 */
export function sendWhenReady(
  record: Pick<WindowRecord, 'ready' | 'pendingOutbound'>,
  channel: string,
  payload: unknown,
  sink: OutboundSink,
): void {
  if (record.ready) {
    sink(channel, payload);
    return;
  }
  record.pendingOutbound.push({ channel, payload });
}

/**
 * Flush the record's queued outbound messages in FIFO order exactly once and
 * return how many were delivered. Idempotent: a second call flushes nothing.
 */
export function flushPendingOutbound(
  record: Pick<WindowRecord, 'pendingOutbound'>,
  sink: OutboundSink,
): number {
  if (record.pendingOutbound.length === 0) return 0;
  const queued = record.pendingOutbound.splice(0);
  for (const msg of queued) sink(msg.channel, msg.payload);
  return queued.length;
}
