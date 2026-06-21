/**
 * chat-layout.redteam.test.ts — adversarial / boundary red-team for G001 AC16.
 *
 * These tests try to BREAK clampChatWidth, not to confirm the happy path. They
 * encode the documented width contract exactly (no force-passing): if any
 * assertion fails, that is evidence of a G001 layout-math defect.
 *
 * Contract under test (src/renderer/chat-layout.ts):
 *   upper = min(window*0.5, MAX_CHAT_WIDTH, window - MIN_EDITOR_WIDTH)
 *   if upper < min  -> min wins, capped by the window itself: min(min, max(0, window))
 *   else            -> clamp requested into [min, upper]
 *   non-finite / non-positive requested -> min
 */
import { describe, expect, it } from 'vitest';

import {
  clampChatWidth,
  MAX_CHAT_FRACTION,
  MAX_CHAT_WIDTH,
  MIN_CHAT_WIDTH,
  MIN_EDITOR_WIDTH,
} from '../chat-layout';

describe('clampChatWidth constants are internally consistent (AC2/AC16)', () => {
  it('orders the width bounds so the contract is satisfiable', () => {
    expect(MIN_CHAT_WIDTH).toBeGreaterThan(0);
    expect(MAX_CHAT_WIDTH).toBeGreaterThan(MIN_CHAT_WIDTH);
    expect(MIN_EDITOR_WIDTH).toBeGreaterThan(0);
    expect(MIN_CHAT_WIDTH).toBeGreaterThan(MIN_EDITOR_WIDTH);
    expect(MAX_CHAT_FRACTION).toBeGreaterThan(0);
    expect(MAX_CHAT_FRACTION).toBeLessThan(1);
  });

  it('locks the transition window where "min wins" stops at exactly 880px', () => {
    expect(MIN_CHAT_WIDTH / MAX_CHAT_FRACTION).toBe(880); // fractionCap === MIN_CHAT_WIDTH
    expect(MAX_CHAT_WIDTH + MIN_EDITOR_WIDTH).toBe(880); // editorReserve === MAX_CHAT_WIDTH
  });
});

describe('clampChatWidth — adversarial window widths', () => {
  it('negative window collapses to 0', () => {
    expect(clampChatWidth(500, -100)).toBe(0);
    expect(clampChatWidth(440, -1)).toBe(0);
    expect(clampChatWidth(-9, -9)).toBe(0);
  });

  it('zero window collapses to 0', () => {
    expect(clampChatWidth(500, 0)).toBe(0);
    expect(clampChatWidth(0, 0)).toBe(0);
    expect(clampChatWidth(NaN, 0)).toBe(0);
  });

  it('sub-min windows pin the panel to the window width', () => {
    expect(clampChatWidth(500, 200)).toBe(200);
    expect(clampChatWidth(500, 400)).toBe(400);
    expect(clampChatWidth(1, 400)).toBe(400);
    expect(clampChatWidth(500, MIN_CHAT_WIDTH)).toBe(MIN_CHAT_WIDTH);
  });

  it('small windows in [440, 880): the tab-integrity minimum wins for ANY request', () => {
    for (const w of [441, 500, 640, 700, 760, 800, 879]) {
      for (const r of [0, 100, 440, 700, 1e9, NaN, Infinity, -5]) {
        expect(clampChatWidth(r, w)).toBe(MIN_CHAT_WIDTH);
      }
    }
  });

  it('window === 880 is the exact boundary: upper === min', () => {
    expect(clampChatWidth(700, 880)).toBe(MIN_CHAT_WIDTH);
    expect(clampChatWidth(300, 880)).toBe(MIN_CHAT_WIDTH);
    expect(clampChatWidth(1000, 880)).toBe(MIN_CHAT_WIDTH);
    expect(clampChatWidth(NaN, 880)).toBe(MIN_CHAT_WIDTH);
    expect(clampChatWidth(0, 880)).toBe(MIN_CHAT_WIDTH);
    expect(clampChatWidth(700, 879)).toBe(MIN_CHAT_WIDTH);
  });

  it('window === 760: upper(380) < 440, min wins and the editor reserve is met exactly (320px)', () => {
    expect(clampChatWidth(400, 760)).toBe(MIN_CHAT_WIDTH);
    expect(clampChatWidth(1000, 760)).toBe(MIN_CHAT_WIDTH);
    expect(clampChatWidth(100, 760)).toBe(MIN_CHAT_WIDTH);
    expect(760 - clampChatWidth(400, 760)).toBe(MIN_EDITOR_WIDTH);
  });

  it('fractional windows produce exact sub-pixel widths (no hidden rounding)', () => {
    expect(clampChatWidth(500, 901)).toBeCloseTo(450.5, 10);
    expect(clampChatWidth(500, 900.7)).toBeCloseTo(450.35, 10);
    expect(clampChatWidth(100, 901)).toBe(MIN_CHAT_WIDTH);
  });

  it('the fraction cap (50%) binds between 880 and 1120 and equals window/2', () => {
    expect(clampChatWidth(1e9, 1000)).toBe(500);
    expect(clampChatWidth(1e9, 1118)).toBe(559);
  });

  it('MAX_CHAT_WIDTH caps wide windows from 1120px up regardless of request', () => {
    expect(clampChatWidth(1e9, 1120)).toBe(MAX_CHAT_WIDTH);
    expect(clampChatWidth(1e9, 1600)).toBe(MAX_CHAT_WIDTH);
    expect(clampChatWidth(100000, 4000)).toBe(MAX_CHAT_WIDTH);
  });
});

describe('clampChatWidth — adversarial requested widths', () => {
  it('non-finite and non-positive requests fall back to the minimum on a normal window', () => {
    expect(clampChatWidth(NaN, 1600)).toBe(MIN_CHAT_WIDTH);
    expect(clampChatWidth(Infinity, 1600)).toBe(MIN_CHAT_WIDTH);
    expect(clampChatWidth(-Infinity, 1600)).toBe(MIN_CHAT_WIDTH);
    expect(clampChatWidth(0, 1600)).toBe(MIN_CHAT_WIDTH);
    expect(clampChatWidth(-50, 1600)).toBe(MIN_CHAT_WIDTH);
  });

  it('a gigantic finite request is capped at the upper bound, not the minimum', () => {
    expect(clampChatWidth(1e9, 1600)).toBe(MAX_CHAT_WIDTH);
    expect(clampChatWidth(Number.MAX_SAFE_INTEGER, 1600)).toBe(MAX_CHAT_WIDTH);
  });

  it('requests on the [min, max] edges clamp exactly', () => {
    expect(clampChatWidth(MIN_CHAT_WIDTH, 1600)).toBe(MIN_CHAT_WIDTH);
    expect(clampChatWidth(MIN_CHAT_WIDTH - 1, 1600)).toBe(MIN_CHAT_WIDTH);
    expect(clampChatWidth(MAX_CHAT_WIDTH, 1600)).toBe(MAX_CHAT_WIDTH);
    expect(clampChatWidth(MAX_CHAT_WIDTH + 1, 1600)).toBe(MAX_CHAT_WIDTH);
    expect(clampChatWidth(500, 1600)).toBe(500);
  });
});

describe('clampChatWidth — custom minPx parameter (public 3rd arg)', () => {
  it('a custom min above the caps overrides MAX (min always wins the floor fight)', () => {
    expect(clampChatWidth(500, 1600, 600)).toBe(600);
    expect(clampChatWidth(500, 580, 600)).toBe(580);
  });

  it('a zero custom min lets a positive request through and a non-positive one fall to 0', () => {
    expect(clampChatWidth(500, 1600, 0)).toBe(500);
    expect(clampChatWidth(0, 1600, 0)).toBe(0);
    expect(clampChatWidth(NaN, 1600, 0)).toBe(0);
  });
});

describe('clampChatWidth — invariants over an adversarial sweep (AC2 tabs + AC16 editor reserve)', () => {
  const windows = [
    -100, -1, 0, 1, 100, 200, 319, 320, 321, 439, 440, 441, 500, 639, 640, 641,
    700, 759, 760, 761, 800, 879, 880, 881, 900.7, 901, 1000, 1000.5, 1119, 1120,
    1121, 1280, 1600, 2000, 4000,
  ];
  const requests = [NaN, Infinity, -Infinity, -1, 0, 1, 100, 439, 440, 441, 559, 560, 561, 1e9];

  it('the result is always finite, >= 0, never wider than the window, never above MAX', () => {
    for (const w of windows) {
      for (const r of requests) {
        const out = clampChatWidth(r, w);
        expect(Number.isFinite(out)).toBe(true);
        expect(out).toBeGreaterThanOrEqual(0);
        expect(out).toBeLessThanOrEqual(Math.max(0, w));
        expect(out).toBeLessThanOrEqual(MAX_CHAT_WIDTH);
      }
    }
  });

  it('tabs never wrap: for any window >= MIN_CHAT_WIDTH the panel is at least MIN_CHAT_WIDTH', () => {
    for (const w of windows.filter((x) => x >= MIN_CHAT_WIDTH)) {
      for (const r of requests) {
        expect(clampChatWidth(r, w)).toBeGreaterThanOrEqual(MIN_CHAT_WIDTH);
      }
    }
  });

  it('editor reserve honored: for any window >= 760 the editor keeps >= MIN_EDITOR_WIDTH', () => {
    for (const w of windows.filter((x) => x >= 760)) {
      for (const r of requests) {
        const editor = w - clampChatWidth(r, w);
        expect(editor).toBeGreaterThanOrEqual(MIN_EDITOR_WIDTH);
      }
    }
  });
});
