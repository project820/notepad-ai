import { describe, it, expect } from 'vitest';
import {
  htmlExportReducer,
  initialHtmlExportState,
  resolvePurposeConfig,
  HTML_PURPOSE_PRESETS,
  type HtmlExportEvent,
  type HtmlExportState,
  type LayoutKind,
  type Orientation,
} from '../html-export-state';
import type { SummaryChartMode } from '../html-export-model';
import type { HtmlExportFinalized } from '../html-export-state';

function run(events: HtmlExportEvent[], from: HtmlExportState = initialHtmlExportState): HtmlExportState {
  return events.reduce((state, event) => htmlExportReducer(state, event), from);
}

const COMBOS: Array<[Orientation, LayoutKind]> = [
  ['vertical', 'scroll'],
  ['vertical', 'slides'],
  ['horizontal', 'scroll'],
  ['horizontal', 'slides'],
];

/** Drive to choose-design for a combo. */
function toDesign(orientation: Orientation, layout: LayoutKind): HtmlExportState {
  return run([
    { type: 'START' },
    { type: 'SELECT_ORIENTATION', orientation },
    { type: 'SELECT_LAYOUT', layout },
  ]);
}

const FINALIZED = {
  attemptId: 'attempt-1',
  finalizedArtifactId: 'final-1',
} as unknown as HtmlExportFinalized;

describe('htmlExportReducer — orientation × layout reach the summary/requirement step (all four combos)', () => {
  for (const [orientation, layout] of COMBOS) {
    it(`reaches choose-design for ${orientation} + ${layout}`, () => {
      const state = toDesign(orientation, layout);
      expect(state.step).toBe('choose-design');
      expect(state.orientation).toBe(orientation);
      expect(state.layout).toBe(layout);
    });

    it(`reaches summary-requirement for ${orientation} + ${layout} (via default design)`, () => {
      const state = htmlExportReducer(toDesign(orientation, layout), { type: 'USE_DEFAULT_DESIGN' });
      expect(state.step).toBe('summary-requirement');
      expect(state.orientation).toBe(orientation);
      expect(state.layout).toBe(layout);
      expect(state.designSource).toBe('default');
    });

    it(`reaches summary-requirement for ${orientation} + ${layout} (via fetched design)`, () => {
      const fetching = htmlExportReducer(toDesign(orientation, layout), { type: 'SUBMIT_DESIGN', input: 'replicate' });
      const state = htmlExportReducer(fetching, {
        type: 'FETCH_OK',
        rawUrl: 'https://raw/x/DESIGN.md',
        designMd: '# tokens',
      });
      expect(state.step).toBe('summary-requirement');
      expect(state.orientation).toBe(orientation);
      expect(state.layout).toBe(layout);
      expect(state.designSource).toBe('getdesign');
      expect(state.design).toEqual({ rawUrl: 'https://raw/x/DESIGN.md', designMd: '# tokens' });
    });
  }

  it('ignores out-of-order events (pure, no implicit jumps)', () => {
    const state = run([{ type: 'START' }, { type: 'SELECT_LAYOUT', layout: 'scroll' }]);
    expect(state.step).toBe('choose-orientation');
  });
});

describe('htmlExportReducer — design.md is mandatory (no silent skip)', () => {
  const base = toDesign('vertical', 'scroll');

  it('SUBMIT_DESIGN → fetching-design, FETCH_OK → summary-requirement with design', () => {
    const fetching = htmlExportReducer(base, { type: 'SUBMIT_DESIGN', input: 'replicate' });
    expect(fetching.step).toBe('fetching-design');
    const next = htmlExportReducer(fetching, {
      type: 'FETCH_OK',
      rawUrl: 'https://raw.githubusercontent.com/x/DESIGN.md',
      designMd: '# tokens',
    });
    expect(next.step).toBe('summary-requirement');
    expect(next.design).toEqual({ rawUrl: 'https://raw.githubusercontent.com/x/DESIGN.md', designMd: '# tokens' });
    expect(next.designSource).toBe('getdesign');
    expect(next.fetchError).toBeUndefined();
  });

  it('FETCH_FAIL keeps the user on choose-design with an error — NEVER advances to generation', () => {
    const fetching = htmlExportReducer(base, { type: 'SUBMIT_DESIGN', input: 'replicate' });
    const failed = htmlExportReducer(fetching, { type: 'FETCH_FAIL', error: 'offline' });
    expect(failed.step).toBe('choose-design');
    expect(failed.step).not.toBe('summary-requirement');
    expect(failed.step).not.toBe('generating');
    expect(failed.design).toBeUndefined();
    expect(failed.designSource).toBeUndefined();
    expect(failed.fetchError).toBe('offline');
  });

  it('USE_DEFAULT_DESIGN is the only no-fetch path forward → summary-requirement with designSource=default', () => {
    const next = htmlExportReducer(base, { type: 'USE_DEFAULT_DESIGN' });
    expect(next.step).toBe('summary-requirement');
    expect(next.design).toBeUndefined();
    expect(next.designSource).toBe('default');
    expect(next.fetchError).toBeUndefined();
  });

  it('there is no SKIP_DESIGN success path (an unknown event is a no-op on choose-design)', () => {
    // SKIP_DESIGN was removed; firing it must not advance the wizard.
    const next = htmlExportReducer(base, { type: 'SKIP_DESIGN' } as unknown as HtmlExportEvent);
    expect(next.step).toBe('choose-design');
  });

  it('BACK from choose-design clears a prior fetch error', () => {
    const failed = run([{ type: 'SUBMIT_DESIGN', input: 'x' }, { type: 'FETCH_FAIL', error: 'offline' }], base);
    expect(failed.fetchError).toBe('offline');
    const back = htmlExportReducer(failed, { type: 'BACK' });
    expect(back.step).toBe('choose-layout');
    expect(back.fetchError).toBeUndefined();
  });
});

describe('htmlExportReducer — A/B/C/D summary/chart selection', () => {
  const onSummary = htmlExportReducer(toDesign('vertical', 'scroll'), { type: 'USE_DEFAULT_DESIGN' });

  for (const mode of ['A', 'B', 'C', 'D'] as SummaryChartMode[]) {
    it(`SELECT_SUMMARY_CHART records mode ${mode}`, () => {
      const next = htmlExportReducer(onSummary, { type: 'SELECT_SUMMARY_CHART', mode });
      expect(next.step).toBe('summary-requirement');
      expect(next.summaryChartMode).toBe(mode);
    });
  }

  it('SELECT_SUMMARY_CHART is a no-op outside the summary step (pure)', () => {
    const onOrientation = run([{ type: 'START' }]);
    const next = htmlExportReducer(onOrientation, { type: 'SELECT_SUMMARY_CHART', mode: 'C' });
    expect(next.summaryChartMode).toBeUndefined();
    expect(next.step).toBe('choose-orientation');
  });
});

describe('htmlExportReducer — token warning requires confirmation before generating', () => {
  const onSummary = run([
    { type: 'START' },
    { type: 'SELECT_ORIENTATION', orientation: 'horizontal' },
    { type: 'SELECT_LAYOUT', layout: 'slides' },
    { type: 'USE_DEFAULT_DESIGN' },
  ]);

  it('a flagged long document stops at token-warning, not generating', () => {
    const warned = htmlExportReducer(onSummary, {
      type: 'SUBMIT_REQUIREMENT',
      freeRequirement: 'punchy',
      summaryChartMode: 'A',
      tokenWarning: true,
    });
    expect(warned.step).toBe('token-warning');
    expect(warned.step).not.toBe('generating');
    expect(warned.pendingRequirement).toBe('punchy');
    expect(warned.summaryChartMode).toBe('A');

    const generating = htmlExportReducer(warned, { type: 'CONFIRM_TOKEN_WARNING' });
    expect(generating.step).toBe('generating');
    expect(generating.freeRequirement).toBe('punchy');
  });

  it('without a warning, SUBMIT_REQUIREMENT generates directly and carries both core fields', () => {
    const generating = htmlExportReducer(onSummary, {
      type: 'SUBMIT_REQUIREMENT',
      freeRequirement: 'calm',
      summaryChartMode: 'D',
    });
    expect(generating.step).toBe('generating');
    expect(generating.freeRequirement).toBe('calm');
    expect(generating.summaryChartMode).toBe('D');
  });
});

describe('htmlExportReducer — generate holds the validated content model', () => {
  const generating = run([
    { type: 'START' },
    { type: 'SELECT_ORIENTATION', orientation: 'vertical' },
    { type: 'SELECT_LAYOUT', layout: 'scroll' },
    { type: 'USE_DEFAULT_DESIGN' },
    { type: 'SUBMIT_REQUIREMENT', freeRequirement: '', summaryChartMode: 'B' },
  ]);

  it('AI_DONE → generated, holding the finalized descriptor (no HTML)', () => {
    const generated = htmlExportReducer(generating, { type: 'AI_DONE', finalized: FINALIZED });
    expect(generated.step).toBe('generated');
    expect(generated.finalized).toEqual(FINALIZED);
    // No HTML artifact is ever stored on this path.
    expect((generated as Record<string, unknown>).generated).toBeUndefined();
  });

  it('AI_ERROR → error', () => {
    const errored = htmlExportReducer(generating, { type: 'AI_ERROR', error: 'invalid model' });
    expect(errored.step).toBe('error');
    expect(errored.error).toBe('invalid model');
  });

  it('BACK from generated returns to the summary/requirement step', () => {
    const generated = htmlExportReducer(generating, { type: 'AI_DONE', finalized: FINALIZED });
    const back = htmlExportReducer(generated, { type: 'BACK' });
    expect(back.step).toBe('summary-requirement');
    expect(back.finalized).toEqual(FINALIZED);
  });

  it('regenerate path: SUBMIT_REQUIREMENT is valid again from generated', () => {
    const generated = htmlExportReducer(generating, { type: 'AI_DONE', finalized: FINALIZED });
    const again = htmlExportReducer(generated, { type: 'SUBMIT_REQUIREMENT', freeRequirement: 'x', summaryChartMode: 'C' });
    expect(again.step).toBe('generating');
    expect(again.summaryChartMode).toBe('C');
  });

  it('CANCEL resets to idle from anywhere', () => {
    const generated = htmlExportReducer(generating, { type: 'AI_DONE', finalized: FINALIZED });
    expect(htmlExportReducer(generated, { type: 'CANCEL' }).step).toBe('idle');
  });
});

describe('htmlExportReducer — mode + advanced knobs stay optional (demoted, not core)', () => {
  it('SET_MODE stores the entry mode without changing the step', () => {
    const s1 = run([{ type: 'START' }, { type: 'SET_MODE', mode: 'detail' }]);
    expect(s1.mode).toBe('detail');
    expect(s1.step).toBe('choose-orientation');
  });

  it('START preserves a previously chosen mode', () => {
    const s1 = htmlExportReducer({ step: 'idle', mode: 'detail' }, { type: 'START' });
    expect(s1.mode).toBe('detail');
    expect(s1.step).toBe('choose-orientation');
  });

  it('SUBMIT_REQUIREMENT carries optional advanced knobs into the generating state', () => {
    const base = run([
      { type: 'START' },
      { type: 'SELECT_ORIENTATION', orientation: 'vertical' },
      { type: 'SELECT_LAYOUT', layout: 'scroll' },
      { type: 'USE_DEFAULT_DESIGN' },
    ]);
    const gen = htmlExportReducer(base, {
      type: 'SUBMIT_REQUIREMENT',
      freeRequirement: 't',
      summaryChartMode: 'B',
      purpose: 'landing',
      density: 'roomy',
      readableWidth: 'wide',
      interactive: true,
    });
    expect(gen.step).toBe('generating');
    expect(gen.purpose).toBe('landing');
    expect(gen.density).toBe('roomy');
    expect(gen.readableWidth).toBe('wide');
    expect(gen.interactive).toBe(true);
  });

  it('SUBMIT_REQUIREMENT works with only the two core fields (no advanced config)', () => {
    const base = run([
      { type: 'START' },
      { type: 'SELECT_ORIENTATION', orientation: 'vertical' },
      { type: 'SELECT_LAYOUT', layout: 'scroll' },
      { type: 'USE_DEFAULT_DESIGN' },
    ]);
    const gen = htmlExportReducer(base, { type: 'SUBMIT_REQUIREMENT', freeRequirement: 'minimal', summaryChartMode: 'A' });
    expect(gen.step).toBe('generating');
    expect(gen.freeRequirement).toBe('minimal');
    expect(gen.summaryChartMode).toBe('A');
  });
});

describe('resolvePurposeConfig (advanced read-good defaults)', () => {
  it('applies the preset defaults for a known purpose', () => {
    const c = resolvePurposeConfig({ purpose: 'presentation' });
    expect(c.purpose).toBe('presentation');
    expect(c.density).toBe(HTML_PURPOSE_PRESETS.presentation.density);
    expect(c.readableWidth).toBe(HTML_PURPOSE_PRESETS.presentation.readableWidth);
    expect(c.interactive).toBe(HTML_PURPOSE_PRESETS.presentation.interactive);
    expect(c.brief.length).toBeGreaterThan(10);
  });

  it('detail overrides win over the purpose default', () => {
    const c = resolvePurposeConfig({ purpose: 'report', density: 'roomy', interactive: true });
    expect(c.density).toBe('roomy');
    expect(c.interactive).toBe(true);
  });

  it('custom purpose uses the user free-text as the brief with balanced defaults', () => {
    const c = resolvePurposeConfig({ purpose: 'custom', customPurpose: 'an interactive recipe card' });
    expect(c.purpose).toBe('custom');
    expect(c.brief).toContain('interactive recipe card');
  });

  it('defaults to report when no purpose is given', () => {
    expect(resolvePurposeConfig({}).purpose).toBe('report');
  });
});
