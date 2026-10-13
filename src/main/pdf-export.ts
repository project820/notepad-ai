/**
 * PDF export (#79): wraps the preview's markdown-it HTML in a fixed light print
 * document and prints it to an A4 PDF with page numbers in the footer.
 *
 * The print document is static: the hidden render window runs with JavaScript
 * disabled and a CSP that only permits inline styles and data: images, which
 * matches what the live preview can display.
 */
import { BrowserWindow } from 'electron';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Upper bound for renderer-supplied body HTML (data: images included). */
export const PDF_EXPORT_MAX_HTML_LENGTH = 64 * 1024 * 1024;

const PDF_PRINT_OPTIONS = {
  pageSize: 'A4',
  printBackground: true,
  // Inches. The bottom margin hosts the page-number footer.
  margins: { top: 0.7, bottom: 0.8, left: 0.7, right: 0.7 },
  displayHeaderFooter: true,
  headerTemplate: '<div></div>',
  footerTemplate:
    '<div style="width:100%;text-align:center;font-size:9px;color:#6b7280;'
    + 'font-family:-apple-system,BlinkMacSystemFont,sans-serif;"><span class="pageNumber"></span></div>',
} as const;

/** Light print stylesheet; deliberately independent of the app theme. */
const PDF_PRINT_CSS = `
:root { color-scheme: light; }
html, body { margin: 0; padding: 0; background: #ffffff; color: #1f2328; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Pretendard", "Noto Sans CJK KR",
    "Hiragino Sans", "PingFang SC", "PingFang TC", sans-serif;
  font-size: 11pt; line-height: 1.65; word-break: keep-all; overflow-wrap: anywhere;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.2em 0 0.5em; font-weight: 700; break-after: avoid; page-break-after: avoid; }
h1 { font-size: 22pt; } h2 { font-size: 17pt; padding-bottom: 0.2em; border-bottom: 1px solid #d8dee4; }
h3 { font-size: 14pt; } h4 { font-size: 12pt; } h5, h6 { font-size: 11pt; }
body > :first-child { margin-top: 0; }
p { margin: 0.55em 0; orphans: 3; widows: 3; }
a { color: #0b57d0; text-decoration: none; }
ul, ol { margin: 0.55em 0 0.55em 1.4em; padding: 0; }
li { margin: 0.2em 0; }
ul.contains-task-list { list-style: none; margin-left: 0.4em; }
.task-list-item input { margin: 0 0.5em 0 0; vertical-align: middle; }
blockquote { margin: 0.8em 0; padding: 0.1em 1em; color: #57606a; border-left: 3px solid #d0d7de; }
code { font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 0.9em; background: #f3f4f6; border-radius: 4px; padding: 0.1em 0.35em; }
pre { background: #f6f8fa; border: 1px solid #e5e7eb; border-radius: 6px; padding: 0.8em 1em; white-space: pre-wrap; overflow-wrap: anywhere; break-inside: avoid; page-break-inside: avoid; }
pre code { background: none; padding: 0; font-size: 0.86em; }
table { border-collapse: collapse; width: 100%; margin: 0.8em 0; font-size: 0.95em; }
th, td { border: 1px solid #d0d7de; padding: 0.4em 0.6em; text-align: left; vertical-align: top; }
th { background: #f6f8fa; font-weight: 600; }
thead { display: table-header-group; }
tr, img { break-inside: avoid; page-break-inside: avoid; }
img { max-width: 100%; height: auto; }
hr { border: none; border-top: 1px solid #d0d7de; margin: 1.4em 0; }
mark { background: #fff3a3; color: inherit; }
dt { font-weight: 600; margin-top: 0.6em; } dd { margin: 0.2em 0 0.4em 1.4em; }
.footnotes { font-size: 0.9em; color: #57606a; }
`;

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (ch) => ESCAPES[ch]);

/** The PDF document title and default file stem for a window's document. */
export function pdfDocumentName(documentPath: string | null | undefined): string {
  if (!documentPath) return 'Untitled';
  const stem = path.basename(documentPath).replace(/\.[^.]+$/, '');
  return stem.trim() || 'Untitled';
}

export function buildPdfDocument({ bodyHtml, title, lang }: { bodyHtml: string; title: string; lang: string }): string {
  const safeLang = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(lang) ? lang : 'en';
  return `<!doctype html>
<html lang="${safeLang}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>${escapeHtml(title)}</title>
<style>${PDF_PRINT_CSS}</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

/** Renders a complete print document to PDF bytes in a hidden, script-free window. */
export async function renderPdf(documentHtml: string): Promise<Buffer> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notepad-ai-pdf-'));
  const win = new BrowserWindow({
    show: false,
    width: 794,
    height: 1123,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
  });
  try {
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    const file = path.join(dir, 'document.html');
    await writeFile(file, documentHtml, 'utf8');
    await win.loadFile(file);
    return await win.webContents.printToPDF(PDF_PRINT_OPTIONS);
  } finally {
    if (!win.isDestroyed()) win.destroy();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
