import { describe, it, expect } from 'vitest';
import {
  buildHtmlExportPrompt,
  defaultHtmlFileName,
  extractDocumentTitle,
  extractHtmlDocument,
  HTML_EXPORT_BASE_CSS,
  HTML_EXPORT_INSTRUCTIONS,
  injectHtmlExportBaseCss,
  validateSelfContainedHtml,
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

  it('requires real slide-deck navigation for the slides layout', () => {
    const { promptDoc } = buildHtmlExportPrompt({ markdown: '# A', orientation: 'horizontal', layout: 'slides' });
    expect(promptDoc).toContain('SLIDE NAVIGATION');
    expect(promptDoc).toContain('ArrowRight');
    expect(promptDoc).toContain('MUST NOT scroll');
    expect(promptDoc).toContain('.slide.active');
  });

  it('does not inject slide navigation for the scroll layout', () => {
    const { promptDoc } = buildHtmlExportPrompt({ markdown: '# A', orientation: 'vertical', layout: 'scroll' });
    expect(promptDoc).not.toContain('SLIDE NAVIGATION');
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

  it('does not warn or truncate a 40K-char document under the default budget (regression: old 40K cap)', () => {
    // The old TRUNCATE_CHARS=40000 hard-cut normal documents; the generous default
    // (200K) must leave a 40K-char doc fully intact and unwarned.
    const md = 'z'.repeat(40000);
    const result = buildHtmlExportPrompt({ markdown: md, orientation: 'vertical', layout: 'scroll' });
    expect(result.warning).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.promptDoc).toContain(md);
  });

  it('respects a model-specific maxSourceChars: warns near it, truncates past it', () => {
    const budget = 1000;
    const warnOnly = buildHtmlExportPrompt({ markdown: 'x'.repeat(900), orientation: 'vertical', layout: 'scroll', maxSourceChars: budget });
    expect(warnOnly.warning).toBe(true);
    expect(warnOnly.truncated).toBe(false);
    expect(warnOnly.promptDoc).toContain('x'.repeat(900));

    const truncated = buildHtmlExportPrompt({ markdown: 'y'.repeat(1500), orientation: 'vertical', layout: 'scroll', maxSourceChars: budget });
    expect(truncated.warning).toBe(true);
    expect(truncated.truncated).toBe(true);
    expect(truncated.promptDoc).toContain('truncated');
    expect(truncated.promptDoc).not.toContain('y'.repeat(1500));
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

describe('G005 — HTML_EXPORT_INSTRUCTIONS', () => {
  it('keeps the self-contained signature so output-budget detection still matches', () => {
    expect(HTML_EXPORT_INSTRUCTIONS).toContain('self-contained HTML5 document');
  });
});

describe('G005 — QUALITY BAR in the generation prompt (AC12)', () => {
  it('injects the quality-bar guidance against excessive whitespace + for reading width', () => {
    const { promptDoc } = buildHtmlExportPrompt({ markdown: '# Hi', orientation: 'vertical', layout: 'scroll' });
    expect(promptDoc).toContain('QUALITY BAR');
    expect(promptDoc).toContain('READING WIDTH');
    expect(promptDoc.toLowerCase()).toContain('whitespace must be purposeful');
    expect(promptDoc).toContain('base stylesheet is already injected');
  });
});

describe('G005 — injectHtmlExportBaseCss (AC12 base CSS safety net)', () => {
  it('inserts the base style as the first thing in <head>', () => {
    const out = injectHtmlExportBaseCss('<!doctype html><html><head><title>x</title></head><body>hi</body></html>');
    expect(out).toContain('data-notepad-ai-base="1"');
    expect(out.indexOf('data-notepad-ai-base')).toBeLessThan(out.indexOf('<title>'));
    expect(out).toContain(HTML_EXPORT_BASE_CSS);
  });

  it('is idempotent (does not double-inject)', () => {
    const once = injectHtmlExportBaseCss('<html><head></head><body></body></html>');
    const twice = injectHtmlExportBaseCss(once);
    expect(twice).toBe(once);
    expect(twice.match(/data-notepad-ai-base/g)!.length).toBe(1);
  });

  it('creates a head when none exists', () => {
    const out = injectHtmlExportBaseCss('<html><body>x</body></html>');
    expect(out).toContain('<head>');
    expect(out).toContain('data-notepad-ai-base');
  });
});

describe('G005 — validateSelfContainedHtml (AC12 no remote assets)', () => {
  it('passes an inline-only document', () => {
    const v = validateSelfContainedHtml('<!doctype html><html><head><style>body{color:red}</style></head><body><svg></svg></body></html>');
    expect(v.ok).toBe(true);
    expect(v.violations).toEqual([]);
  });

  it('flags a remote script', () => {
    const v = validateSelfContainedHtml('<html><head><script src="https://cdn.example/x.js"></script></head></html>');
    expect(v.ok).toBe(false);
    expect(v.violations.join(' ')).toContain('script');
  });

  it('flags a remote stylesheet, remote img, @import, and web-font url()', () => {
    expect(validateSelfContainedHtml('<link rel="stylesheet" href="https://x/app.css">').ok).toBe(false);
    expect(validateSelfContainedHtml('<img src="//cdn/x.png">').ok).toBe(false);
    expect(validateSelfContainedHtml('<style>@import url(https://fonts.example/f.css)</style>').ok).toBe(false);
    expect(validateSelfContainedHtml('<style>@font-face{src:url("https://fonts.gstatic.com/a.woff2")}</style>').ok).toBe(false);
  });

  it('does not flag a protocol-relative-free inline data URI', () => {
    const v = validateSelfContainedHtml('<img src="data:image/png;base64,AAAA">');
    expect(v.ok).toBe(true);
  });
});

describe('G005 — PURPOSE section in the prompt (AC8/AC9/AC10)', () => {
  it('injects the purpose brief + density/width/typography + interactive directives', () => {
    const { promptDoc } = buildHtmlExportPrompt({
      markdown: '# Hi',
      orientation: 'horizontal',
      layout: 'slides',
      purpose: 'presentation',
    });
    expect(promptDoc).toContain('PURPOSE:');
    expect(promptDoc).toContain('presentation deck');
    expect(promptDoc).toContain('DENSITY:');
    expect(promptDoc).toContain('READING WIDTH:');
    expect(promptDoc).toContain('TYPOGRAPHY:');
    expect(promptDoc).toContain('INTERACTIVITY: tasteful'); // presentation default = interactive
  });

  it('detail overrides flow into the prompt (interactive off + compact density)', () => {
    const { promptDoc } = buildHtmlExportPrompt({
      markdown: '# Hi',
      orientation: 'vertical',
      layout: 'scroll',
      purpose: 'landing',
      density: 'compact',
      interactive: false,
    });
    expect(promptDoc).toContain('DENSITY: compact');
    expect(promptDoc).toContain('INTERACTIVITY: keep it static');
  });

  it('custom purpose threads the user free-text into the PURPOSE brief', () => {
    const { promptDoc } = buildHtmlExportPrompt({
      markdown: '# Hi',
      orientation: 'vertical',
      layout: 'scroll',
      purpose: 'custom',
      customPurpose: 'an interactive timeline of the project',
    });
    expect(promptDoc).toContain('an interactive timeline of the project');
  });
});
