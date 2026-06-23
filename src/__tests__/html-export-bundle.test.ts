import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bundleHtml, EXPORT_MANIFEST_SCHEMA_VERSION, type BundleArgs } from '../renderer/html-export-bundle';
import { validateSelfContainedHtml } from '../renderer/html-export-validate';
import {
  parseDesignTheme,
  toCssVariables,
  themeComponentClasses,
  evaluateDesignChecklist,
  stableHash,
} from '../renderer/html-export-theme';
import type { ContentModel } from '../renderer/html-export-model';

const DESIGN_MD = `# Brand
colors:
  background: #ffffff
  ink: #18181b
  body: #3f3f46
  primary: #2563eb
  on-primary: #ffffff
`;
const theme = parseDesignTheme(DESIGN_MD);
const css = `${toCssVariables(theme)}\n${themeComponentClasses(theme)}`;
const checklist = evaluateDesignChecklist({ designMd: DESIGN_MD, theme, css });

const FREE_REQUIREMENT = 'Make it skimmable for an executive';

const MODEL: ContentModel = {
  title: 'Deck',
  sections: [
    {
      title: 'One',
      blocks: [
        { kind: 'paragraph', text: 'Body text' },
        { kind: 'chart', chart: { type: 'bar', labels: ['a', 'b'], series: [{ values: [1, 2] }] } },
      ],
    },
    { title: 'Two', blocks: [{ kind: 'paragraph', text: 'More' }] },
  ],
};

function bundle(over: Partial<BundleArgs> = {}) {
  return bundleHtml({
    model: MODEL,
    theme,
    orientation: 'horizontal',
    layout: 'slides',
    summaryChartMode: 'B',
    designSource: 'getdesign',
    designMd: DESIGN_MD,
    freeRequirement: FREE_REQUIREMENT,
    checklist,
    ...over,
  });
}

function readManifest(html: string): Record<string, unknown> {
  const m = html.match(/<script type="application\/json" id="he-manifest">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('manifest script not found');
  return JSON.parse(m[1].replace(/\\u003c/g, '<'));
}

describe('bundleHtml — single self-contained document', () => {
  it('produces exactly one <!doctype html> document', () => {
    const { html } = bundle();
    expect(html.trimStart().toLowerCase().startsWith('<!doctype html>')).toBe(true);
    expect(html.match(/<!doctype html>/gi)?.length).toBe(1);
    expect(html).toContain('<html');
    expect(html).toContain('</html>');
    expect(html).toContain('<meta charset="utf-8">');
  });

  it('inlines a single <style> with --he-* vars + the slide containment contract', () => {
    const { html } = bundle();
    expect(html.match(/<style>/g)?.length).toBe(1);
    expect(html).toContain('--he-accent');
    expect(html).toContain('--he-bg');
    expect(html).toContain('--he-title-size');
    expect(html).toContain('.slide{display:none;}');
    expect(html).toContain('.slide.active{display:flex');
    expect(html).toContain('--he-canvas-w'); // orientation-derived var
  });

  it('embeds the manifest JSON with every required field, correct', () => {
    const { html, manifest } = bundle();
    expect(html).toContain('id="he-manifest"');
    const parsed = readManifest(html);
    expect(parsed.schemaVersion).toBe(EXPORT_MANIFEST_SCHEMA_VERSION);
    expect(parsed.orientation).toBe('horizontal');
    expect(parsed.layout).toBe('slides');
    expect(parsed.summaryChartMode).toBe('B');
    expect(parsed.designSource).toBe('getdesign');
    expect(parsed.designHash).toMatch(/^[0-9a-f]{8}$/);
    expect(parsed.requirementHash).toMatch(/^[0-9a-f]{8}$/);
    expect(parsed.chartCount).toBe(1);
    expect(parsed.slideCount).toBe(3); // cover + 2 sections
    expect(parsed.minScale).toBeNull();
    expect(typeof parsed.checklistPassed).toBe('boolean');
    // The returned manifest object mirrors the embedded JSON.
    expect(manifest.chartCount).toBe(parsed.chartCount);
    expect(manifest.slideCount).toBe(parsed.slideCount);
    expect(manifest.checklistPassed).toBe(parsed.checklistPassed);
  });

  it('is self-contained (validator passes) and carries an inline SVG', () => {
    const { html } = bundle();
    expect(validateSelfContainedHtml(html).ok).toBe(true);
    expect(html).toContain('<svg');
  });

  it('honors scroll layout — vertical-only containment, slideCount 0', () => {
    const { html, manifest } = bundle({ layout: 'scroll', orientation: 'vertical' });
    expect(manifest.layout).toBe('scroll');
    expect(manifest.slideCount).toBe(0);
    expect(html).toContain('overflow-x:hidden');
    expect(html).toContain('data-he-layout="scroll"');
    expect(validateSelfContainedHtml(html).ok).toBe(true);
  });

  it('builds purely from the model — no extractHtmlDocument / LLM-HTML path', () => {
    const { manifest } = bundle();
    // Manifest hashes derive deterministically from the inputs (not from any
    // model-authored HTML) — proof the document is assembled, not extracted.
    expect(manifest.designHash).toBe(stableHash(DESIGN_MD));
    expect(manifest.requirementHash).toBe(stableHash(FREE_REQUIREMENT));
    // And the module never reaches for the LLM-HTML extraction helpers.
    const source = readFileSync(resolve('src/renderer/html-export-bundle.ts'), 'utf8');
    expect(source).not.toMatch(/extractHtmlDocument/);
    expect(source).not.toMatch(/html-export-prompt/);
  });

  it('omits generatedAt by default but injects it deterministically when given', () => {
    expect('generatedAt' in bundle().manifest).toBe(false);
    const { manifest, html } = bundle({ generatedAt: '2026-01-01T00:00:00Z' });
    expect(manifest.generatedAt).toBe('2026-01-01T00:00:00Z');
    expect(html).toContain('2026-01-01T00:00:00Z');
  });

  it('is deterministic for identical inputs', () => {
    expect(bundle().html).toBe(bundle().html);
  });
});
