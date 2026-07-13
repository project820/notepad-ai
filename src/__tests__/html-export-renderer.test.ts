import { describe, it, expect } from 'vitest';
import { renderContent } from '../renderer/html-export-renderer';
import type { ContentModel } from '../renderer/html-export-model';

// A static ContentModel exercising every block kind (incl. a chart + a table).
const MODEL: ContentModel = {
  title: 'Quarterly Review',
  sections: [
    {
      kicker: 'Overview',
      title: 'Highlights',
      blocks: [
        { kind: 'kicker', text: 'FY25' },
        { kind: 'heading', level: 2, text: 'Revenue up' },
        { kind: 'paragraph', text: 'Sales grew 12% <not a tag> & more' },
        { kind: 'list', ordered: false, items: ['Alpha', 'Beta & Co'] },
        {
          kind: 'table',
          headers: ['Region', 'Sales'],
          rows: [
            ['APAC', '100'],
            ['EMEA', '80'],
          ],
        },
        { kind: 'code', language: 'ts', code: 'const x = 1 < 2;' },
        { kind: 'quote', text: 'Stay hungry' },
        { kind: 'callout', tone: 'info', text: 'Note this' },
        { kind: 'chart', chart: { type: 'bar', title: 'Sales', labels: ['A', 'B'], series: [{ values: [1, 2] }] } },
      ],
    },
    {
      title: 'Outlook',
      blocks: [{ kind: 'paragraph', text: 'Next quarter looks strong.' }],
    },
  ],
};

// Model text that tries to smuggle markup — must never survive un-escaped.
const XSS: ContentModel = {
  title: 'Pwn <script>alert(1)</script>',
  sections: [{ blocks: [{ kind: 'paragraph', text: 'hello <script>alert(2)</script> world' }] }],
};

// Substrings that must NEVER appear (offline-safe: no remote/raster/embed assets).
const FORBIDDEN = ['http', 'url(', '<iframe', '<object', '<embed', '<canvas', 'data:', 'srcset', 'image-set('];

describe('renderContent — scroll layout', () => {
  const r = renderContent(MODEL, { layout: 'scroll', orientation: 'vertical' });

  it('emits a single vertical document with header + sections (no slides)', () => {
    expect(r.bodyHtml).toContain('class="he-doc he-scroll"');
    expect(r.bodyHtml).toContain('data-he-layout="scroll"');
    expect(r.bodyHtml).toContain('data-he-orientation="vertical"');
    expect(r.bodyHtml).toContain('<h1 class="he-doc-title">Quarterly Review</h1>');
    expect(r.bodyHtml).toContain('he-divider'); // section separator
    expect(r.bodyHtml).not.toContain('class="slide"');
    expect(r.slideCount).toBe(0);
  });

  it('renders every block kind with theme component classes', () => {
    expect(r.bodyHtml).toContain('he-kicker');
    expect(r.bodyHtml).toContain('he-section-header');
    expect(r.bodyHtml).toContain('he-callout');
    expect(r.bodyHtml).toContain('he-card'); // table + code wrappers
    expect(r.bodyHtml).toContain('<table class="he-table">');
    expect(r.bodyHtml).toContain('<th>Region</th>');
    expect(r.bodyHtml).toContain('<blockquote class="he-quote">');
    expect(r.bodyHtml).toContain('<ul class="he-list">');
    expect(r.bodyHtml).toContain('<h2 class="he-heading he-h2">');
  });

  it('renders the chart as inline SVG and counts it', () => {
    expect(r.bodyHtml).toContain('<svg');
    expect(r.bodyHtml).toContain('<figure class="he-chart"');
    expect(r.chartCount).toBe(1);
  });

  it('escapes model text — no model-authored markup survives', () => {
    expect(r.bodyHtml).toContain('Sales grew 12% &lt;not a tag&gt; &amp; more');
    expect(r.bodyHtml).toContain('const x = 1 &lt; 2;');
    expect(r.bodyHtml).toContain('<li>Beta &amp; Co</li>');
  });

  it('contains no remote / raster / embedded assets', () => {
    for (const bad of FORBIDDEN) expect(r.bodyHtml).not.toContain(bad);
  });
});

describe('renderContent — slides layout', () => {
  const r = renderContent(MODEL, { layout: 'slides', orientation: 'horizontal' });

  it('groups sections into slide containers behind a cover slide', () => {
    expect(r.bodyHtml).toContain('class="he-doc he-slides"');
    expect(r.bodyHtml).toContain('class="slide active he-cover"');
    expect(r.bodyHtml).toContain('class="slide"');
    expect(r.bodyHtml).toContain('data-he-slide-index="0"'); // cover
    expect(r.bodyHtml).toContain('data-he-slide-index="2"'); // cover + 2 sections
    expect(r.bodyHtml).toContain('he-slide-inner');
    expect(r.slideCount).toBe(3);
  });
  it('renders planned headers and cover with the exact elements used for measurement', () => {
    const planned = renderContent(MODEL, {
      layout: 'slides',
      orientation: 'horizontal',
      plan: [
        { cover: true, scale: 1, blocks: [{ kind: 'heading', level: 1, text: 'Deck' }] },
        { scale: 1, sectionTitle: 'One', blocks: [{ kind: 'paragraph', text: 'Body' }] },
      ],
    });

    expect(planned.bodyHtml).toContain('class="he-heading he-h1"');
    expect(planned.bodyHtml).toContain('class="he-heading he-h2"');
    expect(planned.bodyHtml).not.toContain('class="he-section-header"');
    expect(planned.slideCount).toBe(2);
  });

  it('emits the G005 nav hooks + reflow root + live counter', () => {
    expect(r.bodyHtml).toContain('data-he-reflow-root');
    expect(r.bodyHtml).toContain('he-slide-nav');
    expect(r.bodyHtml).toContain('data-he-prev');
    expect(r.bodyHtml).toContain('data-he-next');
    expect(r.bodyHtml).toContain('data-he-current');
    expect(r.bodyHtml).toContain('<span data-he-total>3</span>');
  });

  it('still carries an inline chart and no remote/raster assets', () => {
    expect(r.bodyHtml).toContain('<svg');
    for (const bad of FORBIDDEN) expect(r.bodyHtml).not.toContain(bad);
  });
});

describe('renderContent — the model never authors markup', () => {
  it('escapes a <script> smuggled into model title + body text', () => {
    const r = renderContent(XSS, { layout: 'scroll', orientation: 'vertical' });
    expect(r.bodyHtml).not.toContain('<script>');
    expect(r.bodyHtml).toContain('&lt;script&gt;alert(2)&lt;/script&gt;');
    expect(r.headHtml).not.toContain('<script>');
    expect(r.headHtml).toContain('<title>Pwn &lt;script&gt;alert(1)&lt;/script&gt;</title>');
  });
});

describe('renderContent — determinism', () => {
  it('produces identical output for identical inputs', () => {
    const a = renderContent(MODEL, { layout: 'slides', orientation: 'horizontal' });
    const b = renderContent(MODEL, { layout: 'slides', orientation: 'horizontal' });
    expect(a.bodyHtml).toBe(b.bodyHtml);
    expect(a.headHtml).toBe(b.headHtml);
  });
});
