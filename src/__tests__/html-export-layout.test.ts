/**
 * html-export-layout.test.ts — engine unit tests with FAKE measurements (G005).
 *
 * The measure→paginate→scale engine is fully testable without a browser: every
 * test injects a deterministic fake `MeasureFn` (and, where ordering matters, a
 * fake `FontsReadyFn`). No DOM, no Electron — pure Node, as the engine intends.
 */

import { describe, it, expect } from 'vitest';
import type { ContentBlock, ContentModel } from '../renderer/html-export-model';
import {
  planSlides,
  planScrollContainment,
  slideDimsFor,
  MIN_BODY_PX,
  MIN_CAPTION_PX,
  MIN_SCALE,
  BASE_BODY_PX,
  DEFAULT_MAX_ITERATIONS,
  type MeasureFn,
  type FontsReadyFn,
  type SlideDims,
} from '../renderer/html-export-layout';

// ---------------------------------------------------------------------------
// Fake measurement: a deterministic vertical-column model.
//   width  = widest block, height = sum of block heights.
// Block footprints are chosen so the scenarios below are exact + predictable.
// ---------------------------------------------------------------------------

function blockWeight(b: ContentBlock): { w: number; h: number } {
  switch (b.kind) {
    case 'table': {
      const rows = b.rows.length;
      const cols = b.headers.length || (b.rows[0]?.length ?? 1);
      return { w: 300 * Math.max(1, cols), h: 80 * Math.max(1, rows) };
    }
    case 'code': {
      const lines = b.code.split('\n').length;
      return { w: 600, h: 40 * Math.max(1, lines) };
    }
    case 'list':
      return { w: 600, h: 60 * Math.max(1, b.items.length) };
    case 'paragraph':
    case 'quote':
    case 'callout':
      return { w: 600, h: 400 };
    case 'heading':
      return { w: 400, h: 60 };
    case 'kicker':
      return { w: 300, h: 30 };
    case 'chart':
      return { w: 300 * Math.max(1, b.chart.labels.length), h: 300 };
    default:
      return { w: 100, h: 100 };
  }
}

const columnMeasure: MeasureFn = (blocks) => {
  let w = 0;
  let h = 0;
  for (const b of blocks) {
    const wt = blockWeight(b);
    w = Math.max(w, wt.w);
    h += wt.h;
  }
  return { contentW: w, contentH: h };
};

/** Always-too-big — nothing ever fits, used for fail-safe scenarios. */
const hugeMeasure: MeasureFn = () => ({ contentW: 100_000, contentH: 100_000 });

const DIMS: SlideDims = slideDimsFor('horizontal'); // 1280×720 → safe 1184×624

function model(...sections: ContentModel['sections']): ContentModel {
  return { title: 'Deck', sections };
}
function section(...blocks: ContentBlock[]) {
  return { blocks };
}
function code(lines: number): ContentBlock {
  return { kind: 'code', code: Array.from({ length: lines }, (_, i) => `line ${i}`).join('\n') };
}
function table(cols: number, rows: number): ContentBlock {
  return {
    kind: 'table',
    headers: Array.from({ length: cols }, (_, i) => `H${i}`),
    rows: Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => `r${r}c${c}`)),
  };
}
function list(items: number): ContentBlock {
  return { kind: 'list', ordered: false, items: Array.from({ length: items }, (_, i) => `item ${i}`) };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('readability floor constants', () => {
  it('MIN_SCALE is derived from the base body size + MIN_BODY_PX', () => {
    expect(MIN_BODY_PX).toBe(14);
    expect(MIN_CAPTION_PX).toBe(11);
    expect(MIN_SCALE).toBeCloseTo(MIN_BODY_PX / BASE_BODY_PX, 10);
    // scaling body by MIN_SCALE must never drop it below the floor.
    expect(BASE_BODY_PX * MIN_SCALE).toBeCloseTo(MIN_BODY_PX, 10);
    expect(DEFAULT_MAX_ITERATIONS).toBe(200);
  });
});

describe('slideDimsFor', () => {
  it('derives horizontal + vertical geometry minus a safe-area pad', () => {
    const h = slideDimsFor('horizontal');
    const v = slideDimsFor('vertical');
    expect([h.width, h.height]).toEqual([1280, 720]);
    expect([v.width, v.height]).toEqual([720, 1280]);
    expect(h.safeW).toBeLessThan(h.width);
    expect(h.safeH).toBeLessThan(h.height);
    expect(v.safeW).toBeLessThan(v.width);
    expect(v.safeH).toBeLessThan(v.height);
  });
});

// ---------------------------------------------------------------------------
// planSlides
// ---------------------------------------------------------------------------

describe('planSlides — fit / scale / split', () => {
  it('keeps a content slide that fits at scale 1 as a single unscaled slide', async () => {
    const m = model(section({ kind: 'paragraph', text: 'hi' }, list(2)));
    const res = await planSlides({ model: m, orientation: 'horizontal', dims: DIMS, measure: columnMeasure });

    expect(res.ok).toBe(true);
    expect(res.slides).toHaveLength(1);
    expect(res.slides[0].scale).toBe(1);
    expect(res.slides[0].blocks).toHaveLength(2);
    expect(res.diagnostics.splits).toBe(0);
    expect(res.diagnostics.overflowSlides).toBe(0);
    expect(res.diagnostics.containmentPass).toBe(true);
    expect(res.diagnostics.minScale).toBe(1);
  });

  it('applies a uniform scale in [MIN_SCALE, 1) — no split — for a slightly-too-big slide', async () => {
    // code(18): height 720 > safeH 624 → scale 624/720 ≈ 0.867, still readable.
    const m = model(section(code(18)));
    const res = await planSlides({ model: m, orientation: 'horizontal', dims: DIMS, measure: columnMeasure });

    expect(res.ok).toBe(true);
    expect(res.slides).toHaveLength(1);
    expect(res.slides[0].scale).toBeGreaterThanOrEqual(MIN_SCALE);
    expect(res.slides[0].scale).toBeLessThan(1);
    expect(res.slides[0].scale).toBeCloseTo(DIMS.safeH / 720, 6);
    expect(res.diagnostics.splits).toBe(0);
    expect(res.diagnostics.overflowSlides).toBe(0);
  });

  it('SPLITS before scaling when a slide would need a sub-MIN_SCALE scale', async () => {
    // Two code(18) blocks: each fits at ~0.867 alone, but together need
    // 624/1440 ≈ 0.43 (< MIN_SCALE) → paginate into 2 readable continuation slides.
    const m = model(section(code(18), code(18)));
    const res = await planSlides({ model: m, orientation: 'horizontal', dims: DIMS, measure: columnMeasure });

    expect(res.ok).toBe(true);
    expect(res.slides.length).toBeGreaterThanOrEqual(2);
    expect(res.slides[0].continued).toBeUndefined();
    expect(res.slides[1].continued).toBe(true);
    for (const s of res.slides) expect(s.scale).toBeGreaterThanOrEqual(MIN_SCALE);
    expect(res.diagnostics.overflowSlides).toBe(0);
    expect(res.diagnostics.minScale).toBeGreaterThanOrEqual(MIN_SCALE);
    expect(res.diagnostics.containmentPass).toBe(true);
  });

  it('row-splits an oversized table into multiple fitting slides (no horizontal overflow)', async () => {
    const m = model(section(table(2, 20))); // height 1600 → must split by rows
    const res = await planSlides({ model: m, orientation: 'horizontal', dims: DIMS, measure: columnMeasure });

    expect(res.ok).toBe(true);
    expect(res.slides.length).toBeGreaterThanOrEqual(2);
    expect(res.diagnostics.splits).toBeGreaterThanOrEqual(1);
    for (const s of res.slides) {
      expect(s.scale).toBeGreaterThanOrEqual(MIN_SCALE);
      // No horizontal overflow remains.
      expect(columnMeasure(s.blocks, DIMS, 1).contentW).toBeLessThanOrEqual(DIMS.safeW);
    }
    expect(res.diagnostics.overflowSlides).toBe(0);
  });

  it('stacks a too-wide single-row table (transpose) then row-splits — no horizontal overflow', async () => {
    const m = model(section(table(12, 1))); // width 3600 ≫ safeW → stacked fallback
    const res = await planSlides({ model: m, orientation: 'horizontal', dims: DIMS, measure: columnMeasure });

    expect(res.ok).toBe(true);
    expect(res.diagnostics.splits).toBeGreaterThanOrEqual(2); // transpose + row-split
    for (const s of res.slides) {
      expect(s.scale).toBeGreaterThanOrEqual(MIN_SCALE);
      expect(columnMeasure(s.blocks, DIMS, 1).contentW).toBeLessThanOrEqual(DIMS.safeW);
    }
    expect(res.diagnostics.overflowSlides).toBe(0);
  });

  it('line-group-splits an oversized code block into fitting slides', async () => {
    const m = model(section(code(40))); // height 1600 → split by lines
    const res = await planSlides({ model: m, orientation: 'horizontal', dims: DIMS, measure: columnMeasure });

    expect(res.ok).toBe(true);
    expect(res.slides.length).toBeGreaterThanOrEqual(2);
    expect(res.diagnostics.splits).toBeGreaterThanOrEqual(1);
    for (const s of res.slides) {
      expect(s.blocks.every((b) => b.kind === 'code')).toBe(true);
      expect(s.scale).toBeGreaterThanOrEqual(MIN_SCALE);
    }
    expect(res.diagnostics.overflowSlides).toBe(0);
  });
});

describe('planSlides — fail-safe', () => {
  it('returns ok:false (no over-scaled slide) when an atomic block cannot fit', async () => {
    // A single-clause paragraph (no sentence boundary) that measures huge:
    // cannot be split and cannot be scaled to readability → fail safe.
    const m = model(section({ kind: 'paragraph', text: 'one indivisible clause with no terminator' }));
    const res = await planSlides({ model: m, orientation: 'horizontal', dims: DIMS, measure: hugeMeasure });

    expect(res.ok).toBe(false);
    expect(res.slides).toHaveLength(0); // never returns an overflowing slide as ok
    expect(res.diagnostics.reason).toBeTruthy();
    expect(res.diagnostics.containmentPass).toBe(false);
    expect(res.diagnostics.overflowSlides).toBeGreaterThan(0);
  });

  it('returns ok:false with a reason when the hard iteration cap is exceeded', async () => {
    const m = model(section(list(50)));
    const res = await planSlides({
      model: m,
      orientation: 'horizontal',
      dims: DIMS,
      measure: hugeMeasure,
      maxIterations: 5,
    });

    expect(res.ok).toBe(false);
    expect(res.slides).toHaveLength(0);
    expect(res.diagnostics.reason).toMatch(/exceeded maxIterations/);
    expect(res.diagnostics.iterations).toBeGreaterThan(5);
    expect(res.diagnostics.containmentPass).toBe(false);
  });
});

describe('planSlides — adapter contract', () => {
  it('awaits fontsReady() BEFORE the first measurement', async () => {
    const events: string[] = [];
    let fontsResolved = false;
    const fontsReady: FontsReadyFn = () =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          fontsResolved = true;
          events.push('fonts');
          resolve();
        }, 0);
      });
    const measure: MeasureFn = (blocks, dims, scale) => {
      events.push('measure');
      // Every measurement must happen strictly after fonts settle.
      expect(fontsResolved).toBe(true);
      return columnMeasure(blocks, dims, scale);
    };

    const m = model(section({ kind: 'paragraph', text: 'p' }));
    const res = await planSlides({ model: m, orientation: 'horizontal', dims: DIMS, measure, fontsReady });

    expect(res.ok).toBe(true);
    expect(events[0]).toBe('fonts');
    expect(events).toContain('measure');
  });

  it('is deterministic: same model + same fake measure → identical plan', async () => {
    const build = () => model(section(table(2, 20)), section(code(18), code(18)));
    const a = await planSlides({ model: build(), orientation: 'horizontal', dims: DIMS, measure: columnMeasure });
    const b = await planSlides({ model: build(), orientation: 'horizontal', dims: DIMS, measure: columnMeasure });

    expect(a.ok).toBe(true);
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// planScrollContainment — horizontal-only containment
// ---------------------------------------------------------------------------

describe('planScrollContainment', () => {
  it('flags horizontal overflow via the injected measure', async () => {
    const m = model(section(table(12, 1))); // width 3600 > safeW
    const res = await planScrollContainment({
      model: m,
      orientation: 'horizontal',
      dims: DIMS,
      measure: columnMeasure,
    });
    expect(res.horizontalOverflow).toBe(true);
    expect(res.contentW).toBeGreaterThan(res.safeW);
  });

  it('allows vertical height to exceed the viewport (vertical scroll is OK)', async () => {
    // Many tall-but-narrow paragraphs: contentH ≫ safeH, contentW within safeW.
    const blocks: ContentBlock[] = Array.from({ length: 20 }, (_, i) => ({
      kind: 'paragraph',
      text: `para ${i}`,
    }));
    const res = await planScrollContainment({
      model: model(section(...blocks)),
      orientation: 'horizontal',
      dims: DIMS,
      measure: columnMeasure,
    });
    expect(res.horizontalOverflow).toBe(false);
    expect(res.contentH).toBeGreaterThan(res.safeH); // tall is allowed, not a failure
  });

  it('awaits fontsReady before measuring the scroll column', async () => {
    let resolved = false;
    const fontsReady: FontsReadyFn = () =>
      new Promise<void>((resolve) => setTimeout(() => { resolved = true; resolve(); }, 0));
    const measure: MeasureFn = (blocks, dims, scale) => {
      expect(resolved).toBe(true);
      return columnMeasure(blocks, dims, scale);
    };
    const res = await planScrollContainment({
      model: model(section({ kind: 'paragraph', text: 'p' })),
      orientation: 'vertical',
      measure,
      fontsReady,
    });
    expect(res.horizontalOverflow).toBe(false);
  });
});
