import { describe, expect, it } from 'vitest';
import { defaultHtmlFileName, extractDocumentTitle } from '../html-export-prompt';

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

  it('uses the rendered document title when the doc is Untitled/unsaved', () => {
    const html = '<!doctype html><html><head><title>Quarterly Review</title></head></html>';
    expect(defaultHtmlFileName({ currentPath: null, pendingTitle: 'Untitled', aiHtml: html })).toBe('Quarterly Review.html');
    expect(defaultHtmlFileName({ currentPath: '', aiHtml: html })).toBe('Quarterly Review.html');
  });

  it('uses a non-Untitled pending title before the document title', () => {
    const html = '<!doctype html><html><head><title>Doc Title</title></head></html>';
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
