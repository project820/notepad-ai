import { describe, expect, it, vi } from 'vitest';
import {
  guardCloseEvent,
  needsCloseConfirmation,
  resolveCloseGuard,
  stateFromSnapshot,
  shouldPreventBeforeQuit,
} from '../main/close-guard';

const dirtyNamed = { dirty: true, hasPath: true, docEmpty: false, locale: 'en' as const };

describe('close guard decisions', () => {
  it('only prompts for a dirty document that is not an empty untitled buffer', () => {
    expect(needsCloseConfirmation({ dirty: false, hasPath: true, docEmpty: false, locale: 'en' })).toBe(false);
    expect(needsCloseConfirmation({ dirty: true, hasPath: false, docEmpty: true, locale: 'en' })).toBe(false);
    expect(needsCloseConfirmation(dirtyNamed)).toBe(true);
  });

  it('uses the last edit-event snapshot when the live renderer does not answer', () => {
    expect(stateFromSnapshot({ dirty: true, path: null, doc: 'draft' })).toMatchObject({ dirty: true, hasPath: false, docEmpty: false });
    expect(stateFromSnapshot(undefined)).toMatchObject({ dirty: false, hasPath: false, docEmpty: true });
  });
  it('holds quit while a close decision is unresolved and only allows the approved retry', () => {
    expect(shouldPreventBeforeQuit({ quitApproved: false, relaunchApproved: false })).toBe(true);
    expect(shouldPreventBeforeQuit({ quitApproved: true, relaunchApproved: false })).toBe(false);
    expect(shouldPreventBeforeQuit({ quitApproved: false, relaunchApproved: true })).toBe(false);
  });

  it('allows save only after the renderer real save flow succeeds', async () => {
    const save = vi.fn().mockResolvedValue(true);
    await expect(resolveCloseGuard({ state: dirtyNamed, showDialog: async () => 'save', save })).resolves.toBe('allow');
    expect(save).toHaveBeenCalledOnce();
    await expect(resolveCloseGuard({ state: dirtyNamed, showDialog: async () => 'save', save: async () => false })).resolves.toBe('cancel');
  });

  it('distinguishes explicit discard from cancellation', async () => {
    await expect(resolveCloseGuard({ state: dirtyNamed, showDialog: async () => 'discard', save: async () => true })).resolves.toBe('discard');
    await expect(resolveCloseGuard({ state: dirtyNamed, showDialog: async () => 'cancel', save: async () => true })).resolves.toBe('cancel');
  });
});

describe('close teardown race', () => {
  it('prevents close synchronously while a native dialog remains pending', async () => {
    let resolveDialog!: (approved: boolean) => void;
    const dialog = new Promise<boolean>((resolve) => { resolveDialog = resolve; });
    const event = { preventDefault: vi.fn() };
    const retry = vi.fn();

    guardCloseEvent(event, () => dialog, retry, vi.fn());

    // This assertion is made before the dialog resolves: a real BrowserWindow
    // remains alive because Electron saw preventDefault in the close event turn.
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    resolveDialog(true);
    await Promise.resolve();
    expect(retry).toHaveBeenCalledOnce();
  });
});
