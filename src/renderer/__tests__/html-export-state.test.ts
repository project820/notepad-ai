import { describe, it, expect } from 'vitest';
import {
  htmlExportReducer,
  initialHtmlExportState,
  type HtmlExportEvent,
  type HtmlExportState,
  type LayoutKind,
  type Orientation,
} from '../html-export-state';

function run(events: HtmlExportEvent[], from: HtmlExportState = initialHtmlExportState): HtmlExportState {
  return events.reduce((state, event) => htmlExportReducer(state, event), from);
}

describe('htmlExportReducer — orientation × layout (all four combos)', () => {
  const combos: Array<[Orientation, LayoutKind]> = [
    ['vertical', 'scroll'],
    ['vertical', 'slides'],
    ['horizontal', 'scroll'],
    ['horizontal', 'slides'],
  ];

  for (const [orientation, layout] of combos) {
    it(`reaches choose-design for ${orientation} + ${layout}`, () => {
      const state = run([
        { type: 'START' },
        { type: 'SELECT_ORIENTATION', orientation },
        { type: 'SELECT_LAYOUT', layout },
      ]);
      expect(state.step).toBe('choose-design');
      expect(state.orientation).toBe(orientation);
      expect(state.layout).toBe(layout);
    });
  }

  it('ignores out-of-order events (pure, no implicit jumps)', () => {
    // A SELECT_LAYOUT before an orientation is chosen is a no-op.
    const state = run([{ type: 'START' }, { type: 'SELECT_LAYOUT', layout: 'scroll' }]);
    expect(state.step).toBe('choose-orientation');
  });
});

describe('htmlExportReducer — design fetch and tone-only fallback', () => {
  const base = run([
    { type: 'START' },
    { type: 'SELECT_ORIENTATION', orientation: 'vertical' },
    { type: 'SELECT_LAYOUT', layout: 'scroll' },
  ]);

  it('SUBMIT_DESIGN → fetching-design, FETCH_OK → style-tone with design', () => {
    const fetching = htmlExportReducer(base, { type: 'SUBMIT_DESIGN', input: 'replicate' });
    expect(fetching.step).toBe('fetching-design');
    const tone = htmlExportReducer(fetching, {
      type: 'FETCH_OK',
      rawUrl: 'https://raw.githubusercontent.com/x/DESIGN.md',
      designMd: '# tokens',
    });
    expect(tone.step).toBe('style-tone');
    expect(tone.design).toEqual({ rawUrl: 'https://raw.githubusercontent.com/x/DESIGN.md', designMd: '# tokens' });
    expect(tone.fetchError).toBeUndefined();
  });

  it('FETCH_FAIL falls back to tone-only style-tone — never jumps to generating', () => {
    const fetching = htmlExportReducer(base, { type: 'SUBMIT_DESIGN', input: 'replicate' });
    const failed = htmlExportReducer(fetching, { type: 'FETCH_FAIL', error: 'offline' });
    expect(failed.step).toBe('style-tone');
    expect(failed.step).not.toBe('generating');
    expect(failed.design).toBeUndefined();
    expect(failed.fetchError).toBe('offline');
  });

  it('SKIP_DESIGN → style-tone with no design', () => {
    const skipped = htmlExportReducer(base, { type: 'SKIP_DESIGN' });
    expect(skipped.step).toBe('style-tone');
    expect(skipped.design).toBeUndefined();
    expect(skipped.fetchError).toBeUndefined();
  });
});

describe('htmlExportReducer — token warning requires confirmation before generating', () => {
  const tone = run([
    { type: 'START' },
    { type: 'SELECT_ORIENTATION', orientation: 'horizontal' },
    { type: 'SELECT_LAYOUT', layout: 'slides' },
    { type: 'SKIP_DESIGN' },
  ]);

  it('a flagged long document stops at token-warning, not generating', () => {
    const warned = htmlExportReducer(tone, { type: 'SUBMIT_TONE', tone: 'punchy', tokenWarning: true });
    expect(warned.step).toBe('token-warning');
    expect(warned.step).not.toBe('generating');
    expect(warned.pendingTone).toBe('punchy');

    const generating = htmlExportReducer(warned, { type: 'CONFIRM_TOKEN_WARNING' });
    expect(generating.step).toBe('generating');
    expect(generating.tone).toBe('punchy');
  });

  it('without a warning, SUBMIT_TONE generates directly', () => {
    const generating = htmlExportReducer(tone, { type: 'SUBMIT_TONE', tone: 'calm' });
    expect(generating.step).toBe('generating');
    expect(generating.tone).toBe('calm');
  });
});

describe('htmlExportReducer — generate, save, and open-saved', () => {
  const generating = run([
    { type: 'START' },
    { type: 'SELECT_ORIENTATION', orientation: 'vertical' },
    { type: 'SELECT_LAYOUT', layout: 'scroll' },
    { type: 'SKIP_DESIGN' },
    { type: 'SUBMIT_TONE', tone: '' },
  ]);

  const generated = htmlExportReducer(generating, {
    type: 'AI_DONE',
    html: '<!doctype html><html></html>',
    title: 'Report',
    bytes: 1234,
  });

  it('AI_DONE → generated, holding the artifact', () => {
    expect(generated.step).toBe('generated');
    expect(generated.generated).toEqual({ html: '<!doctype html><html></html>', title: 'Report', bytes: 1234 });
  });

  it('AI_ERROR → error', () => {
    const errored = htmlExportReducer(generating, { type: 'AI_ERROR', error: 'rate limited' });
    expect(errored.step).toBe('error');
    expect(errored.error).toBe('rate limited');
  });

  it('DOWNLOAD → saving, SAVE_OK → saved with savedPath', () => {
    const saving = htmlExportReducer(generated, { type: 'DOWNLOAD' });
    expect(saving.step).toBe('saving');
    const saved = htmlExportReducer(saving, { type: 'SAVE_OK', savedPath: '/tmp/report.html' });
    expect(saved.step).toBe('saved');
    expect(saved.savedPath).toBe('/tmp/report.html');
  });

  it('SAVE_CANCEL keeps the generated artifact', () => {
    const saving = htmlExportReducer(generated, { type: 'DOWNLOAD' });
    const back = htmlExportReducer(saving, { type: 'SAVE_CANCEL' });
    expect(back.step).toBe('generated');
    expect(back.generated).toBeDefined();
  });

  it('OPEN_SAVED → opening-saved, OPEN_OK → saved, OPEN_ERROR → saved with visible error', () => {
    const saved = run([{ type: 'DOWNLOAD' }, { type: 'SAVE_OK', savedPath: '/tmp/report.html' }], generated);
    expect(saved.step).toBe('saved');

    const opening = htmlExportReducer(saved, { type: 'OPEN_SAVED' });
    expect(opening.step).toBe('opening-saved');

    const ok = htmlExportReducer(opening, { type: 'OPEN_OK' });
    expect(ok.step).toBe('saved');
    expect(ok.error).toBeUndefined();

    const errored = htmlExportReducer(opening, { type: 'OPEN_ERROR', error: 'no handler' });
    expect(errored.step).toBe('saved');
    expect(errored.savedPath).toBe('/tmp/report.html');
    expect(errored.error).toBe('no handler');
  });

  it('CANCEL resets to idle from anywhere', () => {
    expect(htmlExportReducer(generated, { type: 'CANCEL' }).step).toBe('idle');
  });
});
