import { describe, expect, it, vi } from 'vitest';
import { CloseCoordinator, createQuiesceTransaction, runDecideCloseLoop, type CloseAttemptContext, type CloseDecision, type CloseTarget } from '../main/close-coordinator';

const first: CloseTarget = { windowId: 1, windowKey: 'first' };
const second: CloseTarget = { windowId: 2, windowKey: 'second' };

describe('CloseCoordinator', () => {
  it('drops provisional discards when a later window cancels', async () => {
    const coordinator = new CloseCoordinator();
    const commit = vi.fn();
    const decisions: CloseDecision[] = ['discard', 'cancel'];

    await expect(coordinator.request('quit', [first, second], async () => decisions.shift()!, commit)).resolves.toEqual({ approved: false, intent: 'quit' });
    expect(commit).not.toHaveBeenCalled();
  });
  it('does not approve when commit rejects a provisional transaction', async () => {
    const coordinator = new CloseCoordinator();

    await expect(coordinator.request('close', [first], async () => 'discard', async () => false))
      .resolves.toEqual({ approved: false, intent: 'close' });
  });
  it('re-decides only invalidated targets before retrying the all-window commit', async () => {
    const coordinator = new CloseCoordinator();
    const decide = vi.fn(async () => 'allow' as const);
    const commit = vi.fn()
      .mockResolvedValueOnce({ retry: [first] })
      .mockResolvedValueOnce(true);

    await expect(coordinator.request('quit', [first, second], decide, commit))
      .resolves.toEqual({ approved: true, intent: 'quit' });
    expect(decide.mock.calls.map(([target]) => target)).toEqual([first, second, first]);
    expect(commit).toHaveBeenCalledTimes(2);
  });

  it('serializes a close that arrives during quit and commits once for all quit windows', async () => {
    const coordinator = new CloseCoordinator();
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const commit = vi.fn();
    const quit = coordinator.request('quit', [first, second], async (target) => {
      if (target === first) await paused;
      return 'allow';
    }, commit);
    const close = coordinator.request('close', [first], async () => 'cancel', commit);

    release();
    await expect(Promise.all([quit, close])).resolves.toEqual([
      { approved: true, intent: 'quit' },
      { approved: true, intent: 'quit' },
    ]);
    expect(commit).toHaveBeenCalledOnce();
    expect(commit.mock.calls[0][0].targets).toEqual([first, second]);
  });
  it('does not charge normal two-window approval epochs', async () => {
    const coordinator = new CloseCoordinator();
    const contexts: CloseAttemptContext[] = [];

    await expect(coordinator.request('quit', [first, second], async (_target, context) => {
      contexts.push(context);
      return 'allow';
    }, async () => true)).resolves.toEqual({ approved: true, intent: 'quit' });

    expect(contexts).toHaveLength(2);
    expect(contexts[0]).toBe(contexts[1]);
    expect(contexts[0].failuresUsed).toBe(0);
  });

  it('cancels on the eighth failed authorization without starting a ninth epoch', async () => {
    const context: CloseAttemptContext = {
      forwardDeadline: Date.now() + 1_000,
      compensationDeadline: null,
      failuresUsed: 0,
      quiescedTargets: new Set(),
    };
    const queryState = vi.fn(async () => {});
    const resolveGuard = vi.fn(async () => 'allow' as const);
    const authorize = vi.fn(async () => false);

    await expect(runDecideCloseLoop({ queryState, resolveGuard, authorize, context })).resolves.toBe('cancel');
    expect(authorize).toHaveBeenCalledTimes(8);
    expect(context.failuresUsed).toBe(8);
  });
  it('reuses prepared targets across a retry and compensates them once on final cancellation', async () => {
    const coordinator = new CloseCoordinator();
    const active = new Set<number>();
    const prepare = vi.fn(async (target: CloseTarget) => {
      active.add(target.windowId);
      return true;
    });
    const rollback = vi.fn(async (target: CloseTarget) => { active.delete(target.windowId); });
    const quiesce = createQuiesceTransaction({
      prepare,
      rollback,
      commit: async () => {},
      awaitWithinDeadline: async (operation) => operation,
    });
    const decisions: CloseDecision[] = ['allow', 'cancel'];

    await expect(coordinator.request('close', [first], async () => decisions.shift()!, async () => ({ retry: [first] }), quiesce))
      .resolves.toEqual({ approved: false, intent: 'close' });

    expect(prepare).toHaveBeenCalledOnce();
    expect(rollback).toHaveBeenCalledOnce();
    expect(active).toEqual(new Set());
  });

  it('compensates a late prepare acknowledgement after its bounded operation fails', async () => {
    let release!: () => void;
    const late = new Promise<boolean>((resolve) => { release = () => resolve(true); });
    const rollback = vi.fn(async () => {});
    const bounded = async (_operation: Promise<boolean>) => false;
    const tx = createQuiesceTransaction({
      prepare: async () => late,
      rollback,
      commit: async () => {},
      awaitWithinDeadline: bounded,
    });
    const context: CloseAttemptContext = {
      forwardDeadline: Date.now() + 1,
      compensationDeadline: null,
      failuresUsed: 0,
      quiescedTargets: new Set(),
    };

    await expect(tx.prepare([first], context)).resolves.toBe(false);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rollback).toHaveBeenCalledOnce();
  });
  it('does not let a failed best-effort quiesce veto an approved close', async () => {
    const coordinator = new CloseCoordinator();
    const quiesce = createQuiesceTransaction({
      prepare: async () => false,
      rollback: async () => {},
      commit: async () => {},
      awaitWithinDeadline: async (operation) => operation,
    });

    await expect(coordinator.request('close', [first], async () => 'allow', async () => true, quiesce))
      .resolves.toEqual({ approved: true, intent: 'close' });
  });

  it('decides many responsive windows in parallel rather than charging the global deadline per target', async () => {
    const targets = Array.from({ length: 7 }, (_, index) => ({ windowId: index + 1, windowKey: String(index + 1) }));
    const coordinator = new CloseCoordinator();
    const started = Date.now();

    await expect(coordinator.request('quit', targets, async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return 'allow';
    }, async () => true)).resolves.toEqual({ approved: true, intent: 'quit' });

    expect(Date.now() - started).toBeLessThan(100);
  });
});
