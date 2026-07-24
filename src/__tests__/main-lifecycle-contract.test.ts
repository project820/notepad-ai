import { describe, expect, it, vi } from 'vitest';
import { createQuitApprovalController } from '../main/lifecycle-flags';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe('quit approval lifecycle controller', () => {
  it('waits for an unresolved close transaction then approves shutdown exactly once', async () => {
    const close = deferred();
    const approveAllForQuit = vi.fn(async () => true);
    const controller = createQuitApprovalController({
      waitForCloseTransaction: () => close.promise,
      approveAllForQuit,
      clearCloseApprovals: vi.fn(),
    });

    const pending = controller.requestQuitApproval();
    const shutdown = controller.beginSystemShutdown();
    await Promise.resolve();
    expect(approveAllForQuit).not.toHaveBeenCalled();

    close.resolve();
    await expect(Promise.all([pending, shutdown])).resolves.toEqual([true, true]);
    expect(approveAllForQuit).toHaveBeenCalledTimes(1);
    expect(approveAllForQuit).toHaveBeenCalledWith('shutdown');
  });
  it('joins duplicate system shutdown requests into one pending approval', async () => {
    const approval = deferred<boolean>();
    const approveAllForQuit = vi.fn(() => approval.promise);
    const controller = createQuitApprovalController({
      waitForCloseTransaction: async () => {},
      approveAllForQuit,
      clearCloseApprovals: vi.fn(),
    });

    const first = controller.beginSystemShutdown();
    const second = controller.beginSystemShutdown();
    await vi.waitFor(() => expect(approveAllForQuit).toHaveBeenCalledWith('shutdown'));
    approval.resolve(true);

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(approveAllForQuit).toHaveBeenCalledOnce();
  });

  it('reruns after a shutdown latch makes a non-shutdown approval stale', async () => {
    const approval = deferred<boolean>();
    const approveAllForQuit = vi.fn(() => approval.promise);
    const controller = createQuitApprovalController({
      waitForCloseTransaction: async () => {},
      approveAllForQuit,
      clearCloseApprovals: vi.fn(),
    });

    const quit = controller.requestQuitApproval();
    await vi.waitFor(() => expect(approveAllForQuit).toHaveBeenCalledWith('quit'));
    const shutdown = controller.beginSystemShutdown();
    approval.resolve(true);

    await vi.waitFor(() => expect(approveAllForQuit).toHaveBeenCalledWith('shutdown'));
    await expect(Promise.all([quit, shutdown])).resolves.toEqual([true, true]);
    expect(approveAllForQuit).toHaveBeenCalledTimes(2);
  });
  it('falls back to an approved quit when its shutdown rerun is denied without retaining it', async () => {
    const approval = deferred<boolean>();
    const clearCloseApprovals = vi.fn();
    let calls = 0;
    const approveAllForQuit = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? approval.promise : false;
    });
    const controller = createQuitApprovalController({
      waitForCloseTransaction: async () => {},
      approveAllForQuit,
      clearCloseApprovals,
    });

    const quit = controller.requestQuitApproval();
    await vi.waitFor(() => expect(approveAllForQuit).toHaveBeenCalledWith('quit'));
    const shutdown = controller.beginSystemShutdown();
    approval.resolve(true);

    await vi.waitFor(() => expect(approveAllForQuit).toHaveBeenCalledWith('shutdown'));
    await expect(Promise.all([quit, shutdown])).resolves.toEqual([true, true]);
    await expect(controller.requestQuitApproval()).resolves.toBe(false);

    expect(approveAllForQuit.mock.calls.map(([reason]) => reason)).toEqual(['quit', 'shutdown', 'quit']);
    expect(clearCloseApprovals).not.toHaveBeenCalled();
  });

  it('clears approvals and denies when an approval fails', async () => {
    const clearCloseApprovals = vi.fn();
    const controller = createQuitApprovalController({
      waitForCloseTransaction: async () => {},
      approveAllForQuit: async () => { throw new Error('timed out'); },
      clearCloseApprovals,
    });

    await expect(controller.requestQuitApproval()).resolves.toBe(false);
    expect(clearCloseApprovals).toHaveBeenCalledOnce();
  });
  it('clears the shutdown latch after a denied shutdown approval', async () => {
    const approveAllForQuit = vi.fn(async (reason: string) => reason !== 'shutdown');
    const controller = createQuitApprovalController({
      waitForCloseTransaction: async () => {},
      approveAllForQuit,
      clearCloseApprovals: vi.fn(),
    });

    await expect(controller.beginSystemShutdown()).resolves.toBe(false);
    await expect(controller.requestQuitApproval()).resolves.toBe(true);

    expect(approveAllForQuit.mock.calls.map(([reason]) => reason)).toEqual(['shutdown', 'quit']);
  });
  it('clears the shutdown latch when a latched shutdown approval throws', async () => {
    let calls = 0;
    const approveAllForQuit = vi.fn(async (reason: string) => {
      calls += 1;
      if (calls === 1) throw new Error('timed out');
      return reason === 'quit';
    });
    const controller = createQuitApprovalController({
      waitForCloseTransaction: async () => {},
      approveAllForQuit,
      clearCloseApprovals: vi.fn(),
    });

    await expect(controller.beginSystemShutdown()).resolves.toBe(false);
    await expect(controller.requestQuitApproval()).resolves.toBe(true);

    expect(approveAllForQuit.mock.calls.map(([reason]) => reason)).toEqual(['shutdown', 'quit']);
  });
});
