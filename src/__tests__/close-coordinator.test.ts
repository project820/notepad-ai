import { describe, expect, it, vi } from 'vitest';
import { CloseCoordinator, type CloseDecision, type CloseTarget } from '../main/close-coordinator';

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
});
