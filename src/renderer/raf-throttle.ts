export type RafThrottle = {
  schedule: (cb: () => void) => void;
  cancel: () => void;
};

export function createRafThrottle(): RafThrottle {
  let frame: number | null = null;
  let latest: (() => void) | null = null;

  function cancel(): void {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    latest = null;
  }

  function schedule(cb: () => void): void {
    latest = cb;
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      const fn = latest;
      latest = null;
      fn?.();
    });
  }

  return { schedule, cancel };
}
