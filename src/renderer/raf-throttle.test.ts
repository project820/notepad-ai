import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRafThrottle } from './raf-throttle';

describe('createRafThrottle', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('cancels the pending latest callback', () => {
    let callback: FrameRequestCallback | undefined;
    const cancel = vi.fn();
    vi.stubGlobal('requestAnimationFrame', (next: FrameRequestCallback) => { callback = next; return 11; });
    vi.stubGlobal('cancelAnimationFrame', cancel);
    const throttle = createRafThrottle();
    const work = vi.fn();
    throttle.schedule(work);
    throttle.cancel();
    callback?.(0);
    expect(cancel).toHaveBeenCalledWith(11);
    expect(work).not.toHaveBeenCalled();
  });
});
