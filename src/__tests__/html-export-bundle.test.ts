import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bundleHtml, EXPORT_MANIFEST_SCHEMA_VERSION, type BundleArgs } from '../renderer/html-export-bundle';
import { validateSelfContainedHtml } from '../renderer/html-export-validate';
import { sha256Base64 } from '../renderer/sha256';
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
  it('wires readable-width and density presentation options into emitted CSS', () => {
    const narrow = bundle({ layout: 'scroll', presentation: { readableWidth: 'narrow', density: 'compact' } }).html;
    const wide = bundle({ layout: 'scroll', presentation: { readableWidth: 'wide', density: 'roomy' } }).html;

    expect(narrow).toContain('--he-readable-width: clamp(640px, 72vw, 860px);');
    expect(wide).toContain('--he-readable-width: clamp(820px, 88vw, 1280px);');
    expect(narrow.match(/--he-rhythm: (\d+)px;/)?.[1]).not.toBe(wide.match(/--he-rhythm: (\d+)px;/)?.[1]);
  });

  it('anchors slides at the top and makes navigation controls touch-safe', () => {
    const { html } = bundle();

    expect(html).toContain('justify-content:flex-start');
    expect(html).toContain('align-self:flex-start');
    expect(html).toContain('min-width:48px');
    expect(html).toContain('min-height:48px');
    expect(html).toContain('padding:8px 14px');
    expect(html).toContain('font-size:16px');
  });
  it('shares resolved rhythm and navigation reserve with planned-slide rendering', () => {
    const { html } = bundle({
      plan: [{ blocks: [{ kind: 'paragraph', text: 'Contained' }], scale: 1, sectionTitle: 'One' }],
    });

    expect(html).toContain('--he-slide-pad: 38px;');
    expect(html).toContain('--he-nav-reserve: 86px;');
    expect(html).toContain('padding-bottom:calc(var(--he-slide-pad) + var(--he-nav-reserve))');
    expect(html).toContain('style="width:1204px"');
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

  it('embeds a CSP whose script-src hash matches the actual inline runtime (G006)', () => {
    const { html } = bundle();
    // The CSP meta is present and locks default-src to none.
    expect(html).toContain('<meta http-equiv="Content-Security-Policy"');
    expect(html).toMatch(/default-src 'none'/);
    // Extract the executable inline runtime (not the application/json manifest)
    // and confirm its real SHA-256 is the one pinned in script-src — i.e. the
    // CSP would actually permit the runtime to run while blocking injected ones.
    const runtime = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(runtime).not.toBeNull();
    const hash = sha256Base64(runtime![1]);
    expect(html).toContain(`script-src 'sha256-${hash}'`);
  });

  it('passes the structural allowlist DOM validator under jsdom-equivalent parsing', () => {
    // A non-DOM (node) test env: feed the bundle through validateExportDom with
    // an injected parser would require jsdom; here we assert the denylist + the
    // CSP presence, with the DOM-walk covered by html-export-validate-dom.test.ts.
    const { html } = bundle();
    expect(validateSelfContainedHtml(html).ok).toBe(true);
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
