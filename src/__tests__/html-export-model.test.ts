import { describe, it, expect } from 'vitest';
import {
  validateContentModel,
  parseContentModel,
  resolveSummaryChartPolicy,
  SUMMARY_CHART_MODES,
  CONTENT_LIMITS,
  type ContentModel,
} from '../renderer/html-export-model';

const valid: ContentModel = {
  title: 'Trip Handover',
  sections: [
    {
      kicker: 'Section 01',
      title: 'Overview',
      blocks: [
        { kind: 'heading', level: 2, text: 'Goals' },
        { kind: 'paragraph', text: 'Visit FOOMA and source equipment.' },
        { kind: 'list', ordered: false, items: ['booth tour', 'vendor meetings'] },
        { kind: 'table', headers: ['Vendor', 'Note'], rows: [['Rheon', 'priority']] },
        { kind: 'chart', chart: { type: 'bar', labels: ['A', 'B'], series: [{ values: [1, 2] }] } },
      ],
    },
  ],
};

describe('validateContentModel', () => {
  it('accepts a well-formed model', () => {
    const r = validateContentModel(valid);
    expect(r.ok).toBe(true);
  });

  it('rejects non-objects and missing/oversized title', () => {
    expect(validateContentModel(null).ok).toBe(false);
    expect(validateContentModel('x').ok).toBe(false);
    expect(validateContentModel({ sections: [] }).ok).toBe(false);
    expect(validateContentModel({ title: 'x'.repeat(CONTENT_LIMITS.maxTitleLen + 1), sections: [{ blocks: [] }] }).ok).toBe(false);
  });

  it('rejects empty or oversized sections', () => {
    expect(validateContentModel({ title: 't', sections: [] }).ok).toBe(false);
    const many = { title: 't', sections: Array.from({ length: CONTENT_LIMITS.maxSections + 1 }, () => ({ blocks: [] })) };
    expect(validateContentModel(many).ok).toBe(false);
  });

  it('rejects HTML smuggled into text (engine owns markup)', () => {
    const r = validateContentModel({
      title: 't',
      sections: [{ blocks: [{ kind: 'paragraph', text: '<script>alert(1)</script>' }] }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/HTML/i);
  });

  it('rejects an HTML document masquerading as the title', () => {
    expect(validateContentModel({ title: '<!doctype html><html></html>', sections: [{ blocks: [] }] }).ok).toBe(false);
  });

  it('rejects invalid block kinds and malformed charts', () => {
    expect(validateContentModel({ title: 't', sections: [{ blocks: [{ kind: 'bogus', text: 'x' }] }] }).ok).toBe(false);
    expect(
      validateContentModel({
        title: 't',
        sections: [{ blocks: [{ kind: 'chart', chart: { type: 'donut', labels: ['a'], series: [{ values: ['nope'] }] } }] }],
      }).ok,
    ).toBe(false);
    expect(
      validateContentModel({
        title: 't',
        sections: [{ blocks: [{ kind: 'chart', chart: { type: 'spiral', labels: [], series: [] } }] }],
      }).ok,
    ).toBe(false);
  });

  it('enforces a total block cap', () => {
    const blocks = Array.from({ length: CONTENT_LIMITS.maxBlocksTotal + 1 }, () => ({ kind: 'paragraph', text: 'x' }));
    expect(validateContentModel({ title: 't', sections: [{ blocks }] }).ok).toBe(false);
  });
});

describe('parseContentModel', () => {
  it('parses a bare JSON object', () => {
    const r = parseContentModel(JSON.stringify(valid));
    expect(r.ok).toBe(true);
  });

  it('strips a ```json fence and surrounding prose', () => {
    const r = parseContentModel('Here you go:\n```json\n' + JSON.stringify(valid) + '\n```\nthanks');
    expect(r.ok).toBe(true);
  });

  it('rejects empty, non-JSON, and HTML replies', () => {
    expect(parseContentModel('').ok).toBe(false);
    expect(parseContentModel('not json at all').ok).toBe(false);
    expect(parseContentModel('{ broken').ok).toBe(false);
    expect(parseContentModel('<!doctype html><html><body>hi</body></html>').ok).toBe(false);
  });
});

describe('resolveSummaryChartPolicy', () => {
  it('returns a distinct policy for each mode A-D', () => {
    for (const m of SUMMARY_CHART_MODES) {
      const p = resolveSummaryChartPolicy(m);
      expect(p.mode).toBe(m);
      expect(p.summarization.length).toBeGreaterThan(0);
      expect(p.chartPolicy.length).toBeGreaterThan(0);
    }
    expect(resolveSummaryChartPolicy('A').summarization).not.toBe(resolveSummaryChartPolicy('D').summarization);
  });
});
