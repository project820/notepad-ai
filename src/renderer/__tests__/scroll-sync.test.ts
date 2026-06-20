import { describe, it, expect } from 'vitest';
import { interpolateScroll, normalizeAnchors, type ScrollAnchor } from '../scroll-sync';

describe('normalizeAnchors', () => {
  it('sorts by editor position and keeps strictly-monotonic anchors', () => {
    const raw: ScrollAnchor[] = [
      { ed: 100, pv: 80 },
      { ed: 0, pv: 0 },
      { ed: 50, pv: 40 },
    ];
    expect(normalizeAnchors(raw)).toEqual([
      { ed: 0, pv: 0 },
      { ed: 50, pv: 40 },
      { ed: 100, pv: 80 },
    ]);
  });

  it('drops anchors that do not advance on both axes (ambiguous brackets)', () => {
    const raw: ScrollAnchor[] = [
      { ed: 0, pv: 0 },
      { ed: 10, pv: 0 }, // pv regresses/equal → dropped
      { ed: 20, pv: 5 }, // pv advances vs first kept (0) → kept
    ];
    expect(normalizeAnchors(raw)).toEqual([
      { ed: 0, pv: 0 },
      { ed: 20, pv: 5 },
    ]);
  });

  it('filters non-finite anchors', () => {
    const raw: ScrollAnchor[] = [
      { ed: 0, pv: 0 },
      { ed: NaN, pv: 10 },
      { ed: 30, pv: 20 },
    ];
    expect(normalizeAnchors(raw)).toEqual([
      { ed: 0, pv: 0 },
      { ed: 30, pv: 20 },
    ]);
  });
});

describe('interpolateScroll', () => {
  const anchors: ScrollAnchor[] = [
    { ed: 0, pv: 0 },
    { ed: 100, pv: 200 }, // editor block at 100 maps to preview block at 200
    { ed: 300, pv: 250 }, // tall editor block (code) → compact in preview
  ];

  it('falls back to a whole-pane proportional ratio with no anchors', () => {
    expect(interpolateScroll([], 50, 'ed', 100, 400)).toBe(200);
    expect(interpolateScroll([], 0, 'ed', 0, 400)).toBe(0); // guard divide-by-zero
  });

  it('is exact at every anchor (editor → preview)', () => {
    expect(interpolateScroll(anchors, 0, 'ed', 300, 250)).toBe(0);
    expect(interpolateScroll(anchors, 100, 'ed', 300, 250)).toBe(200);
    expect(interpolateScroll(anchors, 300, 'ed', 300, 250)).toBe(250);
  });

  it('interpolates linearly within a block (editor → preview)', () => {
    // halfway between ed 0..100 → halfway between pv 0..200
    expect(interpolateScroll(anchors, 50, 'ed', 300, 250)).toBe(100);
    // halfway between ed 100..300 → halfway between pv 200..250
    expect(interpolateScroll(anchors, 200, 'ed', 300, 250)).toBe(225);
  });

  it('is exact at every anchor (preview → editor, reverse direction)', () => {
    expect(interpolateScroll(anchors, 200, 'pv', 250, 300)).toBe(100);
    expect(interpolateScroll(anchors, 250, 'pv', 250, 300)).toBe(300);
  });

  it('extrapolates across the remaining scroll range beyond the last anchor', () => {
    // last anchor ed=300 (max 400) → pv=250 (max 300). At ed=350 (halfway through
    // the 100px tail) → pv 250 + 0.5*(300-250) = 275.
    expect(interpolateScroll(anchors, 350, 'ed', 400, 300)).toBe(275);
    // at the very bottom, both panes reach their max together.
    expect(interpolateScroll(anchors, 400, 'ed', 400, 300)).toBe(300);
  });

  it('clamps the tail fraction so overscroll never exceeds the last mapping span', () => {
    // value beyond srcMax → fraction capped at 1 → dstMax.
    expect(interpolateScroll(anchors, 999, 'ed', 400, 300)).toBe(300);
  });

  it('returns the last anchor position when there is no remaining source scroll', () => {
    expect(interpolateScroll(anchors, 300, 'ed', 300, 250)).toBe(250);
  });
});
