import { describe, it, expect } from 'vitest';
import {
  buildHtmlExportPrompt,
  defaultHtmlFileName,
  extractDocumentTitle,
  extractHtmlDocument,
} from '../html-export-prompt';

describe('buildHtmlExportPrompt', () => {
  it('embeds the output contract, orientation, layout, tone, and design', () => {
    const { promptDoc } = buildHtmlExportPrompt({
      markdown: '# Hello',
      orientation: 'horizontal',
      layout: 'slides',
      designMd: '## Palette\n- orange',
      tone: 'playful and bold',
    });
    expect(promptDoc).toContain('<!doctype html>');
    expect(promptDoc).toContain('inline');
    expect(promptDoc).toContain('No remote assets');
    expect(promptDoc).toContain('No raster images');
    expect(promptDoc).toContain('HORIZONTAL');
    expect(promptDoc).toContain('SLIDES');
    expect(promptDoc).toContain('playful and bold');
    expect(promptDoc).toContain('## Palette');
    expect(promptDoc).toContain('# Hello');
  });

  it('omits the tone and design sections when not provided', () => {
    const { promptDoc } = buildHtmlExportPrompt({ markdown: '# Hi', orientation: 'vertical', layout: 'scroll' });
    expect(promptDoc).toContain('VERTICAL');
    expect(promptDoc).toContain('SCROLL');
    expect(promptDoc).not.toContain('TONE / STYLE');
    expect(promptDoc).not.toContain('DESIGN SYSTEM');
  });

  it('does not warn or truncate for a short document', () => {
    const result = buildHtmlExportPrompt({ markdown: 'short', orientation: 'vertical', layout: 'scroll' });
    expect(result.warning).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it('warns (without truncating) for a long-but-bounded document', () => {
    const result = buildHtmlExportPrompt({ markdown: 'x'.repeat(20000), orientation: 'vertical', layout: 'scroll' });
    expect(result.warning).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.promptDoc).toContain('x'.repeat(20000));
  });

  it('warns and truncates with a marker for an extremely long document', () => {
    const result = buildHtmlExportPrompt({ markdown: 'y'.repeat(60000), orientation: 'vertical', layout: 'scroll' });
    expect(result.warning).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.promptDoc).toContain('truncated');
    expect(result.promptDoc).not.toContain('y'.repeat(60000));
  });
});

describe('extractHtmlDocument', () => {
  it('extracts a bare HTML document', () => {
    const out = extractHtmlDocument('<!doctype html><html><body>Hi</body></html>');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.html).toBe('<!doctype html><html><body>Hi</body></html>');
  });

  it('strips a wrapping ```html code fence', () => {
    const out = extractHtmlDocument('```html\n<!doctype html><html></html>\n```');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.html).toBe('<!doctype html><html></html>');
  });

  it('strips surrounding prose and keeps only the document', () => {
    const out = extractHtmlDocument('Sure! Here you go:\n<!doctype html><html><body>x</body></html>\nLet me know!');
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.html.startsWith('<!doctype html>')).toBe(true);
      expect(out.html.endsWith('</html>')).toBe(true);
    }
  });

  it('returns an actionable error for non-HTML and empty replies', () => {
    const notHtml = extractHtmlDocument('I cannot do that, but here is some markdown: # Title');
    expect(notHtml.ok).toBe(false);
    if (!notHtml.ok) expect(notHtml.error).toMatch(/HTML/i);

    const empty = extractHtmlDocument('   ');
    expect(empty.ok).toBe(false);
  });
});

describe('extractDocumentTitle', () => {
  it('prefers <title>, then <h1>', () => {
    expect(extractDocumentTitle('<html><head><title>My Doc</title></head></html>')).toBe('My Doc');
    expect(extractDocumentTitle('<html><body><h1>Heading One</h1></body></html>')).toBe('Heading One');
    expect(extractDocumentTitle('<html><body><p>no title</p></body></html>')).toBe('');
  });
});

describe('defaultHtmlFileName', () => {
  it('derives the name from the current MD file (report.md → report.html)', () => {
    expect(defaultHtmlFileName({ currentPath: '/Users/me/docs/report.md' })).toBe('report.html');
    expect(defaultHtmlFileName({ currentPath: '/Users/me/My Notes.markdown' })).toBe('My Notes.html');
  });

  it('uses the AI document title when the doc is Untitled/unsaved', () => {
    const html = '<!doctype html><html><head><title>Quarterly Review</title></head></html>';
    expect(defaultHtmlFileName({ currentPath: null, pendingTitle: 'Untitled', aiHtml: html })).toBe('Quarterly Review.html');
    expect(defaultHtmlFileName({ currentPath: '', aiHtml: html })).toBe('Quarterly Review.html');
  });

  it('uses a non-Untitled pending title before the AI title', () => {
    const html = '<!doctype html><html><head><title>AI Title</title></head></html>';
    expect(defaultHtmlFileName({ currentPath: null, pendingTitle: 'Draft Plan', aiHtml: html })).toBe('Draft Plan.html');
  });

  it('falls back to notepad-ai-export.html when nothing else is available', () => {
    expect(defaultHtmlFileName({ currentPath: null, pendingTitle: 'Untitled' })).toBe('notepad-ai-export.html');
    expect(defaultHtmlFileName({})).toBe('notepad-ai-export.html');
    expect(
      defaultHtmlFileName({ currentPath: null, aiHtml: '<html><body><p>no title here</p></body></html>' }),
    ).toBe('notepad-ai-export.html');
  });

  it('sanitizes filesystem-illegal characters in the stem', () => {
    const html = '<!doctype html><html><head><title>a/b:c*d?</title></head></html>';
    const name = defaultHtmlFileName({ currentPath: null, aiHtml: html });
    expect(name.endsWith('.html')).toBe(true);
    expect(name).not.toMatch(/[/:*?]/);
  });
});
