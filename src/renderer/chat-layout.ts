/**
 * chat-layout.ts — pure layout math for the unified chat side panel.
 *
 * The panel uses a CSS Grid push layout (it reflows the editor rather than
 * overlaying it). This module holds the resize-clamp logic.
 *
 * Width contract (AC16): the 4-tab strip must never wrap or crush, so the chat
 * panel has a hard MIN width large enough to hold the tabs on one line. The
 * minimum WINS over the old 50%/editor-reserve caps on small windows (the
 * editor narrows instead — a documented tradeoff below ~800px). On normal and
 * large windows the panel is additionally bounded by MAX_CHAT_WIDTH and an
 * editor-reserve cap so the editor never disappears and the chat never grows
 * unbounded.
 */

/** Hard minimum so the four tabs (작성/상담/프로젝트 설정/HTML 생성) stay on one line. */
export const MIN_CHAT_WIDTH = 440;
/** Upper bound so the chat never grows unreasonably wide on large windows. */
export const MAX_CHAT_WIDTH = 560;
/** Editor width we try to preserve when geometry allows (reserve cap). */
export const MIN_EDITOR_WIDTH = 320;
/** Legacy 50%-of-window cap, still applied on normal windows. */
export const MAX_CHAT_FRACTION = 0.5;

/**
 * Clamp a requested chat-panel width (px) for a given window width.
 *
 * - Upper bound = min(50% of window, MAX_CHAT_WIDTH, window - MIN_EDITOR_WIDTH).
 * - If that upper bound is below the minimum (small window), the minimum wins so
 *   the tabs never wrap — capped only by the window width itself. The editor is
 *   sacrificed in this case (documented tradeoff for windows below ~800px).
 * - Otherwise the requested width is clamped to [MIN_CHAT_WIDTH, upper bound].
 * - Non-finite / non-positive requests fall back to the minimum.
 */
export function clampChatWidth(
  requestedPx: number,
  windowWidthPx: number,
  minPx: number = MIN_CHAT_WIDTH,
): number {
  const fractionCap = Math.max(0, windowWidthPx * MAX_CHAT_FRACTION);
  const editorReserveCap = Math.max(0, windowWidthPx - MIN_EDITOR_WIDTH);
  const upper = Math.min(fractionCap, MAX_CHAT_WIDTH, editorReserveCap);

  // Small window: the tab-integrity minimum wins, bounded only by the window.
  if (upper < minPx) return Math.min(minPx, Math.max(0, windowWidthPx));

  if (!Number.isFinite(requestedPx) || requestedPx <= 0) return minPx;
  return Math.min(upper, Math.max(minPx, requestedPx));
}
