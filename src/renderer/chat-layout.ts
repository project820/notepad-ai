/**
 * chat-layout.ts — pure layout math for the unified chat side panel (G003).
 *
 * The panel uses a CSS Grid push layout (it reflows the editor rather than
 * overlaying it). This module holds the resize-clamp logic so the "freely
 * resizable but never wider than 50% of the window" rule (AC8) is unit tested.
 */

export const MIN_CHAT_WIDTH = 320;
export const MAX_CHAT_FRACTION = 0.5;

/**
 * Clamp a requested chat-panel width (px) to [min, 50% of window].
 * If the window is too narrow for `min`, the 50% cap wins (never exceed half).
 */
export function clampChatWidth(
  requestedPx: number,
  windowWidthPx: number,
  minPx: number = MIN_CHAT_WIDTH,
): number {
  const max = Math.max(0, windowWidthPx * MAX_CHAT_FRACTION);
  if (!Number.isFinite(requestedPx) || requestedPx <= 0) return Math.min(minPx, max);
  return Math.min(max, Math.max(minPx, requestedPx));
}
