/**
 * html-export-prompt.ts — pure prompt/IO helpers for the HTML-export wizard (⑤).
 *
 * No DOM, no IPC: builds the generation prompt, extracts the HTML document from
 * an AI reply (stripping code fences), and computes the default save filename.
 * The output contract (single inline-CSS HTML5 doc, no remote/raster assets,
 * diagrams as inline SVG/CSS, all four orientation×layout combos) is spelled out
 * in the prompt so the AI has no leeway to insert remote network/raster content.
 */

import {
  type Density,
  type HtmlPurpose,
  type LayoutKind,
  type Orientation,
  type ReadableWidth,
  resolvePurposeConfig,
} from './html-export-state';

/** Default cap on source-markdown chars when the caller supplies no model-specific
 *  budget. Generous — sized for large context windows so normal documents are
 *  never truncated; the wizard passes a per-model budget at runtime. */
const DEFAULT_MAX_SOURCE_CHARS = 200_000;
/** DESIGN.md is clamped so the prompt stays bounded. */
const DESIGN_CHARS = 8000;
const TRUNCATION_MARKER = '\n\n<!-- NOTE: the source above was truncated here for length. -->';

/**
 * System instruction for HTML generation (shared by the renderer wizard, main's
 * IPC, and tests so there is one source of truth). Strengthened to push the
 * model toward polished, readable output (the common failure mode was excessive
 * whitespace / weak DESIGN.md adherence).
 */
export const HTML_EXPORT_INSTRUCTIONS =
  'You are an elite front-end engineer and visual designer. You output a single, complete, self-contained HTML5 document with inline CSS and no remote or raster assets. You strictly honor the supplied DESIGN SYSTEM and QUALITY BAR. Output only the HTML document — no Markdown and no code fences.';

/**
 * Bundled base stylesheet injected into every generated document as a safety
 * net BENEATH the model/design CSS (lowest-specificity element selectors only,
 * so a DESIGN.md aesthetic always overrides it). Guarantees a readable baseline
 * — sane typography, vertical rhythm, a bounded reading measure, and
 * non-overflowing media/tables — even when the model is lazy. No remote fonts.
 */
export const HTML_EXPORT_BASE_CSS = [
  '/* notepad-ai base — readable defaults; design CSS overrides these */',
  '*,*::before,*::after{box-sizing:border-box}',
  'html{-webkit-text-size-adjust:100%}',
  'body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;font-size:17px;line-height:1.65;color:#1c1a17;background:#fff;-webkit-font-smoothing:antialiased}',
  'main,article,.content,.container{max-width:72ch;margin-inline:auto;padding:clamp(20px,4vw,40px)}',
  'h1,h2,h3,h4{line-height:1.2;font-weight:700;margin:1.6em 0 0.6em}',
  'h1{font-size:2em}h2{font-size:1.5em}h3{font-size:1.25em}',
  'p,ul,ol,blockquote,table,pre{margin:0 0 1em}',
  'li{margin:0.25em 0}',
  'a{color:#0b66c3}',
  'img,svg,video{max-width:100%;height:auto}',
  'table{border-collapse:collapse;width:100%}th,td{border:1px solid #e2ddd5;padding:8px 10px;text-align:left}',
  'pre{overflow:auto;padding:14px 16px;background:#f6f3ee;border-radius:8px}',
  'code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:0.92em}',
  'blockquote{padding-left:1em;border-left:3px solid #e2ddd5;color:#5b554d}',
].join('');

export type BuiltHtmlExportPrompt = {
  promptDoc: string;
  truncated: boolean;
  warning: boolean;
};

function orientationLine(orientation: Orientation): string {
  return orientation === 'vertical'
    ? 'Orientation: VERTICAL — portrait, taller than wide, top-to-bottom reading flow.'
    : 'Orientation: HORIZONTAL — landscape, wider than tall, left-to-right reading flow.';
}

function layoutLine(layout: LayoutKind): string {
  return layout === 'slides'
    ? 'Layout: SLIDES — a real on-screen presentation DECK, not a scrolling page. Exactly ONE slide fills the viewport at a time and every other slide is hidden; the page body itself MUST NOT scroll. You MUST implement slide navigation (see SLIDE NAVIGATION).'
    : 'Layout: SCROLL — a single continuously scrolling page with clear section rhythm.';
}

function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}

/**
 * Build the generation prompt. Returns the prompt text plus whether the source
 * was long enough to warrant a user warning and/or was hard-truncated.
 */
export function buildHtmlExportPrompt(args: {
  markdown: string;
  orientation: Orientation;
  layout: LayoutKind;
  designMd?: string;
  tone?: string;
  /** Generation purpose preset (drives read-good density/width/typography defaults). */
  purpose?: HtmlPurpose;
  customPurpose?: string;
  /** Detail-mode overrides (omitted → the purpose default). */
  density?: Density;
  readableWidth?: ReadableWidth;
  interactive?: boolean;
  /** Max source-markdown chars before truncation, sized to the selected model's
   *  context window by the caller. Falls back to {@link DEFAULT_MAX_SOURCE_CHARS}. */
  maxSourceChars?: number;
}): BuiltHtmlExportPrompt {
  const markdown = typeof args.markdown === 'string' ? args.markdown : '';
  const maxSourceChars =
    typeof args.maxSourceChars === 'number' && args.maxSourceChars > 0
      ? Math.floor(args.maxSourceChars)
      : DEFAULT_MAX_SOURCE_CHARS;
  // Warn only as the source nears the model's budget; truncate only past it.
  const warning = markdown.length > Math.floor(maxSourceChars * 0.85);
  let body = markdown;
  let truncated = false;
  if (markdown.length > maxSourceChars) {
    body = markdown.slice(0, maxSourceChars) + TRUNCATION_MARKER;
    truncated = true;
  }

  const tone = args.tone?.trim();
  const designMd = args.designMd?.trim();
  const cfg = resolvePurposeConfig({
    purpose: args.purpose,
    customPurpose: args.customPurpose,
    density: args.density,
    readableWidth: args.readableWidth,
    interactive: args.interactive,
  });
  const densityLine: Record<Density, string> = {
    compact: 'DENSITY: compact — tighter spacing, more content per screen (still legible, never cramped).',
    normal: 'DENSITY: balanced — comfortable, purposeful spacing.',
    roomy: 'DENSITY: roomy — generous spacing and breathing room, but never empty/awkward gaps.',
  };
  const widthLine: Record<ReadableWidth, string> = {
    narrow: 'READING WIDTH: narrow single column (~60ch) optimized for prose reading.',
    normal: 'READING WIDTH: standard measure (~70ch) for body text; wider only for tables/figures.',
    wide: 'READING WIDTH: wide/full-bleed sections allowed for hero/visuals; keep paragraph text to a comfortable measure.',
  };
  const typoLine: Record<'compact' | 'normal' | 'large', string> = {
    compact: 'TYPOGRAPHY: efficient type scale; clear but space-conscious headings.',
    normal: 'TYPOGRAPHY: standard balanced type scale with strong hierarchy.',
    large: 'TYPOGRAPHY: large, confident display type for headings; high-impact hierarchy.',
  };

  const lines: string[] = [
    'Convert the Markdown document below into a single, self-contained HTML page.',
    '',
    'OUTPUT CONTRACT — follow exactly:',
    '1. Output ONE complete HTML5 document, starting with `<!doctype html>` and ending with `</html>`.',
    '2. Output ONLY the HTML document. No Markdown, no code fences, no commentary before or after.',
    '3. All CSS must be inline: a single `<style>` block in `<head>` and/or `style` attributes. Never link an external stylesheet.',
    '4. No remote assets of any kind — no remote `<link>`, no `<script src>`, no web fonts, no `<img>` with an http(s)/protocol URL.',
    '5. No raster images. Render diagrams, charts, icons, and figures as inline SVG or pure CSS.',
    '6. Convert any mermaid blocks or diagram code fences into inline SVG or CSS — never leave raw diagram code.',
    '7. Preserve every fact, number, quotation, list item, table, and code snippet from the source verbatim.',
    '',
    'FORMAT:',
    orientationLine(args.orientation),
    layoutLine(args.layout),
    'Honor the chosen orientation and layout together (e.g. horizontal + slides = a landscape slide deck; vertical + scroll = a tall scrolling page).',
  ];

  lines.push(
    '',
    `PURPOSE: ${cfg.brief}`,
    densityLine[cfg.density],
    widthLine[cfg.readableWidth],
    typoLine[cfg.typography],
    cfg.interactive
      ? 'INTERACTIVITY: tasteful inline JS/CSS interactivity is allowed (e.g. tabs, accordions, subtle motion) — still no remote libraries.'
      : 'INTERACTIVITY: keep it static — no JavaScript beyond what a required slide deck needs; no animations that hurt readability.',
  );

  if (args.layout === 'slides') {
    lines.push(
      '',
      'SLIDE NAVIGATION — REQUIRED for the slide deck:',
      '- Wrap each slide in `<section class="slide">`; show only the active slide (e.g. `.slide{display:none} .slide.active{display:flex}`) and never let the page scroll (`html,body{height:100%;overflow:hidden;margin:0}`).',
      '- Each slide fills the viewport and matches the chosen orientation aspect; condense or scale long content to fit one screen instead of overflowing.',
      '- Include ONE small inline `<script>` (no remote libraries) that advances slides: ArrowRight / ArrowDown / PageDown / Space / Enter / left-click → next; ArrowLeft / ArrowUp / PageUp → previous; Home → first; End → last; clamp at both ends.',
      '- Add discreet on-screen prev/next controls and a "current / total" slide counter styled to match the design.',
      '- Mark the first slide active on load.',
    );
  }

  if (tone) {
    lines.push('', `TONE / STYLE: ${tone}`);
  }

  if (designMd) {
    lines.push(
      '',
      'DESIGN SYSTEM — adopt this aesthetic (palette, type, spacing, components). Re-express it as inline CSS; do not fetch anything from it:',
      '"""',
      clamp(designMd, DESIGN_CHARS),
      '"""',
    );
  }

  lines.push(
    '',
    'QUALITY BAR — non-negotiable; the output must look professionally designed, not like a default browser page:',
    "- A readable base stylesheet is already injected for you; build ON it and override it with the chosen design's aesthetic. Do not regress to unstyled defaults.",
    '- SPACING: use a consistent spacing scale and vertical rhythm. Whitespace must be purposeful — avoid huge empty gaps AND avoid cramped text. No giant blank regions, no content hugging the edges.',
    '- READING WIDTH: constrain body text to a comfortable measure (~60–80 characters / ~70ch); never let long paragraphs span the full width of a wide screen.',
    '- TYPOGRAPHY: establish a clear type scale (distinct h1/h2/h3/body), generous but not excessive line-height, and strong hierarchy. Use system fonts only.',
    '- LAYOUT: use modern CSS (flexbox/grid) for structure; align content to a grid; group related content into clear sections/cards as the design implies.',
    '- SEMANTICS: use semantic landmarks (header/main/section/article/nav/footer) and a sensible heading order.',
    '- POLISH: cohesive palette, considered color contrast (WCAG AA), consistent borders/radii/shadows per the design, and responsive behavior down to narrow widths.',
    '- Fidelity beats brevity: render ALL source content; never drop sections to make it "look cleaner".',
  );

  lines.push('', 'MARKDOWN SOURCE:', '"""', body, '"""');

  return { promptDoc: lines.join('\n'), truncated, warning };
}

/**
 * Inject the bundled base stylesheet as the FIRST `<style>` in `<head>` so it
 * sits beneath the model/design CSS in the cascade (design always wins). Falls
 * back to inserting after `<html>` or prepending if there is no `<head>`.
 * Idempotent: a document that already carries the base marker is returned as-is.
 */
export function injectHtmlExportBaseCss(html: string): string {
  if (typeof html !== 'string' || !html.trim()) return html;
  if (html.includes('notepad-ai base —')) return html;
  const block = `<style data-notepad-ai-base="1">${HTML_EXPORT_BASE_CSS}</style>`;
  const headOpen = html.match(/<head[^>]*>/i);
  if (headOpen) {
    const at = headOpen.index! + headOpen[0].length;
    return html.slice(0, at) + '\n' + block + html.slice(at);
  }
  const htmlOpen = html.match(/<html[^>]*>/i);
  if (htmlOpen) {
    const at = htmlOpen.index! + htmlOpen[0].length;
    return html.slice(0, at) + `\n<head>${block}</head>` + html.slice(at);
  }
  return block + html;
}

export type SelfContainedVerdict = { ok: boolean; violations: string[] };

/**
 * Detect remote/raster assets that break the self-contained contract: http(s)
 * or protocol-relative `src`/`href`, `<script src>`, remote `@import`, web-font
 * `url(http…)`, and `<img>` with a remote/raster source. Pure + unit-tested.
 */
export function validateSelfContainedHtml(html: string): SelfContainedVerdict {
  const violations: string[] = [];
  const src = typeof html === 'string' ? html : '';
  const add = (msg: string, re: RegExp) => {
    if (re.test(src)) violations.push(msg);
  };
  add('remote <script src>', /<script\b[^>]*\bsrc\s*=\s*["']?(?:https?:)?\/\//i);
  add('remote stylesheet <link>', /<link\b[^>]*\bhref\s*=\s*["']?(?:https?:)?\/\//i);
  add('remote/raster <img src>', /<img\b[^>]*\bsrc\s*=\s*["']?(?:https?:)?\/\//i);
  add('remote CSS @import', /@import\s+(?:url\()?["']?(?:https?:)?\/\//i);
  add('remote url() asset (web font / image)', /url\(\s*["']?(?:https?:)?\/\//i);
  return { ok: violations.length === 0, violations };
}

function stripTags(value: string): string {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** First `<title>` (or `<h1>`) text content from an HTML document, or ''. */
export function extractDocumentTitle(html: string): string {
  if (typeof html !== 'string') return '';
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const titleText = title ? stripTags(title) : '';
  if (titleText) return titleText;
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  return h1 ? stripTags(h1) : '';
}

export type ExtractResult = { ok: true; html: string } | { ok: false; error: string };

/**
 * Pull a complete HTML document out of an AI reply. Strips a surrounding code
 * fence, then slices from `<!doctype html>`/`<html>` to the last `</html>`.
 * Non-HTML replies return an actionable error rather than garbage.
 */
export function extractHtmlDocument(aiText: string): ExtractResult {
  if (typeof aiText !== 'string' || aiText.trim().length === 0) {
    return { ok: false, error: 'The AI returned an empty response. Please try generating again.' };
  }
  let text = aiText.trim();

  // Strip a single fully-wrapping code fence (```html … ``` or ``` … ```).
  const fenced = text.match(/^```[a-zA-Z0-9]*\s*\n([\s\S]*?)\n```$/);
  if (fenced) {
    text = fenced[1].trim();
  } else {
    // Otherwise remove a stray leading/trailing fence line if present.
    text = text.replace(/^```[a-zA-Z0-9]*[ \t]*\r?\n/, '').replace(/\r?\n```\s*$/, '').trim();
  }

  const lower = text.toLowerCase();
  const docIdx = lower.indexOf('<!doctype html');
  const htmlIdx = lower.indexOf('<html');
  const start = docIdx >= 0 ? docIdx : htmlIdx;
  const closeTag = '</html>';
  const endIdx = lower.lastIndexOf(closeTag);

  if (start < 0 || endIdx < 0 || endIdx < start) {
    return {
      ok: false,
      error: 'The AI did not return a complete HTML document. Please try generating again.',
    };
  }

  return { ok: true, html: text.slice(start, endIdx + closeTag.length).trim() };
}

function sanitizeStem(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    // Strip a markdown-ish extension first so "report.md" -> "report".
    .replace(/\.(md|markdown|mdx|txt)$/i, '')
    // Replace filesystem-illegal characters with spaces.
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    // No trailing dots/spaces (illegal/awkward on macOS + Windows).
    .replace(/[. ]+$/, '')
    .trim();
}

function isUntitled(name: string): boolean {
  return name.trim().toLowerCase().replace(/\.(md|markdown|mdx|txt)$/i, '') === 'untitled';
}

/**
 * Default filename for the native save dialog.
 * - A real current file → its basename with a `.html` extension (report.md → report.html).
 * - An unsaved/Untitled doc → the AI document's `<title>`/`<h1>`, sanitized.
 * - Otherwise → `notepad-ai-export.html`.
 */
export function defaultHtmlFileName(args: {
  currentPath?: string | null;
  pendingTitle?: string | null;
  aiHtml?: string;
}): string {
  const FALLBACK = 'notepad-ai-export.html';

  if (args.currentPath && args.currentPath.trim()) {
    const base = args.currentPath.split(/[/\\]/).pop() ?? '';
    const stem = sanitizeStem(base);
    if (stem) return `${stem}.html`;
  }

  if (args.pendingTitle && args.pendingTitle.trim() && !isUntitled(args.pendingTitle)) {
    const stem = sanitizeStem(args.pendingTitle);
    if (stem) return `${stem}.html`;
  }

  if (args.aiHtml) {
    const stem = sanitizeStem(extractDocumentTitle(args.aiHtml));
    if (stem) return `${stem}.html`;
  }

  return FALLBACK;
}
