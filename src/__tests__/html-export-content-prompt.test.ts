import { describe, it, expect } from 'vitest';
import {
  buildHtmlExportContentPrompt,
  HTML_EXPORT_CONTENT_INSTRUCTIONS,
} from '../renderer/html-export-content-prompt';
import type { HtmlExportRequest } from '../renderer/html-export-model';

const base: HtmlExportRequest = {
  orientation: 'horizontal',
  layout: 'slides',
  designSource: 'getdesign',
  designMd: '# Dark editorial deck\nAccent: #c3d9f3',
  summaryChartMode: 'A',
  freeRequirement: 'Make it skimmable for an executive in 2 minutes.',
  markdown: '# Title\n\nSome body text.',
  model: 'claude',
};

describe('buildHtmlExportContentPrompt — single block carries every selection (AC a)', () => {
  it('embeds orientation, layout, design, mode, and the free requirement in one block', () => {
    const { prompt } = buildHtmlExportContentPrompt(base);
    expect(prompt).toContain('=== EXPORT REQUEST ===');
    expect(prompt).toMatch(/orientation: HORIZONTAL/);
    expect(prompt).toMatch(/layout: SLIDES/);
    expect(prompt).toContain('design source: getdesign');
    expect(prompt).toMatch(/summary\/chart mode: A/);
    expect(prompt).toContain('Make it skimmable for an executive');
    expect(prompt).toContain('Dark editorial deck'); // design.md included
    expect(prompt).toContain('Some body text.'); // source included
  });

  it('reflects a different orientation/layout/mode deterministically', () => {
    const { prompt } = buildHtmlExportContentPrompt({ ...base, orientation: 'vertical', layout: 'scroll', summaryChartMode: 'D' });
    expect(prompt).toMatch(/orientation: VERTICAL/);
    expect(prompt).toMatch(/layout: SCROLL/);
    expect(prompt).toMatch(/vertical scroll only, never horizontal/);
    expect(prompt).toMatch(/summary\/chart mode: D/);
  });
});

describe('buildHtmlExportContentPrompt — forbids HTML output (AC b)', () => {
  it('instructs JSON-only and explicitly forbids HTML/CSS/JS authoring', () => {
    const { prompt } = buildHtmlExportContentPrompt(base);
    expect(prompt).toContain(HTML_EXPORT_CONTENT_INSTRUCTIONS);
    expect(prompt).toContain('Output ONLY the JSON object');
    expect(prompt).toMatch(/No HTML, CSS, JS/);
    expect(prompt).toContain('OUTPUT SCHEMA:');
  });
});

describe('buildHtmlExportContentPrompt — budgeting', () => {
  it('warns near and truncates past the source budget', () => {
    const small = 1000;
    const near = buildHtmlExportContentPrompt({ ...base, markdown: 'x'.repeat(900) }, { maxSourceChars: small });
    expect(near.warning).toBe(true);
    expect(near.truncated).toBe(false);

    const over = buildHtmlExportContentPrompt({ ...base, markdown: 'x'.repeat(2000) }, { maxSourceChars: small });
    expect(over.truncated).toBe(true);
    expect(over.prompt).toContain('source truncated here');
  });

  it('omits the design + requirement sections when empty', () => {
    const { prompt } = buildHtmlExportContentPrompt({ ...base, designMd: '', freeRequirement: '' });
    expect(prompt).not.toContain('DESIGN SYSTEM');
    expect(prompt).not.toContain('USER REQUIREMENT');
  });
});
