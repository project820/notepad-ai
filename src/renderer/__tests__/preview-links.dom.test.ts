// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { wirePreviewLinks } from '../preview-links';

beforeEach(() => {
  // happy-dom may not implement scrollIntoView.
  (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = vi.fn();
});
afterEach(() => {
  document.body.innerHTML = '';
});

function build(html: string) {
  const host = document.createElement('div');
  host.className = 'preview-host';
  const root = document.createElement('div');
  root.className = 'preview';
  root.innerHTML = html;
  host.appendChild(root);
  document.body.appendChild(host);
  return { host, root };
}

describe('wirePreviewLinks (#2)', () => {
  it('opens http(s) links externally and prevents default navigation', () => {
    const openExternal = vi.fn();
    const { root } = build('<p><a href="https://example.com/x">link</a></p>');
    wirePreviewLinks(root, { openExternal });
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    root.querySelector('a')!.dispatchEvent(ev);
    expect(openExternal).toHaveBeenCalledWith('https://example.com/x');
    expect(ev.defaultPrevented).toBe(true);
  });

  it('does not open in-document anchors externally', () => {
    const openExternal = vi.fn();
    const { root } = build(
      '<sup class="footnote-ref"><a href="#fn1" id="fnref1">[1]</a></sup>' +
        '<section class="footnotes"><ol><li id="fn1">a note <a href="#fnref1" class="footnote-backref">↩</a></li></ol></section>',
    );
    wirePreviewLinks(root, { openExternal, backLabel: '← back' });
    root.querySelector<HTMLElement>('.footnote-ref a')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('jumping to a footnote shows a back button that returns to the prior scroll', () => {
    const { host, root } = build(
      '<sup class="footnote-ref"><a href="#fn1" id="fnref1">[1]</a></sup>' +
        '<section class="footnotes"><ol><li id="fn1">a note</li></ol></section>',
    );
    Object.defineProperty(host, 'scrollTop', { value: 250, writable: true, configurable: true });
    wirePreviewLinks(root, { openExternal: vi.fn(), backLabel: '← back', scroller: host });
    root.querySelector<HTMLElement>('.footnote-ref a')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const back = document.querySelector<HTMLButtonElement>('.preview-back-btn');
    expect(back).not.toBeNull();
    (host as unknown as { scrollTop: number }).scrollTop = 999;
    back!.click();
    expect((host as unknown as { scrollTop: number }).scrollTop).toBe(250);
    expect(document.querySelector('.preview-back-btn')).toBeNull();
  });

  it('hovering a footnote citation shows a preview tooltip with its text', () => {
    const { root } = build(
      '<sup class="footnote-ref"><a href="#fn1" id="fnref1">[1]</a></sup>' +
        '<section class="footnotes"><ol><li id="fn1">the footnote body <a href="#fnref1" class="footnote-backref">↩</a></li></ol></section>',
    );
    wirePreviewLinks(root, { openExternal: vi.fn() });
    root.querySelector<HTMLElement>('.footnote-ref a')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    const tip = document.querySelector('.footnote-tip');
    expect(tip).not.toBeNull();
    expect(tip!.textContent).toContain('the footnote body');
    expect(tip!.textContent).not.toContain('↩');
  });
});
