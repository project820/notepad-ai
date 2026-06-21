import { describe, expect, it } from 'vitest';

import {
  clampChatWidth,
  MAX_CHAT_WIDTH,
  MIN_CHAT_WIDTH,
  MIN_EDITOR_WIDTH,
} from '../chat-layout';

describe('clampChatWidth (AC16: min wins for tab integrity, bounded by max + editor reserve)', () => {
  it('returns the requested width within [min, max] on a large window', () => {
    // 1600px window: fractionCap 800, editorReserve 1280, MAX 560 -> upper 560
    expect(clampChatWidth(500, 1600)).toBe(500); // 500 within [440, 560]
  });

  it('never exceeds MAX_CHAT_WIDTH on a large window', () => {
    expect(clampChatWidth(1200, 1600)).toBe(MAX_CHAT_WIDTH); // capped at 560
  });

  it('enforces the minimum width', () => {
    expect(clampChatWidth(100, 1600)).toBe(MIN_CHAT_WIDTH);
  });

  it('preserves the editor reserve when geometry allows', () => {
    // 880px window: editorReserve = 880-320 = 560, fractionCap 440, MAX 560 -> upper 440
    expect(clampChatWidth(700, 880)).toBe(440);
  });

  it('small window: the minimum wins so tabs never wrap (editor narrows)', () => {
    // 700px window: fractionCap 350, editorReserve 380, MAX 560 -> upper 350 < 440 -> min wins
    expect(clampChatWidth(400, 700)).toBe(MIN_CHAT_WIDTH); // 440, editor gets ~260
  });

  it('min never exceeds the window width itself on a tiny window', () => {
    expect(clampChatWidth(400, 400)).toBe(400);
  });

  it('handles non-finite / non-positive requests by falling back to the minimum', () => {
    expect(clampChatWidth(NaN, 1600)).toBe(MIN_CHAT_WIDTH);
    expect(clampChatWidth(0, 1600)).toBe(MIN_CHAT_WIDTH);
  });

  it('exposes the editor-reserve constant for callers', () => {
    expect(MIN_EDITOR_WIDTH).toBeGreaterThan(0);
  });
});
