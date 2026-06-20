/**
 * Source ↔ preview scroll synchronisation math (pure, DOM-free).
 *
 * The split view keeps the editor and the rendered preview scrolled together.
 * A naive `preview.scrollTop = editor.scrollTop` (or a single global ratio of
 * total heights) drifts badly: the two panes have different per-block heights
 * (a paragraph that wraps to three lines in the raw editor may be two in the
 * preview, a fenced code block is tall in the editor but compact in the
 * preview, images have no source height at all), and the drift changes with the
 * window width — which is exactly the "it breaks at some window sizes" symptom.
 *
 * The robust approach (the one VS Code's markdown preview and Joplin use) is
 * **piecewise-linear interpolation between known anchor points**. Each mapped
 * block contributes one anchor: its content-space top in the editor (`ed`) and
 * its content-space top in the preview (`pv`). Given a scroll position in one
 * pane we find the two anchors that bracket it and linearly interpolate the
 * other pane's position between the matching anchors. Because anchors are real
 * measured positions, the mapping is exact at every block boundary and only
 * interpolates *within* a block — and it is independent of window size.
 */

/** One mapped block's content-space top in each pane (scroll-invariant). */
export type ScrollAnchor = { ed: number; pv: number };

/**
 * Sort anchors by editor position and keep only the strictly-monotonic subset
 * (each kept anchor must advance on BOTH axes). Equal/regressing tops — which
 * would make the bracketing search ambiguous or divide-by-zero — are dropped.
 */
export function normalizeAnchors(raw: readonly ScrollAnchor[]): ScrollAnchor[] {
  const sorted = [...raw]
    .filter((a) => Number.isFinite(a.ed) && Number.isFinite(a.pv))
    .sort((a, b) => a.ed - b.ed);
  const out: ScrollAnchor[] = [];
  for (const a of sorted) {
    const prev = out[out.length - 1];
    if (!prev) {
      out.push(a);
      continue;
    }
    if (a.ed > prev.ed && a.pv > prev.pv) out.push(a);
  }
  return out;
}

/**
 * Map a scroll position in the source pane to the matching position in the
 * destination pane via piecewise-linear interpolation over `anchors`.
 *
 * @param anchors  monotonic anchors (run {@link normalizeAnchors} first).
 * @param value    current `scrollTop` of the source pane.
 * @param axis     which pane is the source (`'ed'` editor, `'pv'` preview).
 * @param srcMax   source pane max scrollTop (`scrollHeight - clientHeight`).
 * @param dstMax   destination pane max scrollTop.
 * @returns        the destination `scrollTop` (NOT yet clamped to dstMax — the
 *                 caller clamps against the live element to absorb sub-pixel
 *                 rounding).
 */
export function interpolateScroll(
  anchors: readonly ScrollAnchor[],
  value: number,
  axis: 'ed' | 'pv',
  srcMax: number,
  dstMax: number,
): number {
  const src = axis;
  const dst: 'ed' | 'pv' = axis === 'ed' ? 'pv' : 'ed';

  // No map yet → fall back to a whole-pane proportional ratio.
  if (anchors.length === 0) {
    return srcMax > 0 ? (value / srcMax) * dstMax : 0;
  }

  const first = anchors[0];
  // Above the first anchor: scale linearly from the top (0,0) to that anchor.
  if (value <= first[src]) {
    return first[src] > 0 ? (value / first[src]) * first[dst] : first[dst];
  }

  // Inside the anchored region: find the bracketing pair and interpolate.
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i];
    const b = anchors[i + 1];
    if (value >= a[src] && value <= b[src]) {
      const span = b[src] - a[src];
      if (span <= 0) return a[dst];
      const f = (value - a[src]) / span;
      return a[dst] + f * (b[dst] - a[dst]);
    }
  }

  // Below the last anchor: extrapolate across each pane's remaining scroll.
  const last = anchors[anchors.length - 1];
  const srcRem = srcMax - last[src];
  const dstRem = dstMax - last[dst];
  if (srcRem <= 0) return last[dst];
  const f = Math.min(1, (value - last[src]) / srcRem);
  return last[dst] + f * dstRem;
}
