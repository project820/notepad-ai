/**
 * html-export-direct-prompt.ts — direct HTML/CSS authoring prompt builders
 * for the R1 redesign (PR-M1a / §5.14).
 *
 * Contrasts with the legacy `html-export-content-prompt.ts` JSON content model:
 * the model authors a COMPLETE self-contained HTML document (or outline /
 * section fragment), never a ContentModel. Config fields map 1:1 into the
 * prompt. Source-coverage metadata proves the whole source is accounted for
 * with NO silent tail truncation.
 *
 * Pure module (no DOM / electron / node). Not wired into the live wizard.
 */

import type { DirectExportConfig } from '../shared/html-export-direct-config';
import { resolveSummaryChartPolicy } from './html-export-model';

/** design.md is clamped so the prompt stays bounded (matches legacy). */
const DESIGN_CHARS = 8000;
/** userRequest free-text clamp. */
const USER_REQUEST_CHARS = 4000;

/**
 * Signature string used to recognize a direct-authoring HTML-export request.
 * Instructs COMPLETE self-contained HTML/CSS authoring — NEVER a JSON content
 * model (contrast with `HTML_EXPORT_CONTENT_INSTRUCTIONS`).
 */
export const HTML_EXPORT_DIRECT_INSTRUCTIONS =
  'You are a direct HTML/CSS author for a self-contained HTML export. You author a COMPLETE, self-contained HTML document with inline CSS — never a JSON content model, never Markdown, never code fences, never a ContentModel, never work narration, never a file path, and never a claim that you wrote a file. A main-process pipeline sanitizes and validates your output before it is saved; non-HTML answers are rejected.';

/** Frozen 30k single-pass source boundary (§5.14 / AC-M1a). */
export const SINGLE_PASS_SOURCE_LIMIT = 30_000;

export type SourceCoverage = {
  totalChars: number;
  coveredChars: number;
  coveredRanges: ReadonlyArray<{ start: number; end: number }>;
  complete: boolean;
  withinSinglePass: boolean;
};

function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}

function purposeLine(purpose: DirectExportConfig['purpose']): string {
  switch (purpose) {
    case 'presentation':
      return 'purpose: PRESENTATION (a slide deck for live delivery)';
    case 'document':
      return 'purpose: DOCUMENT (a long-form readable document)';
    case 'report':
      return 'purpose: REPORT (a structured analytical report)';
    case 'landing':
      return 'purpose: LANDING (a single-page marketing / landing page)';
  }
}

function orientationLine(orientation: DirectExportConfig['orientation']): string {
  return orientation === 'landscape'
    ? 'orientation: LANDSCAPE (wide / horizontal aspect)'
    : 'orientation: PORTRAIT (tall / vertical aspect)';
}

function modeLine(mode: DirectExportConfig['mode']): string {
  return mode === 'slide'
    ? 'mode: SLIDE (paginated deck; one screen = one slide)'
    : 'mode: SCROLL (one vertically-scrolling page; vertical scroll only, never horizontal)';
}

function densityLine(density: DirectExportConfig['density']): string {
  switch (density) {
    case 'minimal':
      return 'density: MINIMAL (sparse, high whitespace, one primary claim per unit)';
    case 'balanced':
      return 'density: BALANCED (moderate density, readable hierarchy)';
    case 'full':
      return 'density: FULL (dense, preserve detail and evidence)';
  }
}

/**
 * Embed every config field 1:1 as an explicit directive block.
 * design.md is the visual authority when present; designId is recorded for provenance.
 */
function configDirectiveLines(config: DirectExportConfig): string[] {
  const lines: string[] = [
    '=== EXPORT CONFIG (honor every directive 1:1) ===',
    `- ${purposeLine(config.purpose)}`,
    `- ${orientationLine(config.orientation)}`,
    `- ${modeLine(config.mode)}`,
    `- ${densityLine(config.density)}`,
  ];

  if (config.customPurpose) {
    lines.push(`- custom purpose brief (weight heavily): ${config.customPurpose}`);
  }

  if (config.summaryChartMode) {
    const policy = resolveSummaryChartPolicy(config.summaryChartMode);
    lines.push(
      `- summary/chart strength: ${policy.mode} (${policy.label})`,
      `- summarization directive: ${policy.summarization}`,
      `- chart directive: ${policy.chartPolicy}`,
    );
  }

  if (config.readableWidth) {
    lines.push(`- readable width: ${config.readableWidth.toUpperCase()} reading measure`);
  }

  if (typeof config.interactive === 'boolean') {
    lines.push(
      config.interactive
        ? '- interactivity: allow tasteful CSS-only interactions (no JavaScript)'
        : '- interactivity: static document only (no interactive affordances)',
    );
  }

  if (config.designId) {
    lines.push(`- designId: ${config.designId}`);
  }

  if (config.model) {
    lines.push(`- model: ${config.model}`);
  }

  const designMd = (config.designMd ?? '').trim();
  if (designMd) {
    lines.push(
      '',
      'DESIGN AUTHORITY (design.md — its PHILOSOPHY, layout language, and visual system are mandatory; author HTML/CSS that faithfully realizes them):',
      '"""',
      clamp(designMd, DESIGN_CHARS),
      '"""',
    );
  } else if (config.designId) {
    lines.push(
      '',
      `DESIGN AUTHORITY: designId "${config.designId}" is selected; apply its known visual system faithfully.`,
    );
  }

  const userRequest = (config.userRequest ?? '').trim();
  if (userRequest) {
    lines.push(
      '',
      'USER REQUEST (free text — weight this heavily):',
      '"""',
      clamp(userRequest, USER_REQUEST_CHARS),
      '"""',
    );
  }

  return lines;
}

/**
 * Direct-authoring design guidance. Adapted from the content-design principles
 * but framed for THIS path — the model authors HTML/CSS directly, so it MUST NOT
 * carry the legacy JSON-content-model rule that forbids encoding HTML/CSS.
 */
const HTML_EXPORT_DIRECT_DESIGN_KNOWLEDGE = [
  'DIRECT AUTHORING DESIGN GUIDE:',
  '1. Classify the screen by reader task (narrative/marketing, report/dashboard, article/reference, instruction, or command) and turn the source into jobs — introduce, explain, substantiate, compare, decide, orient, retain — sequenced for that job, not for fashion.',
  '2. Preserve the source reading order and distinguish titles, prose, lists, tables, quotations, code, and data with real semantic HTML; keep evidence adjacent to its claim.',
  '3. Name the layout problem (flow, repetition, comparison, or primary/supporting context) and choose HTML structure + CSS that solves it: restrained flow for explanation, parallel items for repeated facts, tables for comparison.',
  '4. Author complete, self-contained HTML with inline CSS — no scripts, no external fonts/assets. IMAGES: an <img> src may ONLY be an app-issued opaque asset ID (src="asset:…") explicitly listed in this prompt; NEVER emit data: URIs, remote URLs, or invented images. When no asset ID is provided, author without <img> and express any decoration in CSS. Every visual choice — layout, spacing, color, type scale — is yours to encode in CSS, honoring the design authority above.',
  '5. Use only LITERAL CSS values. CSS custom properties (`--name`) and `var()` are NOT supported and will be rejected — write concrete values inline. Global element selectors (html/body/:root/*) are allowed (scoped to the export content root) but prefer authoring styles against document content.',
  '6. Use ONLY the supported HTML tag vocabulary (structural: section, article, main, aside, nav, header, footer, div, h1–h6, p, ul/ol/li, dl/dt/dd, figure/figcaption, blockquote, table/thead/tbody/tfoot/tr/th/td/caption, img/picture/source, svg; inline: span, strong/em/b/i/u/s, small, mark, sub/sup, code/pre/kbd/samp, abbr, time, a, br, hr). Attach classes, ids, and inline styles ONLY to these tags — unsupported tags are unwrapped and their attributes dropped, which orphans any CSS that targets them.',
].join('\n');

function designKnowledgeBlock(): string[] {
  return ['=== DIRECT AUTHORING DESIGN KNOWLEDGE ===', HTML_EXPORT_DIRECT_DESIGN_KNOWLEDGE];
}

function fullSourceCoverage(source: string, limit: number): SourceCoverage {
  const totalChars = source.length;
  return {
    totalChars,
    coveredChars: totalChars,
    coveredRanges: [{ start: 0, end: totalChars }],
    complete: true,
    withinSinglePass: totalChars <= limit,
  };
}

/**
 * Build one direct-authoring prompt for the WHOLE source.
 *
 * Embeds every config field 1:1, the direct HTML/CSS instruction, and the FULL
 * source (never truncated). Coverage always records the entire source range;
 * when source exceeds the single-pass limit, `withinSinglePass` is false so the
 * caller routes to outline+sections — this function NEVER silently drops the tail.
 */
export function buildDirectHtmlPrompt(
  config: DirectExportConfig,
  source: string,
  opts?: { singlePassLimit?: number },
): { prompt: string; coverage: SourceCoverage } {
  // A per-model budget may only TIGHTEN the single-pass window, never raise it
  // above the frozen 30k ceiling: this direct path has no outline/batch fallback
  // (that is deferred), so a source over SINGLE_PASS_SOURCE_LIMIT must still trip
  // the fail-fast within-single-pass gate even for a large-context model.
  const limit =
    typeof opts?.singlePassLimit === 'number' && opts.singlePassLimit > 0
      ? Math.min(Math.floor(opts.singlePassLimit), SINGLE_PASS_SOURCE_LIMIT)
      : SINGLE_PASS_SOURCE_LIMIT;
  const body = typeof source === 'string' ? source : '';
  const coverage = fullSourceCoverage(body, limit);

  const lines: string[] = [
    HTML_EXPORT_DIRECT_INSTRUCTIONS,
    '',
    '=== EXPORT REQUEST ===',
    'Author a COMPLETE, self-contained HTML document with inline CSS that re-expresses the SOURCE DOCUMENT below.',
    'Output ONLY the HTML document. Do NOT output a JSON content model, ContentModel, Markdown, prose commentary, tool narration, temp/file paths, or code fences.',
    'Do NOT use tools, write files, or describe steps. Your sole response must be the HTML document itself.',
    'A main-process pipeline will sanitize and validate your HTML before it is saved; narration is rejected as failure.',
    '',
    ...configDirectiveLines(config),
    '',
    ...designKnowledgeBlock(),
    '',
    'AUTHORING RULES:',
    '- Output a single complete HTML document (doctype, html, head with inline <style>, body).',
    '- NEVER return a JSON content model or ContentModel — that path is obsolete for this request.',
    '- NEVER wrap the document in Markdown code fences.',
    '- NEVER narrate progress, write files, or return a path instead of the document.',
    '- NEVER include conversational preamble, acknowledgements, closing remarks, or narration (no "Sure, here is...", no "I hope this helps"), whether bare text or wrapped in an element.',
    '- Honor orientation, mode, density, and purpose exactly as directed above.',
    '- Treat design.md as visual authority when present; realize its hierarchy, mood, and signature elements in HTML/CSS.',
    '- Preserve critical facts, numbers, names, quotes, and code from the source.',
    '- Self-contained only: inline CSS, no external stylesheets, no remote scripts, no network fetches.',
    '- Images: an <img> src may ONLY be an app-issued asset ID (src="asset:…") explicitly provided in this prompt; never data: URIs, never remote or relative URLs. No provided asset IDs means no <img> elements.',
    '',
    'SOURCE DOCUMENT (Markdown — full text; do not omit any portion):',
    '"""',
    body,
    '"""',
  ];

  return { prompt: lines.join('\n'), coverage };
}

/**
 * Build an outline prompt for sources that exceed the single-pass boundary.
 * Asks for a STRUCTURED OUTLINE with ordered sections, stable ids, and
 * source_md_range [start,end] covering the whole source. Coverage is complete.
 */
export function buildOutlinePrompt(
  config: DirectExportConfig,
  source: string,
): { prompt: string; coverage: SourceCoverage } {
  const body = typeof source === 'string' ? source : '';
  const coverage = fullSourceCoverage(body, SINGLE_PASS_SOURCE_LIMIT);

  const lines: string[] = [
    HTML_EXPORT_DIRECT_INSTRUCTIONS,
    '',
    '=== OUTLINE REQUEST ===',
    'The source exceeds the single-pass direct-authoring boundary. Produce a STRUCTURED OUTLINE for subsequent section-by-section direct HTML authoring.',
    'Do NOT author the full HTML document yet. Do NOT return a JSON ContentModel of blocks.',
    '',
    ...configDirectiveLines(config),
    '',
    ...designKnowledgeBlock(),
    '',
    'OUTLINE RULES:',
    '- Return a structured outline only (not full HTML, not a content-model JSON of blocks).',
    '- Ordered sections covering the WHOLE source with no gaps and no silent tail truncation.',
    '- Each section MUST have: a stable id, a title, and a source_md_range [start, end) of character offsets into the SOURCE DOCUMENT.',
    '- The union of all source_md_range values MUST cover [0, source.length] completely.',
    '- Section boundaries should follow natural document structure (headings, major topics).',
    '- Keep section titles concise and useful for later direct HTML authoring of that slice.',
    '',
    'SOURCE DOCUMENT (Markdown — full text; ranges are character offsets into this string):',
    '"""',
    body,
    '"""',
  ];

  return { prompt: lines.join('\n'), coverage };
}

/**
 * Build a section-authoring prompt for ONE outline section.
 * Uses ONLY the section's source slice; coverage records exactly that range.
 */
export function buildSectionPrompt(
  config: DirectExportConfig,
  section: { id: string; title: string; sourceRange: { start: number; end: number } },
  source: string,
): { prompt: string; coverage: SourceCoverage } {
  const body = typeof source === 'string' ? source : '';
  const totalChars = body.length;
  const start = Math.max(0, Math.floor(section.sourceRange.start));
  const end = Math.max(start, Math.floor(section.sourceRange.end));
  const clampedEnd = Math.min(end, totalChars);
  const clampedStart = Math.min(start, clampedEnd);
  const slice = body.slice(clampedStart, clampedEnd);
  const rangeInBounds = section.sourceRange.start >= 0 && section.sourceRange.end <= totalChars
    && section.sourceRange.start <= section.sourceRange.end;

  const coverage: SourceCoverage = {
    totalChars,
    coveredChars: clampedEnd - clampedStart,
    coveredRanges: [{ start: clampedStart, end: clampedEnd }],
    complete: rangeInBounds,
    withinSinglePass: totalChars <= SINGLE_PASS_SOURCE_LIMIT,
  };

  const lines: string[] = [
    HTML_EXPORT_DIRECT_INSTRUCTIONS,
    '',
    '=== SECTION AUTHORING REQUEST ===',
    `Author ONE HTML fragment for section "${section.title}" (id: ${section.id}).`,
    'Use ONLY the SECTION SOURCE slice below. Do not invent content from outside this range.',
    'Output ONLY the HTML fragment for this section (not a full document shell unless the section itself requires one).',
    'Do NOT output a JSON content model, ContentModel, Markdown, or code fences.',
    '',
    ...configDirectiveLines(config),
    '',
    ...designKnowledgeBlock(),
    '',
    'SECTION META:',
    `- id: ${section.id}`,
    `- title: ${section.title}`,
    `- source_md_range: [${section.sourceRange.start}, ${section.sourceRange.end})`,
    '',
    'AUTHORING RULES:',
    '- Author HTML/CSS for this section only, consistent with purpose/orientation/mode/density and design authority.',
    '- NEVER return a JSON content model or ContentModel.',
    '- Preserve facts from the section source; do not silently drop material in this range.',
    '- Self-contained styling preferences: inline styles or classes that compose with a later shell.',
    '- Images: an <img> src may ONLY be an app-issued asset ID (src="asset:…") explicitly provided in this prompt; never data: URIs, never remote or relative URLs. No provided asset IDs means no <img> elements.',
    '',
    'SECTION SOURCE (Markdown slice for this section only):',
    '"""',
    slice,
    '"""',
  ];

  return { prompt: lines.join('\n'), coverage };
}
