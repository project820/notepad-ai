/**
 * html-export-prompt.ts — pure prompt/IO helpers for the HTML-export wizard (⑤).
 *
 * No DOM, no IPC: builds the generation prompt, extracts the HTML document from
 * an AI reply (stripping code fences), and computes the default save filename.
 * The output contract (single inline-CSS HTML5 doc, no remote/raster assets,
 * diagrams as inline SVG/CSS, all four orientation×layout combos) is spelled out
 * in the prompt so the AI has no leeway to insert remote network/raster content.
 */

import type { LayoutKind, Orientation } from './html-export-state';

/** Markdown longer than this warns the user before generating (token-warning gate). */
const WARN_CHARS = 12000;
/** Markdown longer than this is hard-truncated with a marker. */
const TRUNCATE_CHARS = 40000;
/** DESIGN.md is clamped so the prompt stays bounded. */
const DESIGN_CHARS = 8000;
const TRUNCATION_MARKER = '\n\n<!-- NOTE: the source above was truncated here for length. -->';

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
    ? 'Layout: SLIDES — a deck of discrete full-viewport slide sections (PPT style); one idea per slide, each sized to fill one screen.'
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
}): BuiltHtmlExportPrompt {
  const markdown = typeof args.markdown === 'string' ? args.markdown : '';
  const warning = markdown.length > WARN_CHARS;
  let body = markdown;
  let truncated = false;
  if (markdown.length > TRUNCATE_CHARS) {
    body = markdown.slice(0, TRUNCATE_CHARS) + TRUNCATION_MARKER;
    truncated = true;
  }

  const tone = args.tone?.trim();
  const designMd = args.designMd?.trim();

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

  lines.push('', 'MARKDOWN SOURCE:', '"""', body, '"""');

  return { promptDoc: lines.join('\n'), truncated, warning };
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
