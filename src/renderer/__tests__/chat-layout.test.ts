import { describe, expect, it } from 'vitest';

import { clampChatWidth, MIN_CHAT_WIDTH } from '../chat-layout';

describe('clampChatWidth (AC8: resizable, capped at 50% window)', () => {
  it('returns the requested width within bounds', () => {
    expect(clampChatWidth(500, 1600)).toBe(500); // 500 within [320, 800]
  });
  it('never exceeds 50% of the window width', () => {
    expect(clampChatWidth(1200, 1600)).toBe(800); // capped at 50%
  });
  it('enforces the minimum width', () => {
    expect(clampChatWidth(100, 1600)).toBe(MIN_CHAT_WIDTH);
  });
  it('when the window is too narrow for the minimum, the 50% cap wins', () => {
    expect(clampChatWidth(400, 500)).toBe(250); // 50% of 500, below min — cap wins
  });
  it('handles non-finite / non-positive requests by falling back to min (clamped to cap)', () => {
    expect(clampChatWidth(NaN, 1600)).toBe(MIN_CHAT_WIDTH);
    expect(clampChatWidth(0, 1600)).toBe(MIN_CHAT_WIDTH);
    expect(clampChatWidth(-50, 500)).toBe(250); // min(320, 250) = 250
  });
  it('exactly 50% is allowed', () => {
    expect(clampChatWidth(800, 1600)).toBe(800);
  });
});
