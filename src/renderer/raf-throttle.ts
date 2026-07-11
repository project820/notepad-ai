export function createRafThrottle(): (cb: () => void) => void {
  let scheduled = false;
  let latest: (() => void) | null = null;
  return (cb) => {
    latest = cb;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const fn = latest;
      latest = null;
      fn?.();
    });
  };
}
