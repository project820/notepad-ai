/**
 * html-export-prompt.ts — filename + title helpers for the HTML-export wizard.
 *
 * 0.6.2 removed the LLM-authored-HTML path: the AI now returns ONLY a JSON
 * content model (see html-export-content-prompt.ts) and a deterministic engine
 * renders, paginates, scales, themes, bundles, and self-containment-validates
 * the document (html-export-renderer / -layout / -theme / -bundle / -validate).
 *
 * What remains here is pure, DOM-free derivation of the default save-dialog
 * filename from the current file / a pending title / the rendered document's
 * `<title>`. No prompt authoring, no HTML extraction, no CSS injection.
 */

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
 * - An unsaved/Untitled doc → the rendered document's `<title>`/`<h1>`, sanitized.
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
