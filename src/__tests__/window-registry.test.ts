/**
 * window-registry.test.ts
 *
 * Pure unit tests for the v0.3 multi-window registry (G001). The registry holds
 * plain records (no BrowserWindow handles), so all routing + path-ownership logic
 * is testable without Electron.
 *
 * Coverage:
 *   - register + getByWebContents (sender → window routing)
 *   - focusedOrLast (most-recent-focus, with empty fallback)
 *   - unregister releases the owned path
 *   - claimPath rejects a path already owned by another window
 *   - ownerOfPath lookup
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowRegistry, createWindowRegistry, type WindowRecord } from '../../src/main/window-registry';

function record(over: Partial<WindowRecord> & Pick<WindowRecord, 'windowId' | 'webContentsId'>): WindowRecord {
  return { lastFocusedAt: 0, ...over };
}

let reg: WindowRegistry;

beforeEach(() => {
  reg = new WindowRegistry();
});

// ============================================================================
// A. register / get / getByWebContents
// ============================================================================

describe('register + lookup', () => {
  it('registers a record and finds it by windowId', () => {
    reg.register(record({ windowId: 1, webContentsId: 10 }));
    expect(reg.get(1)?.webContentsId).toBe(10);
    expect(reg.get(999)).toBeNull();
  });

  it('routes by webContents id (IPC sender → window)', () => {
    reg.register(record({ windowId: 1, webContentsId: 10 }));
    reg.register(record({ windowId: 2, webContentsId: 20 }));

    expect(reg.getByWebContents(20)?.windowId).toBe(2);
    expect(reg.getByWebContents(10)?.windowId).toBe(1);
    expect(reg.getByWebContents(30)).toBeNull();
  });

  it('register replaces an existing record with the same windowId', () => {
    reg.register(record({ windowId: 1, webContentsId: 10 }));
    reg.register(record({ windowId: 1, webContentsId: 11 }));
    expect(reg.all()).toHaveLength(1);
    expect(reg.get(1)?.webContentsId).toBe(11);
  });

  it('the factory builds an equivalent empty registry', () => {
    const r = createWindowRegistry();
    expect(r.all()).toEqual([]);
    expect(r.focusedOrLast()).toBeNull();
  });
});

// ============================================================================
// B. focusedOrLast
// ============================================================================

describe('focusedOrLast', () => {
  it('returns null when the registry is empty', () => {
    expect(reg.focusedOrLast()).toBeNull();
  });

  it('returns the window with the highest lastFocusedAt', () => {
    reg.register(record({ windowId: 1, webContentsId: 10, lastFocusedAt: 100 }));
    reg.register(record({ windowId: 2, webContentsId: 20, lastFocusedAt: 300 }));
    reg.register(record({ windowId: 3, webContentsId: 30, lastFocusedAt: 200 }));
    expect(reg.focusedOrLast()?.windowId).toBe(2);
  });

  it('tracks focus changes via touchFocus', () => {
    reg.register(record({ windowId: 1, webContentsId: 10, lastFocusedAt: 100 }));
    reg.register(record({ windowId: 2, webContentsId: 20, lastFocusedAt: 200 }));

    expect(reg.focusedOrLast()?.windowId).toBe(2);
    reg.touchFocus(1, 500);
    expect(reg.focusedOrLast()?.windowId).toBe(1);
  });
});

// ============================================================================
// C. unregister releases path
// ============================================================================

describe('unregister', () => {
  it('removes the record and releases its owned path', () => {
    reg.register(record({ windowId: 1, webContentsId: 10 }));
    expect(reg.claimPath(1, '/doc.md')).toBe(true);
    expect(reg.ownerOfPath('/doc.md')?.windowId).toBe(1);

    reg.unregister(1);

    expect(reg.get(1)).toBeNull();
    expect(reg.ownerOfPath('/doc.md')).toBeNull(); // path released
  });

  it('is a no-op for an unknown windowId', () => {
    expect(() => reg.unregister(123)).not.toThrow();
  });
});

// ============================================================================
// D. path ownership: claimPath / ownerOfPath / releasePath
// ============================================================================

describe('path ownership', () => {
  beforeEach(() => {
    reg.register(record({ windowId: 1, webContentsId: 10 }));
    reg.register(record({ windowId: 2, webContentsId: 20 }));
  });

  it('claimPath assigns an unowned path and records the owner', () => {
    expect(reg.claimPath(1, '/a.md')).toBe(true);
    expect(reg.get(1)?.currentPath).toBe('/a.md');
    expect(reg.ownerOfPath('/a.md')?.windowId).toBe(1);
  });

  it('claimPath rejects a path already owned by another window', () => {
    expect(reg.claimPath(1, '/shared.md')).toBe(true);
    expect(reg.claimPath(2, '/shared.md')).toBe(false); // duplicate → rejected
    expect(reg.ownerOfPath('/shared.md')?.windowId).toBe(1); // owner unchanged
  });

  it('claimPath is idempotent for the current owner', () => {
    expect(reg.claimPath(1, '/a.md')).toBe(true);
    expect(reg.claimPath(1, '/a.md')).toBe(true); // same window re-claims → ok
  });

  it('claimPath rejects an unknown window', () => {
    expect(reg.claimPath(999, '/a.md')).toBe(false);
    expect(reg.ownerOfPath('/a.md')).toBeNull();
  });

  it('releasePath frees the path for another window to claim', () => {
    expect(reg.claimPath(1, '/a.md')).toBe(true);
    reg.releasePath(1);
    expect(reg.ownerOfPath('/a.md')).toBeNull();
    expect(reg.claimPath(2, '/a.md')).toBe(true); // now claimable
  });

  it('ownerOfPath returns null for an unowned path', () => {
    expect(reg.ownerOfPath('/nobody.md')).toBeNull();
  });
});
