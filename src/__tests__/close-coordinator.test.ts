import { describe, expect, it, vi } from 'vitest';
import { CloseCoordinator, runDecideCloseLoop, type CloseAttemptContext, type CloseDecision, type CloseTarget } from '../main/close-coordinator';

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
});
