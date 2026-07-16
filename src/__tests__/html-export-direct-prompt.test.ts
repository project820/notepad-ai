import { describe, it, expect } from 'vitest';
import {
  PURPOSE_DEFAULTS,
  resolveDirectExportConfig,
  type DirectExportPurpose,
} from '../shared/html-export-direct-config';
import {
  HTML_EXPORT_DIRECT_INSTRUCTIONS,
  SINGLE_PASS_SOURCE_LIMIT,
  buildDirectHtmlPrompt,
  buildOutlinePrompt,
  buildSectionPrompt,
} from '../renderer/html-export-direct-prompt';

const PURPOSES: DirectExportPurpose[] = ['presentation', 'document', 'report', 'landing'];

describe('resolveDirectExportConfig — purpose defaults + overrides', () => {
  it('applies each purpose default exactly', () => {
    for (const purpose of PURPOSES) {
      const cfg = resolveDirectExportConfig({ purpose });
      expect(cfg.purpose).toBe(purpose);
      expect(cfg.orientation).toBe(PURPOSE_DEFAULTS[purpose].orientation);
      expect(cfg.mode).toBe(PURPOSE_DEFAULTS[purpose].mode);
      expect(cfg.density).toBe(PURPOSE_DEFAULTS[purpose].density);
    }
  });

  it('locks the frozen default table', () => {
    expect(PURPOSE_DEFAULTS.presentation).toEqual({
      orientation: 'landscape',
      mode: 'slide',
      density: 'minimal',
    });
    expect(PURPOSE_DEFAULTS.document).toEqual({
      orientation: 'portrait',
      mode: 'scroll',
      density: 'full',
    });
    expect(PURPOSE_DEFAULTS.report).toEqual({
      orientation: 'portrait',
      mode: 'scroll',
      density: 'balanced',
    });
    expect(PURPOSE_DEFAULTS.landing).toEqual({
      orientation: 'portrait',
      mode: 'scroll',
      density: 'minimal',
    });
  });

  it('honors explicit orientation / mode / density overrides', () => {
    const cfg = resolveDirectExportConfig({
      purpose: 'presentation',
      orientation: 'portrait',
      mode: 'scroll',
      density: 'full',
    });
    expect(cfg).toEqual({
      purpose: 'presentation',
      orientation: 'portrait',
      mode: 'scroll',
      density: 'full',
    });
  });

  it('passes through designId / designMd / userRequest / model', () => {
    const cfg = resolveDirectExportConfig({
      purpose: 'report',
      designId: 'dark-editorial',
      designMd: '# tokens',
      userRequest: 'Make it skimmable',
      model: 'claude-sonnet',
    });
    expect(cfg.designId).toBe('dark-editorial');
    expect(cfg.designMd).toBe('# tokens');
    expect(cfg.userRequest).toBe('Make it skimmable');
    expect(cfg.model).toBe('claude-sonnet');
    expect(cfg.orientation).toBe('portrait');
    expect(cfg.mode).toBe('scroll');
    expect(cfg.density).toBe('balanced');
  });

  it('is deterministic for identical input', () => {
    const input = {
      purpose: 'landing' as const,
      orientation: 'landscape' as const,
      designMd: 'x',
      userRequest: 'y',
    };
    expect(resolveDirectExportConfig(input)).toEqual(resolveDirectExportConfig(input));
  });
});

describe('HTML_EXPORT_DIRECT_INSTRUCTIONS — forbids JSON / ContentModel', () => {
  it('directs complete self-contained HTML/CSS authoring', () => {
    expect(HTML_EXPORT_DIRECT_INSTRUCTIONS).toMatch(/COMPLETE/i);
    expect(HTML_EXPORT_DIRECT_INSTRUCTIONS).toMatch(/self-contained HTML/i);
    expect(HTML_EXPORT_DIRECT_INSTRUCTIONS).toMatch(/inline CSS/i);
  });

  it('explicitly forbids JSON content model / ContentModel', () => {
    expect(HTML_EXPORT_DIRECT_INSTRUCTIONS).toMatch(/never a JSON content model/i);
    expect(HTML_EXPORT_DIRECT_INSTRUCTIONS).toMatch(/ContentModel/i);
    expect(HTML_EXPORT_DIRECT_INSTRUCTIONS).not.toMatch(/output ONLY a JSON/i);
  });

  it('forbids work narration / file-writing answers (issue #27)', () => {
    expect(HTML_EXPORT_DIRECT_INSTRUCTIONS).toMatch(/never work narration/i);
    expect(HTML_EXPORT_DIRECT_INSTRUCTIONS).toMatch(/never a file path/i);
    expect(HTML_EXPORT_DIRECT_INSTRUCTIONS).toMatch(/non-HTML answers are rejected/i);
  });
});

describe('buildDirectHtmlPrompt — 1:1 config mapping + full source', () => {
  const source = '# Title\n\nBody paragraph with facts 42 and names.';

  it('embeds every config field 1:1 and the direct instructions', () => {
    const config = resolveDirectExportConfig({
      purpose: 'document',
      designId: 'getdesign/dark',
      designMd: '# Dark editorial\nAccent: #c3d9f3',
      userRequest: 'Make it skimmable for an executive',
      model: 'gpt-5',
    });
    const { prompt, coverage } = buildDirectHtmlPrompt(config, source);

    expect(prompt).toContain(HTML_EXPORT_DIRECT_INSTRUCTIONS);
    expect(prompt).toMatch(/Do NOT use tools, write files, or describe steps/i);
    expect(prompt).toMatch(/NEVER narrate progress, write files, or return a path/i);
    expect(prompt).toContain('DIRECT AUTHORING DESIGN GUIDE');
    expect(prompt).toMatch(/Use ONLY the supported HTML tag vocabulary/i);
    expect(prompt).toMatch(/unsupported tags are unwrapped/i);
    expect(prompt).toMatch(/\bmain\b/);
    expect(prompt).toMatch(/\baside\b/);
    expect(prompt).toMatch(/conversational preamble/i);
    expect(prompt).toMatch(/Sure, here is/i);
    expect(prompt).toMatch(/I hope this helps/i);
    expect(prompt).toMatch(/whether bare text or wrapped in an element/i);
    // Image contract (aligned with main #31): an <img> src may ONLY be an app-issued
    // opaque asset ID (asset:…); data: URIs and remote/relative URLs are forbidden, and
    // with no asset IDs provided the model must emit no <img>. The sanitizer enforces the
    // asset: src policy, so the prompt must state it and must NOT promise data: images.
    expect(prompt).toMatch(/asset:/i);
    expect(prompt).toMatch(/only.{0,40}asset ID/i);
    expect(prompt).toMatch(/never.{0,40}data: URIs|NEVER emit data:/i);
    expect(prompt).not.toMatch(/inline data: images/i);
    expect(prompt).toMatch(/CSS font-size.*font shorthand size.*px.*0.*absolute keywords/i);
    expect(prompt).toMatch(/Never rem, em, or % for font size/i);
    // The legacy content-model guidance that forbids encoding HTML/CSS must NOT
    // appear in a direct-authoring prompt (AC-M1a contradiction guard).
    expect(prompt).not.toMatch(/never encode CSS, HTML/i);
    expect(prompt).not.toMatch(/Output only content structure/i);
    expect(prompt).toMatch(/purpose: DOCUMENT/i);
    expect(prompt).toMatch(/orientation: PORTRAIT/i);
    expect(prompt).toMatch(/mode: SCROLL/i);
    expect(prompt).toMatch(/density: FULL/i);
    expect(prompt).toContain('designId: getdesign/dark');
    expect(prompt).toContain('model: gpt-5');
    expect(prompt).toContain('# Dark editorial');
    expect(prompt).toContain('Accent: #c3d9f3');
    expect(prompt).toContain('Make it skimmable for an executive');
    expect(prompt).toContain(source);
    expect(prompt).toMatch(/never a JSON content model|NEVER return a JSON content model/i);
    expect(prompt).toMatch(/ContentModel/);

    expect(coverage.totalChars).toBe(source.length);
    expect(coverage.coveredChars).toBe(source.length);
    expect(coverage.coveredRanges).toEqual([{ start: 0, end: source.length }]);
    expect(coverage.complete).toBe(true);
    expect(coverage.withinSinglePass).toBe(true);
  });

  it('includes the full source verbatim with no truncation marker', () => {
    const longish = 'alpha '.repeat(100) + 'TAIL_MARKER_XYZ';
    const config = resolveDirectExportConfig({ purpose: 'report' });
    const { prompt, coverage } = buildDirectHtmlPrompt(config, longish);
    expect(prompt).toContain(longish);
    expect(prompt).toContain('TAIL_MARKER_XYZ');
    expect(prompt).not.toContain('source truncated here');
    expect(coverage.complete).toBe(true);
    expect(coverage.coveredChars).toBe(longish.length);
  });

  it('is deterministic for identical input', () => {
    const config = resolveDirectExportConfig({
      purpose: 'landing',
      userRequest: 'clean',
      designMd: '## brand',
    });
    const a = buildDirectHtmlPrompt(config, source);
    const b = buildDirectHtmlPrompt(config, source);
    expect(a.prompt).toBe(b.prompt);
    expect(a.coverage).toEqual(b.coverage);
  });
});

describe('buildDirectHtmlPrompt — 30k single-pass boundary + no silent truncation', () => {
  it('sets withinSinglePass true at exactly the limit', () => {
    const source = 'x'.repeat(SINGLE_PASS_SOURCE_LIMIT);
    expect(source.length).toBe(SINGLE_PASS_SOURCE_LIMIT);
    const config = resolveDirectExportConfig({ purpose: 'document' });
    const { prompt, coverage } = buildDirectHtmlPrompt(config, source);

    expect(coverage.withinSinglePass).toBe(true);
    expect(coverage.complete).toBe(true);
    expect(coverage.totalChars).toBe(SINGLE_PASS_SOURCE_LIMIT);
    expect(coverage.coveredChars).toBe(SINGLE_PASS_SOURCE_LIMIT);
    expect(coverage.coveredRanges).toEqual([{ start: 0, end: SINGLE_PASS_SOURCE_LIMIT }]);
    expect(prompt).toContain(source);
    expect(prompt.length).toBeGreaterThan(source.length);
  });

  it('sets withinSinglePass false at limit+1 while coverage stays complete', () => {
    const source = 'y'.repeat(SINGLE_PASS_SOURCE_LIMIT + 1);
    expect(source.length).toBe(SINGLE_PASS_SOURCE_LIMIT + 1);
    const config = resolveDirectExportConfig({ purpose: 'presentation' });
    const { prompt, coverage } = buildDirectHtmlPrompt(config, source);

    expect(coverage.withinSinglePass).toBe(false);
    expect(coverage.complete).toBe(true);
    expect(coverage.totalChars).toBe(SINGLE_PASS_SOURCE_LIMIT + 1);
    expect(coverage.coveredChars).toBe(SINGLE_PASS_SOURCE_LIMIT + 1);
    expect(coverage.coveredRanges).toEqual([{ start: 0, end: SINGLE_PASS_SOURCE_LIMIT + 1 }]);
    // Full source still embedded — no silent tail drop.
    expect(prompt).toContain(source);
    expect(prompt.endsWith('"""') || prompt.includes(source + '\n"""')).toBe(true);
    expect(prompt).not.toContain('source truncated here');
  });

  it('respects an explicit singlePassLimit override', () => {
    const source = 'z'.repeat(50);
    const config = resolveDirectExportConfig({ purpose: 'report' });
    const under = buildDirectHtmlPrompt(config, source, { singlePassLimit: 50 });
    const over = buildDirectHtmlPrompt(config, source, { singlePassLimit: 49 });
    expect(under.coverage.withinSinglePass).toBe(true);
    expect(over.coverage.withinSinglePass).toBe(false);
    expect(under.coverage.complete).toBe(true);
    expect(over.coverage.complete).toBe(true);
    expect(under.prompt).toContain(source);
    expect(over.prompt).toContain(source);
  });

  it('clamps a per-model singlePassLimit to the frozen 30k ceiling (never raises it)', () => {
    // A large-context model budget must NOT lift the single-pass window above
    // SINGLE_PASS_SOURCE_LIMIT: this direct path has no outline/batch fallback,
    // so a >30k source still trips the fail-fast gate.
    const source = 'q'.repeat(SINGLE_PASS_SOURCE_LIMIT + 1);
    const config = resolveDirectExportConfig({ purpose: 'document' });
    const huge = buildDirectHtmlPrompt(config, source, { singlePassLimit: SINGLE_PASS_SOURCE_LIMIT + 500_000 });
    expect(huge.coverage.withinSinglePass).toBe(false);
    expect(huge.coverage.complete).toBe(true);
    expect(huge.prompt).toContain(source);
    // A smaller per-model budget still tightens below the ceiling.
    const tight = buildDirectHtmlPrompt(config, 'q'.repeat(60), { singlePassLimit: 50 });
    expect(tight.coverage.withinSinglePass).toBe(false);
  });
});

describe('buildOutlinePrompt — whole-source coverage + stable ids + ranges', () => {
  it('covers the whole source and asks for stable ids + source_md_range', () => {
    const source = '# A\n\n## B\n\nbody';
    const config = resolveDirectExportConfig({
      purpose: 'document',
      designMd: '## system',
      userRequest: 'keep structure',
    });
    const { prompt, coverage } = buildOutlinePrompt(config, source);

    expect(prompt).toContain(HTML_EXPORT_DIRECT_INSTRUCTIONS);
    expect(prompt).toMatch(/STRUCTURED OUTLINE/i);
    expect(prompt).toMatch(/stable id/i);
    expect(prompt).toMatch(/source_md_range/i);
    expect(prompt).toMatch(/purpose: DOCUMENT/i);
    expect(prompt).toMatch(/orientation: PORTRAIT/i);
    expect(prompt).toMatch(/mode: SCROLL/i);
    expect(prompt).toMatch(/density: FULL/i);
    expect(prompt).toContain(source);
    expect(prompt).toContain('## system');
    expect(prompt).toContain('keep structure');
    expect(prompt).toMatch(/WHOLE source|no silent tail truncation/i);

    expect(coverage.complete).toBe(true);
    expect(coverage.totalChars).toBe(source.length);
    expect(coverage.coveredChars).toBe(source.length);
    expect(coverage.coveredRanges).toEqual([{ start: 0, end: source.length }]);
  });

  it('is deterministic', () => {
    const config = resolveDirectExportConfig({ purpose: 'report' });
    const source = 'outline-me';
    expect(buildOutlinePrompt(config, source)).toEqual(buildOutlinePrompt(config, source));
  });
});

describe('buildSectionPrompt — scopes to section range', () => {
  const source = 'AAAAABBBBBCCCCC'; // 0-5 A, 5-10 B, 10-15 C

  it('scopes the prompt to the section source slice and marks that range', () => {
    const config = resolveDirectExportConfig({ purpose: 'landing', density: 'balanced' });
    const section = { id: 'sec-b', title: 'Middle', sourceRange: { start: 5, end: 10 } };
    const { prompt, coverage } = buildSectionPrompt(config, section, source);

    expect(prompt).toContain(HTML_EXPORT_DIRECT_INSTRUCTIONS);
    expect(prompt).toContain('sec-b');
    expect(prompt).toContain('Middle');
    expect(prompt).toContain('source_md_range: [5, 10)');
    expect(prompt).toContain('BBBBB');
    expect(prompt).not.toContain('AAAAA');
    expect(prompt).not.toContain('CCCCC');
    expect(prompt).toMatch(/purpose: LANDING/i);
    expect(prompt).toMatch(/density: BALANCED/i);
    expect(prompt).toMatch(/NEVER return a JSON content model|never a JSON content model/i);

    expect(coverage.totalChars).toBe(source.length);
    expect(coverage.coveredChars).toBe(5);
    expect(coverage.coveredRanges).toEqual([{ start: 5, end: 10 }]);
    expect(coverage.complete).toBe(true);
  });

  it('marks complete false when the section range exceeds the source', () => {
    const config = resolveDirectExportConfig({ purpose: 'report' });
    const section = { id: 'overflow', title: 'Past end', sourceRange: { start: 10, end: 99 } };
    const { coverage, prompt } = buildSectionPrompt(config, section, source);
    expect(coverage.complete).toBe(false);
    expect(coverage.coveredRanges).toEqual([{ start: 10, end: source.length }]);
    expect(prompt).toContain('CCCCC');
  });
});

describe('design.md clamp', () => {
  it('bounds a design.md longer than the clamp in the prompt', () => {
    const longDesign = 'D'.repeat(12_000);
    const config = resolveDirectExportConfig({
      purpose: 'presentation',
      designMd: longDesign,
    });
    const { prompt } = buildDirectHtmlPrompt(config, 'short source');
    // Full 12k design must not appear; clamped form ends with ellipsis marker.
    expect(prompt).not.toContain(longDesign);
    expect(prompt).toContain('D'.repeat(8000));
    expect(prompt).toContain('\n…');
    // Source still fully present.
    expect(prompt).toContain('short source');
  });
});

describe('image directives — prompt must mirror the sanitizer asset-ID contract', () => {
  const config = resolveDirectExportConfig({ purpose: 'presentation' });
  const source = 'sample source';
  const section = { id: 'section-1', title: 'Intro', sourceRange: { start: 0, end: source.length } };

  const prompts = [
    buildDirectHtmlPrompt(config, source).prompt,
    buildOutlinePrompt(config, source).prompt,
    buildSectionPrompt(config, section, source).prompt,
  ];

  it('never instructs the model to use inline data: URI images', () => {
    for (const prompt of prompts) {
      expect(prompt).not.toMatch(/inline data: images/i);
      expect(prompt).not.toMatch(/use\s+(only\s+)?data:\s*(uri|url|image)/i);
    }
  });

  it('directs the app-issued asset-ID contract and forbids data:/remote URLs', () => {
    for (const prompt of prompts) {
      expect(prompt).toContain('src="asset:');
      expect(prompt).toMatch(/never\s+(emit\s+)?data:\s*URIs/i);
    }
  });

  it('authoring prompts instruct: no provided asset IDs means no <img>', () => {
    const authoring = [
      buildDirectHtmlPrompt(config, source).prompt,
      buildSectionPrompt(config, section, source).prompt,
    ];
    for (const prompt of authoring) {
      expect(prompt).toMatch(/no provided asset ids means no <img>/i);
    }
  });
});
