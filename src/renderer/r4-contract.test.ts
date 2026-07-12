import { describe, expect, it } from 'vitest';

import { initDocLifecycle } from './doc-lifecycle';
import { initPaneSync } from './pane-sync';

describe('R4 coordinator exports', () => {
  it('keeps the lifecycle and pane coordinator loadable with cancelable rAF dependencies', () => {
    expect(typeof initDocLifecycle).toBe('function');
    expect(typeof initPaneSync).toBe('function');
  });
});
