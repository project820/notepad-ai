// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildOutline, buildFootnotes, mountLeftPanel } from '../left-panel';

afterEach(() => {
  document.body.innerHTML = '';
});

function previewWith(html: string): HTMLElement {
  const root = document.createElement('div');
  root.className = 'preview';
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

describe('buildOutline', () => {
  it('collects h1-h3 (not h4+) and assigns ids when missing', () => {
    const root = previewWith('<h1>Title</h1><h2 id="x">Sub</h2><h3>Deep</h3><h4>Ignored</h4>');
    const out = buildOutline(root);
    expect(out.map((o) => o.text)).toEqual(['Title', 'Sub', 'Deep']);
    expect(out.map((o) => o.level)).toEqual([1, 2, 3]);
    expect(out[1].id).toBe('x');
    expect(out[0].id).toBeTruthy();
  });
});

describe('buildFootnotes', () => {
  it('collects footnote items by id, stripping the backref arrow', () => {
    const root = previewWith(
      '<section class="footnotes"><ol><li id="fn1">first note <a class="footnote-backref">↩</a></li><li id="fn2">second</li></ol></section>',
    );
    const fns = buildFootnotes(root);
    expect(fns.map((f) => f.id)).toEqual(['fn1', 'fn2']);
    expect(fns[0].text).toContain('first note');
    expect(fns[0].text).not.toContain('↩');
  });
});

describe('mountLeftPanel', () => {
  it('renders outline + footnotes and jumps on click', () => {
    const root = previewWith('<h1 id="h1">Intro</h1><p>x<sup class="footnote-ref"><a href="#fn1">[1]</a></sup></p><section class="footnotes"><ol><li id="fn1">a note</li></ol></section>');
    (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const onJump = vi.fn();
    mountLeftPanel(host, { getPreviewRoot: () => root, onJump });
    expect(host.querySelector('.lp-item')).not.toBeNull();
    // click the outline heading item
    host.querySelector<HTMLButtonElement>('.lp-item[data-target="h1"]')!.click();
    expect(onJump).toHaveBeenCalledTimes(1);
    expect((onJump.mock.calls[0][0] as HTMLElement).id).toBe('h1');
    // click the footnote item
    host.querySelector<HTMLButtonElement>('.lp-item[data-target="fn1"]')!.click();
    expect(onJump).toHaveBeenCalledTimes(2);
  });

  it('shows empty states when there are no headings/footnotes', () => {
    const root = previewWith('<p>just a paragraph</p>');
    const host = document.createElement('div');
    document.body.appendChild(host);
    mountLeftPanel(host, { getPreviewRoot: () => root, onJump: vi.fn() });
    expect(host.querySelectorAll('.lp-empty').length).toBe(2);
  });
});
