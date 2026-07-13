/**
 * html-export-content-prompt.ts — builds the SINGLE prompt block that turns the
 * source document + all wizard selections into a bounded JSON ContentModel
 * (G001). The AI returns CONTENT ONLY (summary/structure/chart specs) as JSON;
 * it never authors HTML/CSS/JS — the deterministic engine owns all layout.
 *
 * Every selection (orientation, layout, design, mode, free requirement) is
 * embedded in one canonical EXPORT REQUEST block so the choice provably reaches
 * the model; the deterministic renderer + manifest then prove it reached output.
 *
 * Pure module (no DOM/electron/node).
 */

import {
  resolveSummaryChartPolicy,
  type HtmlExportRequest,
} from './html-export-model';
import { HTML_EXPORT_DESIGN_KNOWLEDGE } from './html-export-design-knowledge';

/** design.md is clamped so the prompt stays bounded. */
const DESIGN_CHARS = 8000;
/** Default source-markdown cap; the caller passes a model-sized budget. */
const DEFAULT_MAX_SOURCE_CHARS = 200_000;
const TRUNCATION_MARKER = '\n\n<!-- NOTE: source truncated here for length. -->';

export type BuiltContentPrompt = {
  prompt: string;
  truncated: boolean;
  warning: boolean;
};

/**
 * Signature string used by output-budget detection to recognize an HTML-export
 * generation request. Kept stable + searched by `isHtmlExportInstructions`.
 */
export const HTML_EXPORT_CONTENT_INSTRUCTIONS =
  'You are a document content architect for a self-contained HTML export. You output ONLY a JSON content model — never HTML, CSS, JavaScript, Markdown, or code fences. A deterministic local engine renders, paginates, scales, and themes your content so it always fits the chosen layout.';

function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}

function orientationLine(o: HtmlExportRequest['orientation']): string {
  return o === 'vertical'
    ? 'orientation: VERTICAL (portrait aspect)'
    : 'orientation: HORIZONTAL (landscape aspect)';
}

function layoutLine(l: HtmlExportRequest['layout']): string {
  return l === 'slides'
    ? 'layout: SLIDES (a deck; one screen = one slide; content is paginated to fit)'
    : 'layout: SCROLL (one vertically-scrolling page; vertical scroll only, never horizontal)';
}

/** The strict JSON schema the model must follow (documented inline for the LLM). */
const JSON_SCHEMA = `Return ONE JSON object, no prose, no code fence, matching:
{
  "title": string,
  "sections": [
    {
      "title"?: string,
      "kicker"?: string,
      "blocks": [
        { "kind": "kicker", "text": string }
      | { "kind": "heading", "level": 1|2|3|4, "text": string }
      | { "kind": "paragraph", "text": string }
      | { "kind": "list", "ordered": boolean, "items": string[] }
      | { "kind": "table", "headers": string[], "rows": string[][] }
      | { "kind": "code", "language"?: string, "code": string }
      | { "kind": "quote", "text": string }
      | { "kind": "callout", "tone"?: string, "text": string }
      | { "kind": "chart", "chart": { "type": "bar"|"line"|"pie"|"donut"|"timeline", "title"?: string, "labels": string[], "series": [{ "name"?: string, "values": number[] }], "unit"?: string, "note"?: string } }
      ]
    }
  ]
}`;

/**
 * Build the single content-model prompt. Returns the prompt plus whether the
 * source was long enough to warrant a warning / was hard-truncated.
 */
export function buildHtmlExportContentPrompt(
  req: HtmlExportRequest,
  opts?: { maxSourceChars?: number },
): BuiltContentPrompt {
  const markdown = typeof req.markdown === 'string' ? req.markdown : '';
  const maxSourceChars =
    typeof opts?.maxSourceChars === 'number' && opts.maxSourceChars > 0
      ? Math.floor(opts.maxSourceChars)
      : DEFAULT_MAX_SOURCE_CHARS;
  const warning = markdown.length > Math.floor(maxSourceChars * 0.85);
  let body = markdown;
  let truncated = false;
  if (markdown.length > maxSourceChars) {
    body = markdown.slice(0, maxSourceChars) + TRUNCATION_MARKER;
    truncated = true;
  }

  const policy = resolveSummaryChartPolicy(req.summaryChartMode);
  const designMd = (req.designMd ?? '').trim();
  const freeRequirement = (req.freeRequirement ?? '').trim();

  const lines: string[] = [
    HTML_EXPORT_CONTENT_INSTRUCTIONS,
    '',
    '=== EXPORT REQUEST ===',
    'Produce a JSON content model that re-expresses the SOURCE DOCUMENT below for an HTML export.',
    '',
    'SELECTIONS (honor every one):',
    `- ${orientationLine(req.orientation)}`,
    `- ${layoutLine(req.layout)}`,
    `- design source: ${req.designSource}`,
    `- summary/chart mode: ${policy.mode} (${policy.label})`,
    `  - summarization: ${policy.summarization}`,
    `  - charts: ${policy.chartPolicy}`,
    '',
    '=== CONTENT DESIGN KNOWLEDGE ===',
    HTML_EXPORT_DESIGN_KNOWLEDGE,
    '',
    'CONTENT RULES:',
    '- Output ONLY the JSON object. No HTML, CSS, JS, Markdown, prose, or code fences.',
    '- You write CONTENT, not layout. Do NOT set sizes, colors, positions, or markup — the engine does layout, theme, pagination, and scaling so content always fits the chosen layout.',
    '- Preserve critical facts, numbers, names, quotes, and code per the summary mode. The original document is the source of truth; the HTML is a readable, summarized/visualized view.',
    '- Convert data-bearing tables/series into chart blocks per the chart policy; keep tables when a chart would lose fidelity.',
    '- Group related content into sections with optional kicker/title.',
  ];

  if (freeRequirement) {
    lines.push(
      '',
      'USER REQUIREMENT (free text — weight this heavily):',
      '"""',
      clamp(freeRequirement, 4000),
      '"""',
    );
  }

  if (designMd) {
    lines.push(
      '',
      'DESIGN SYSTEM (design.md — its PHILOSOPHY is mandatory; the engine applies it as a theme, you only structure content to suit it):',
      '"""',
      clamp(designMd, DESIGN_CHARS),
      '"""',
    );
  }

  lines.push('', 'OUTPUT SCHEMA:', JSON_SCHEMA);
  lines.push('', 'SOURCE DOCUMENT (Markdown):', '"""', body, '"""');

  return { prompt: lines.join('\n'), truncated, warning };
}
