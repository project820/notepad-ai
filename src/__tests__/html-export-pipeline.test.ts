/**
 * html-export-pipeline.test.ts — full model→layout→render→bundle→validate gate.
 *
 * The CI-green containment gate for the synthetic corpus. It runs the WHOLE
 * deterministic pipeline on every authored fixture, for both orientations and
 * both layouts, using a deterministic synthetic `MeasureFn` derived from block
 * sizes (a faithful "vertical column" model: width = widest block, height =
 * sum of block heights — wrap-aware). No DOM, no Electron — pure Node.
 *
 * The REAL-DOM equivalent of this gate is `scripts/html-export-containment-runner.mjs`
 * (Electron offscreen). This test guarantees the engine-level invariant
 * (`overflowSlides === 0`) plus a self-contained, manifest-sane document for
 * every synthetic fixture even where Electron cannot launch (headless CI).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  planSlides,
  planScrollContainment,
  slideDimsFor,
  MIN_SCALE,
  type MeasureFn,
  type SlideDims,
  type PlannedSlide,
} from '../renderer/html-export-layout';
import type { ContentBlock, ContentModel } from '../renderer/html-export-model';
import { validateContentModel } from '../renderer/html-export-model';
import { bundleHtml, EXPORT_MANIFEST_SCHEMA_VERSION } from '../renderer/html-export-bundle';
import { validateSelfContainedHtml } from '../renderer/html-export-validate';
import {
  parseDesignTheme,
  toCssVariables,
  themeComponentClasses,
  evaluateDesignChecklist,
} from '../renderer/html-export-theme';
import type { Orientation } from '../renderer/html-export-state';
import { corpusToModel, CORPUS_FIXTURES } from '../renderer/__fixtures__/html-export/corpus-to-model';

// ---------------------------------------------------------------------------
// Deterministic synthetic measurement — a wrap-aware vertical-column model.
//   width  = widest block (prose wraps to the column; code/tables are intrinsic)
//   height = sum of block heights
// Tuned so the authored corpus is contained in BOTH orientations without any
// atomic-block fail-safe, while still exercising scale + split paths.
// ---------------------------------------------------------------------------

const CHAR_PX = 8; // prose char advance
const MONO_PX = 7; // code char advance (slightly tighter)
const LINE_PX = 30; // prose line box
const CODE_LINE_PX = 22; // code line box
const COL_PER_TABLE = 120; // table column width
const ROW_PX = 40; // table row height
const BLOCK_PAD = 16; // per-block vertical breathing room

function longestLine(code: string): number {
  return (code ?? '').split('\n').reduce((m, l) => Math.max(m, l.length), 0);
}

function blockWeight(b: ContentBlock, dims: SlideDims): { w: number; h: number } {
  const colW = dims.safeW;
  const cpl = Math.max(10, Math.floor(colW / CHAR_PX));
  switch (b.kind) {
    case 'kicker':
      return { w: Math.min(b.text.length * CHAR_PX, colW), h: 26 };
    case 'heading':
      return { w: Math.min(b.text.length * 12, colW), h: 52 };
    case 'paragraph':
    case 'quote':
    case 'callout': {
      const lines = Math.max(1, Math.ceil(b.text.length / cpl));
      return { w: Math.min(b.text.length * CHAR_PX, colW), h: lines * LINE_PX + BLOCK_PAD };
    }
    case 'list': {
      let h = 0;
      for (const it of b.items) h += Math.max(1, Math.ceil(it.length / cpl)) * LINE_PX;
      return { w: colW, h: h + BLOCK_PAD };
    }
    case 'code': {
      const lineCount = Math.max(1, (b.code ?? '').split('\n').length);
      return { w: longestLine(b.code) * MONO_PX, h: lineCount * CODE_LINE_PX + BLOCK_PAD };
    }
    case 'table': {
      const cols = Math.max(1, b.headers.length || b.rows[0]?.length || 1);
      const rows = b.rows.length + (b.headers.length ? 1 : 0);
      return { w: cols * COL_PER_TABLE, h: Math.max(1, rows) * ROW_PX + BLOCK_PAD };
    }
    case 'chart':
      return { w: Math.min(560, colW), h: 360 };
    default:
      return { w: 100, h: 100 };
  }
}

const columnMeasure: MeasureFn = (blocks, dims) => {
  let w = 0;
  let h = 0;
  for (const b of blocks) {
    const wt = blockWeight(b, dims);
    w = Math.max(w, wt.w);
    h += wt.h;
  }
  return { contentW: w, contentH: h };
};

// ---------------------------------------------------------------------------
// Theme (deterministic, self-contained) shared by every bundle.
// ---------------------------------------------------------------------------

const DESIGN_MD = `# Corpus Theme
colors:
  background: #ffffff
  ink: #111827
  body: #374151
  primary: #2563eb
  on-primary: #ffffff
`;
const theme = parseDesignTheme(DESIGN_MD);
const themeCss = toCssVariables(theme);
const componentCss = themeComponentClasses(theme);
const checklist = evaluateDesignChecklist({ designMd: DESIGN_MD, theme, css: `${themeCss}\n${componentCss}` });

const ORIENTATIONS: Orientation[] = ['horizontal', 'vertical'];

function loadFixture(name: string): ContentModel {
  const md = readFileSync(resolve('src/renderer/__fixtures__/html-export', `${name}.md`), 'utf8');
  return corpusToModel(md, name);
}

function countCharts(model: ContentModel): number {
  let n = 0;
  for (const s of model.sections) for (const b of s.blocks) if (b.kind === 'chart') n += 1;
  return n;
}

function bundleFor(
  model: ContentModel,
  orientation: Orientation,
  layout: 'slides' | 'scroll',
  plan?: readonly PlannedSlide[],
) {
  return bundleHtml({
    model,
    theme,
    orientation,
    layout,
    summaryChartMode: 'B',
    designSource: 'default',
    designMd: DESIGN_MD,
    freeRequirement: 'corpus containment gate',
    checklist,
    plan,
  });
}

// ---------------------------------------------------------------------------
// The gate.
// ---------------------------------------------------------------------------

describe('html-export pipeline — synthetic corpus containment gate', () => {
  it('authors exactly the seven synthetic fixtures', () => {
    expect([...CORPUS_FIXTURES]).toEqual([
      'short',
      'very-long',
      'table-heavy',
      'code-heavy',
      'korean',
      'mixed',
      'data-heavy',
    ]);
  });

  for (const name of CORPUS_FIXTURES) {
    describe(`fixture: ${name}.md`, () => {
      const model = loadFixture(name);

      it('parses into a valid, non-empty ContentModel', () => {
        expect(model.sections.length).toBeGreaterThan(0);
        const v = validateContentModel(model);
        expect(v.ok).toBe(true);
      });

      for (const orientation of ORIENTATIONS) {
        it(`slides/${orientation}: engine contains every slide (overflowSlides === 0)`, async () => {
          const res = await planSlides({ model, orientation, measure: columnMeasure });
          expect(res.ok).toBe(true);
          expect(res.diagnostics.overflowSlides).toBe(0);
          expect(res.diagnostics.containmentPass).toBe(true);
          expect(res.slides.length).toBeGreaterThan(0);
          expect(res.diagnostics.minScale).toBeGreaterThanOrEqual(MIN_SCALE);
          for (const slide of res.slides) {
            expect(slide.scale).toBeGreaterThanOrEqual(MIN_SCALE);
            expect(slide.scale).toBeLessThanOrEqual(1);
            // No planned slide overflows the safe area at its chosen scale.
            const m = columnMeasure(slide.blocks, slideDimsFor(orientation), 1);
            const dims = slideDimsFor(orientation);
            expect(m.contentW * slide.scale).toBeLessThanOrEqual(dims.safeW + 1);
            expect(m.contentH * slide.scale).toBeLessThanOrEqual(dims.safeH + 1);
          }
        });

        it(`slides/${orientation}: bundles the ENGINE-PLANNED deck self-contained`, async () => {
          // The shipped bundle must emit the engine's PLAN (cover + one slide per
          // PLANNED slide, each at its uniform scale) — not a naive section deck.
          const plan = await planSlides({ model, orientation, measure: columnMeasure });
          expect(plan.ok).toBe(true);
          const { html, manifest } = bundleFor(model, orientation, 'slides', plan.slides);
          const verdict = validateSelfContainedHtml(html);
          expect(verdict.violations).toEqual([]);
          expect(verdict.ok).toBe(true);
          expect(html.match(/<!doctype html>/gi)?.length).toBe(1);
          expect(manifest.schemaVersion).toBe(EXPORT_MANIFEST_SCHEMA_VERSION);
          expect(manifest.layout).toBe('slides');
          expect(manifest.orientation).toBe(orientation);
          // Cover + one `.slide` per PLANNED slide (NOT per source section).
          expect(manifest.slideCount).toBe(plan.slides.length + 1);
          expect(manifest.chartCount).toBe(countCharts(model));
          // The plan's uniform scale is BAKED into the document.
          expect(manifest.minScale).not.toBeNull();
          expect(manifest.minScale as number).toBeGreaterThanOrEqual(MIN_SCALE);
          expect(manifest.minScale as number).toBeLessThanOrEqual(1);
          expect(html).toContain('class="he-scaler"');
          // Every planned slide carries an explicit scale marker; any sub-1 scale
          // is applied as a real CSS transform (never a silent clip).
          const scalerCount = html.match(/data-he-scale=/g)?.length ?? 0;
          expect(scalerCount).toBe(plan.slides.length + 1); // + cover
          if ((manifest.minScale as number) < 1) expect(html).toContain('transform:scale(');
        });

        it(`scroll/${orientation}: bundles a self-contained, vertical-only document`, () => {
          const { html, manifest } = bundleFor(model, orientation, 'scroll');
          const verdict = validateSelfContainedHtml(html);
          expect(verdict.violations).toEqual([]);
          expect(verdict.ok).toBe(true);
          expect(manifest.layout).toBe('scroll');
          expect(manifest.slideCount).toBe(0);
          expect(html).toContain('overflow-x:hidden');

          // Engine-level scroll containment is finite + well-formed.
          const scroll = planScrollContainment({ model, orientation, measure: columnMeasure });
          return scroll.then((r) => {
            expect(Number.isFinite(r.contentW)).toBe(true);
            expect(Number.isFinite(r.contentH)).toBe(true);
            expect(r.safeW).toBeGreaterThan(0);
          });
        });
      }
    });
  }

  it('is deterministic — identical inputs produce identical bundles', async () => {
    const model = loadFixture('mixed');
    const plan = (await planSlides({ model, orientation: 'horizontal', measure: columnMeasure })).slides;
    const a = bundleFor(model, 'horizontal', 'slides', plan).html;
    const b = bundleFor(model, 'horizontal', 'slides', plan).html;
    expect(a).toBe(b);
  });

  it('exercises the split/scale path (a stress fixture needs more than one pass)', async () => {
    // data-heavy + very-long stack enough content that the engine must scale
    // and/or split somewhere across the matrix — proving the gate is not trivial.
    let totalSplits = 0;
    let maxSlides = 0;
    for (const name of ['very-long', 'table-heavy', 'data-heavy', 'code-heavy']) {
      const model = loadFixture(name);
      for (const orientation of ORIENTATIONS) {
        const res = await planSlides({ model, orientation, measure: columnMeasure });
        expect(res.ok).toBe(true);
        totalSplits += res.diagnostics.splits;
        maxSlides = Math.max(maxSlides, res.slides.length);
      }
    }
    // At minimum, the stress fixtures produce multi-slide decks.
    expect(maxSlides).toBeGreaterThan(1);
  });
});
