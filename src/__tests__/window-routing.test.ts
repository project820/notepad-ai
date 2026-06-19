/**
 * window-routing.test.ts
 *
 * Pure unit tests for the v0.3 multi-window IPC routing + ready-gate (G002). The
 * runtime logic in `main.ts` is deliberately thin around these helpers so the
 * decisions are testable without Electron:
 *
 *   - sender (webContents id) → window record routing  (IPC routing)
 *   - focusedOrLast()                                   (menu target routing)
 *   - resolvePathClaim()                                (duplicate-path open/save guard)
 *   - sendWhenReady() / flushPendingOutbound() / markReady()  (new-window ready-gate)
 */

import { describe, it, expect } from 'vitest';
import {
  createWindowRegistry,
  flushPendingOutbound,
  sendWhenReady,
  type OutboundSink,
  type WindowRecord,
} from '../../src/main/window-registry';

function record(
  over: Partial<WindowRecord> & Pick<WindowRecord, 'windowId' | 'webContentsId'>,
): WindowRecord {
  return {
    lastFocusedAt: 0,
    windowKey: `key-${over.windowId}`,
    ready: false,
    pendingOutbound: [],
    ...over,
  };
}

// ============================================================================
// A. sender → window routing (renderer IPC is routed by webContents id)
// ============================================================================

describe('sender → window routing', () => {
  it('routes an IPC sender to its window record', () => {
    const reg = createWindowRegistry();
    reg.register(record({ windowId: 1, webContentsId: 10 }));
    reg.register(record({ windowId: 2, webContentsId: 20 }));

    expect(reg.getByWebContents(10)?.windowId).toBe(1);
    expect(reg.getByWebContents(20)?.windowId).toBe(2);
    expect(reg.getByWebContents(999)).toBeNull();
  });

  it('stops routing to a window after it is unregistered (closed)', () => {
    const reg = createWindowRegistry();
    reg.register(record({ windowId: 1, webContentsId: 10 }));
    reg.unregister(1);
    expect(reg.getByWebContents(10)).toBeNull();
  });
});

// ============================================================================
// B. menu target = focusedOrLast (menus act on the focused/last-focused window)
// ============================================================================

describe('menu target = focusedOrLast', () => {
  it('targets the most-recently focused window', () => {
    const reg = createWindowRegistry();
    reg.register(record({ windowId: 1, webContentsId: 10, lastFocusedAt: 100 }));
    reg.register(record({ windowId: 2, webContentsId: 20, lastFocusedAt: 200 }));

    expect(reg.focusedOrLast()?.windowId).toBe(2);
    reg.touchFocus(1, 999);
    expect(reg.focusedOrLast()?.windowId).toBe(1);
  });

  it('returns null when there are no windows', () => {
    expect(createWindowRegistry().focusedOrLast()).toBeNull();
  });
});

// ============================================================================
// C. duplicate-path guard (open focuses owner; save to owned path is blocked)
// ============================================================================

describe('resolvePathClaim — duplicate-path guard', () => {
  it('proceeds when the path is unowned', () => {
    const reg = createWindowRegistry();
    reg.register(record({ windowId: 1, webContentsId: 10 }));
    expect(reg.resolvePathClaim(1, '/a.md')).toEqual({ kind: 'proceed' });
  });

  it('proceeds when the requesting window already owns the path (normal Save)', () => {
    const reg = createWindowRegistry();
    reg.register(record({ windowId: 1, webContentsId: 10 }));
    expect(reg.claimPath(1, '/a.md')).toBe(true);
    expect(reg.resolvePathClaim(1, '/a.md')).toEqual({ kind: 'proceed' });
  });

  it('focuses the owner when another live window holds the path (Save As / open)', () => {
    const reg = createWindowRegistry();
    reg.register(record({ windowId: 1, webContentsId: 10 }));
    reg.register(record({ windowId: 2, webContentsId: 20 }));
    expect(reg.claimPath(1, '/shared.md')).toBe(true);

    expect(reg.resolvePathClaim(2, '/shared.md')).toEqual({
      kind: 'focus-owner',
      ownerWindowId: 1,
    });
    // …and the conflicting claim is rejected so the owner is never overwritten.
    expect(reg.claimPath(2, '/shared.md')).toBe(false);
    expect(reg.ownerOfPath('/shared.md')?.windowId).toBe(1);
  });
});

// ============================================================================
// D. new-window ready-gate (queue file:opened until renderer reports ready)
// ============================================================================

describe('ready-gate outbound queue', () => {
  it('queues payloads before ready and flushes them in FIFO order after markReady', () => {
    const reg = createWindowRegistry();
    const rec = reg.register(record({ windowId: 1, webContentsId: 10 }));
    const sent: unknown[] = [];
    const sink: OutboundSink = (_channel, payload) => sent.push(payload);

    sendWhenReady(rec, 'file:opened', { progress: 'Converting…' }, sink);
    sendWhenReady(rec, 'file:opened', { content: 'final' }, sink);
    expect(sent).toEqual([]); // nothing delivered while the renderer is not ready
    expect(rec.pendingOutbound).toHaveLength(2);

    expect(reg.markReady(10)).toBe(rec);
    expect(rec.ready).toBe(true);

    expect(flushPendingOutbound(rec, sink)).toBe(2);
    expect(sent).toEqual([{ progress: 'Converting…' }, { content: 'final' }]);
    expect(rec.pendingOutbound).toHaveLength(0);
  });

  it('delivers immediately once the window is ready (no queueing)', () => {
    const reg = createWindowRegistry();
    const rec = reg.register(record({ windowId: 1, webContentsId: 10, ready: true }));
    const sent: string[] = [];
    sendWhenReady(rec, 'file:opened', 'x', (channel) => sent.push(channel));
    expect(sent).toEqual(['file:opened']);
    expect(rec.pendingOutbound).toHaveLength(0);
  });

  it('flush is single-shot: a second flush delivers nothing', () => {
    const rec = record({ windowId: 1, webContentsId: 10 });
    const sent: unknown[] = [];
    const sink: OutboundSink = (_channel, payload) => sent.push(payload);

    sendWhenReady(rec, 'file:opened', 'doc', sink);
    expect(flushPendingOutbound(rec, sink)).toBe(1);
    expect(flushPendingOutbound(rec, sink)).toBe(0);
    expect(sent).toEqual(['doc']);
  });

  it('queues are scoped per window — flushing one never leaks into another', () => {
    const reg = createWindowRegistry();
    const a = reg.register(record({ windowId: 1, webContentsId: 10 }));
    const b = reg.register(record({ windowId: 2, webContentsId: 20 }));
    const noop: OutboundSink = () => {};

    sendWhenReady(a, 'file:opened', 'A-doc', noop);
    sendWhenReady(b, 'file:opened', 'B-doc', noop);
    expect(a.pendingOutbound).toHaveLength(1);
    expect(b.pendingOutbound).toHaveLength(1);

    const aSent: unknown[] = [];
    reg.markReady(10);
    flushPendingOutbound(a, (_channel, payload) => aSent.push(payload));

    expect(aSent).toEqual(['A-doc']);
    expect(b.pendingOutbound).toHaveLength(1); // window 2 untouched
    expect(b.ready).toBe(false);
  });

  it('markReady returns null for an unknown sender', () => {
    expect(createWindowRegistry().markReady(123)).toBeNull();
  });
});
