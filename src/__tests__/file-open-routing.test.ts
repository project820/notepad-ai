/**
 * file-open-routing.test.ts
 *
 * Integration test for the file-tree "open in current window" routing (G004),
 * focused on the duplicate-path ownership guard: when another live window
 * already owns the target path, `openFileInCurrentWindow` MUST focus that owner
 * and MUST NOT open a second writer (it never calls `openFilePath`). This keeps
 * the file tree from bypassing the same guard that protects `file:save`.
 *
 * The decision is exercised against a real `WindowRegistry` (ownership truth)
 * with spies standing in for the window-side effects (focus / openFilePath).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createWindowRegistry,
  type WindowRecord,
} from '../main/window-registry';
import {
  openFileInCurrentWindow,
  type OpenInCurrentEffects,
} from '../main/file-tree';

function record(
  over: Partial<WindowRecord> & Pick<WindowRecord, 'windowId' | 'webContentsId'>,
): WindowRecord {
  return {
    lastFocusedAt: 0,
    windowKey: `key-${over.windowId}`,
    ready: true,
    pendingOutbound: [],
    ...over,
  };
}

/** Build effects backed by a registry, with spies for focus + open. */
function effectsFor(reg: ReturnType<typeof createWindowRegistry>) {
  const focusOwner = vi.fn<(ownerWindowId: number) => void>();
  const openInRequester = vi.fn<(absPath: string) => Promise<void>>(async () => {});
  const effects: OpenInCurrentEffects = {
    ownerOfPath: (p) => reg.ownerOfPath(p),
    focusOwner,
    openInRequester,
  };
  return { effects, focusOwner, openInRequester };
}

describe('openFileInCurrentWindow — duplicate-path ownership guard', () => {
  it('focuses the owner and does NOT open when another window owns the target', async () => {
    const reg = createWindowRegistry();
    reg.register(record({ windowId: 1, webContentsId: 10 })); // owner
    reg.register(record({ windowId: 2, webContentsId: 20 })); // requester
    expect(reg.claimPath(1, '/ws/shared.md')).toBe(true);

    const { effects, focusOwner, openInRequester } = effectsFor(reg);
    const result = await openFileInCurrentWindow(2, '/ws/shared.md', effects);

    // Owner focused, current window untouched: openFilePath was never invoked.
    expect(openInRequester).not.toHaveBeenCalled();
    expect(focusOwner).toHaveBeenCalledTimes(1);
    expect(focusOwner).toHaveBeenCalledWith(1);
    expect(result).toEqual({ opened: false, focusedOwner: true, ownerWindowId: 1 });
    // Ownership is unchanged — the owner still holds the path.
    expect(reg.ownerOfPath('/ws/shared.md')?.windowId).toBe(1);
  });

  it('opens in the requesting window when the path is unowned', async () => {
    const reg = createWindowRegistry();
    reg.register(record({ windowId: 2, webContentsId: 20 }));

    const { effects, focusOwner, openInRequester } = effectsFor(reg);
    const result = await openFileInCurrentWindow(2, '/ws/new.md', effects);

    expect(focusOwner).not.toHaveBeenCalled();
    expect(openInRequester).toHaveBeenCalledTimes(1);
    expect(openInRequester).toHaveBeenCalledWith('/ws/new.md');
    expect(result).toEqual({ opened: true });
  });

  it('opens (re-opens) when the requesting window already owns the path', async () => {
    const reg = createWindowRegistry();
    reg.register(record({ windowId: 2, webContentsId: 20 }));
    expect(reg.claimPath(2, '/ws/mine.md')).toBe(true);

    const { effects, focusOwner, openInRequester } = effectsFor(reg);
    const result = await openFileInCurrentWindow(2, '/ws/mine.md', effects);

    expect(focusOwner).not.toHaveBeenCalled();
    expect(openInRequester).toHaveBeenCalledWith('/ws/mine.md');
    expect(result).toEqual({ opened: true });
  });

  it('rejects a non-absolute / unsafe target without opening or focusing', async () => {
    const reg = createWindowRegistry();
    reg.register(record({ windowId: 2, webContentsId: 20 }));

    const { effects, focusOwner, openInRequester } = effectsFor(reg);
    const result = await openFileInCurrentWindow(2, 'relative/path.md', effects);

    expect(openInRequester).not.toHaveBeenCalled();
    expect(focusOwner).not.toHaveBeenCalled();
    expect(result).toEqual({ opened: false, error: 'invalid-path' });
  });
});
