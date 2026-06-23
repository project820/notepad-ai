import { describe, it, expect } from 'vitest';
import { renderChartSvg } from '../renderer/html-export-charts';
import { CHART_TYPES, type ChartSpec, type ChartType } from '../renderer/html-export-model';

function spec(type: ChartType, over: Partial<ChartSpec> = {}): ChartSpec {
  return {
    type,
    title: 'Quarterly result',
    labels: ['Q1', 'Q2', 'Q3', 'Q4'],
    series: [{ name: 'Revenue', values: [10, 25, 18, 30] }],
    unit: 'k',
    note: 'illustrative',
    ...over,
  };
}

// Substrings that must NEVER appear (offline-safe + no raster + no script).
const FORBIDDEN = ['http', 'url(', '<image', '<canvas', '<script', 'data:'];

function assertInlineSvg(svg: string): void {
  expect(svg.startsWith('<svg')).toBe(true);
  expect(svg.endsWith('</svg>')).toBe(true);
  expect(svg).toContain('role="img"');
  expect(svg).toContain('<title');
  expect(svg).toContain('viewBox=');
  for (const bad of FORBIDDEN) expect(svg.includes(bad)).toBe(false);
}

describe('renderChartSvg — every chart type', () => {
  for (const type of CHART_TYPES) {
    it(`renders valid inline SVG for "${type}"`, () => {
      const svg = renderChartSvg(spec(type), { idPrefix: 'chart' });
      assertInlineSvg(svg);
      expect(svg).toContain(`he-chart--${type}`);
      // Accessible name from spec.title, escaped + present.
      expect(svg).toContain('<title id="chart-title">Quarterly result</title>');
      expect(svg).toContain('aria-labelledby="chart-title chart-desc"');
    });
  }

  it('covers all five required chart types', () => {
    expect([...CHART_TYPES].sort()).toEqual(['bar', 'donut', 'line', 'pie', 'timeline']);
  });
});

describe('renderChartSvg — XML escaping', () => {
  it('escapes special characters in labels / title / note (never raw)', () => {
    const svg = renderChartSvg(
      spec('bar', {
        title: '<i>Title</i>',
        note: 'a & b "c"',
        labels: ['<b>&"x', 'ok'],
        series: [{ name: '<svg>', values: [1, 2] }],
      }),
      { idPrefix: 'esc' },
    );
    // Escaped forms present…
    expect(svg).toContain('&lt;b&gt;&amp;&quot;x');
    expect(svg).toContain('&lt;i&gt;Title&lt;/i&gt;');
    expect(svg).toContain('a &amp; b &quot;c&quot;');
    // …raw injected markup absent.
    expect(svg).not.toContain('<b>&"x');
    expect(svg).not.toContain('<i>Title</i>');
    // The series name "<svg>" must not appear raw as a nested element.
    expect(svg).not.toContain('><svg>');
    assertInlineSvg(svg);
  });
});

describe('renderChartSvg — determinism', () => {
  for (const type of CHART_TYPES) {
    it(`is byte-identical across renders for "${type}" with the same idPrefix`, () => {
      const a = renderChartSvg(spec(type), { idPrefix: 'det' });
      const b = renderChartSvg(spec(type), { idPrefix: 'det' });
      expect(a).toBe(b);
    });
  }

  it('uses deterministic element ids derived from idPrefix', () => {
    const svg = renderChartSvg(spec('bar'), { idPrefix: 'my-chart-7' });
    expect(svg).toContain('id="my-chart-7-title"');
    expect(svg).toContain('id="my-chart-7-desc"');
  });

  it('sanitises an unsafe idPrefix to a valid id stem', () => {
    const svg = renderChartSvg(spec('line'), { idPrefix: '99 bad/<id>' });
    // Non-id chars stripped; leading digit prefixed with "c".
    expect(svg).toContain('aria-labelledby="c99badid-title c99badid-desc"');
    expect(svg).not.toContain('<id>');
  });
});

describe('renderChartSvg — no external / raster assets', () => {
  for (const type of CHART_TYPES) {
    it(`emits zero external/raster references for "${type}"`, () => {
      const svg = renderChartSvg(spec(type), { idPrefix: 'safe' });
      for (const bad of FORBIDDEN) expect(svg.includes(bad)).toBe(false);
    });
  }

  it('drops an unsafe caller-supplied palette colour and stays offline-safe', () => {
    const svg = renderChartSvg(spec('bar'), {
      idPrefix: 'pal',
      palette: ["url('http://evil/x.png')", '#123456'],
    });
    for (const bad of FORBIDDEN) expect(svg.includes(bad)).toBe(false);
    expect(svg).toContain('#123456'); // the safe colour is used
  });
});

describe('renderChartSvg — invalid specs never throw', () => {
  const bad: { label: string; value: unknown }[] = [
    { label: 'null', value: null },
    { label: 'unknown type', value: { type: 'bogus', labels: [], series: [{ values: [1] }] } },
    { label: 'labels not strings', value: { type: 'bar', labels: [1, 2], series: [{ values: [1] }] } },
    { label: 'empty series', value: { type: 'bar', labels: ['a'], series: [] } },
    { label: 'non-finite values', value: { type: 'line', labels: ['a'], series: [{ values: [Number.NaN] }] } },
    { label: 'values not numbers', value: { type: 'pie', labels: ['a'], series: [{ values: ['x'] }] } },
  ];

  for (const { label, value } of bad) {
    it(`returns an inline error SVG for: ${label}`, () => {
      let svg = '';
      expect(() => {
        svg = renderChartSvg(value as ChartSpec, { idPrefix: 'err' });
      }).not.toThrow();
      assertInlineSvg(svg);
      expect(svg).toContain('he-chart--error');
      expect(svg).toContain('<title id="err-title">Invalid chart</title>');
    });
  }
});

describe('renderChartSvg — chart geometry sanity', () => {
  it('bar chart emits one rect per (label × series) plus a legend for multi-series', () => {
    const svg = renderChartSvg(
      spec('bar', {
        labels: ['a', 'b'],
        series: [
          { name: 'X', values: [1, 2] },
          { name: 'Y', values: [3, 4] },
        ],
      }),
      { idPrefix: 'g' },
    );
    expect((svg.match(/<rect /g) || []).length).toBeGreaterThanOrEqual(4);
    expect(svg).toContain('he-chart__legend');
    expect(svg).toContain('>X<');
    expect(svg).toContain('>Y<');
  });

  it('line chart emits a polyline', () => {
    const svg = renderChartSvg(spec('line'), { idPrefix: 'g' });
    expect(svg).toContain('<polyline');
  });

  it('pie/donut emit path slices and a legend row per label', () => {
    const pie = renderChartSvg(spec('pie', { series: [{ values: [1, 2, 3, 4] }] }), { idPrefix: 'g' });
    const donut = renderChartSvg(spec('donut', { series: [{ values: [1, 2, 3, 4] }] }), { idPrefix: 'g' });
    expect(pie).toContain('<path ');
    expect(donut).toContain('<path ');
    // every coordinate is finite (no NaN leaked into the path data)
    expect(pie.includes('NaN')).toBe(false);
    expect(donut.includes('NaN')).toBe(false);
  });

  it('timeline emits a node + label per entry', () => {
    const svg = renderChartSvg(spec('timeline'), { idPrefix: 'g' });
    expect((svg.match(/<circle /g) || []).length).toBeGreaterThanOrEqual(4);
    expect(svg).toContain('>Q1<');
  });
});
