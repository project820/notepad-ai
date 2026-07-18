// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { bundleSanitizedHtml } from '../main/html-export-shell';
import { htmlExportRuntimeSha256, injectHtmlExportRuntime } from '../main/html-export-runtime';
import { sanitizeHtmlExport } from '../main/html-export-sanitize';

function mount(html: string, mode: 'scroll' | 'slide' = 'scroll'): void {
  document.documentElement.innerHTML = injectHtmlExportRuntime(html, mode);
  HTMLElement.prototype.scrollIntoView = () => {};
  const source = document.querySelector<HTMLScriptElement>('#nai-runtime')?.textContent;
  if (!source) throw new Error('runtime was not injected');
  window.eval(source);
}

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-nai-runtime');
  document.documentElement.innerHTML = '';
});

describe('HTML export runtime DOM', () => {
  it('toggles and restores the html theme through localStorage', () => {
    localStorage.setItem('nai-theme', 'dark');
    mount('<html><head></head><body><main>content</main></body></html>');

    const toggle = document.querySelector<HTMLButtonElement>('#nai-runtime-toggle')!;
    expect(document.documentElement.dataset.theme).toBe('dark');
    toggle.click();
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('nai-theme')).toBe('light');
  });

  it('adds the fallback theme stylesheet when authored theme variables are absent inside a layer', () => {
    mount('<html><head><style>@layer he-authored{[data-he-content]{color:black}}</style></head><body><div data-he-content></div></body></html>');
    expect(document.querySelector('#nai-theme-fallback')?.textContent).toContain('[data-theme="dark"]');
  });
  it('applies authored theme variables on the content root and skips fallback only when they match', () => {
    mount('<html><head><style>[data-he-content][data-theme="dark"]{--bg:#111;background:var(--bg)}</style></head><body><div data-he-content></div></body></html>');
    const content = document.querySelector<HTMLElement>('[data-he-content]')!;
    expect(content.dataset.theme).toBe('light');
    document.querySelector<HTMLButtonElement>('#nai-runtime-toggle')!.click();
    expect(content.dataset.theme).toBe('dark');
    expect(getComputedStyle(content).getPropertyValue('--bg').trim()).toBe('#111');
    expect(document.querySelector('#nai-theme-fallback')).toBeNull();
  });

  it('applies a :where theme palette in the finalized artifact without a fallback', () => {
    const sanitized = sanitizeHtmlExport({
      html: '<html><head><style>:where([data-theme="dark"]){--surface:#111;background:var(--surface)}</style></head><body><main>content</main></body></html>',
      isAllowedAssetId: () => true,
    });
    expect(sanitized.ok).toBe(true);
    if (!sanitized.ok) return;
    expect(sanitized.contentCss).toContain('@layer he-authored{[data-he-content]:where([data-theme="dark"]){--surface:#111');

    const finalized = bundleSanitizedHtml(sanitized).html;
    mount(finalized);
    const content = document.querySelector<HTMLElement>('[data-he-content]')!;
    document.querySelector<HTMLButtonElement>('#nai-runtime-toggle')!.click();

    expect(content.matches('[data-he-content]:where([data-theme="dark"])')).toBe(true);
    expect(document.querySelector('#nai-theme-fallback')).toBeNull();
  });

  it('skips the fallback for authored theme variables inside media rules', () => {
    mount('<html><head><style>@media screen{[data-he-content][data-theme="dark"]{--surface:#111}}</style></head><body><div data-he-content></div></body></html>');
    expect(document.querySelector('#nai-theme-fallback')).toBeNull();
  });
  it('pages slide exports by keyboard and controls while ignoring text input focus', () => {
    mount('<html><head></head><body><section class="slide">one</section><section class="slide">two<input></section><section class="slide">three<textarea></textarea></section></body></html>', 'slide');

    const slides = Array.from(document.querySelectorAll<HTMLElement>('section.slide'));
    const indicator = document.querySelector('.nai-slide-nav span')!;
    const [previous, next] = Array.from(document.querySelectorAll<HTMLButtonElement>('.nai-slide-nav button'));
    expect(indicator.textContent).toBe('1/3');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(indicator.textContent).toBe('2/3');
    next.click();
    expect(indicator.textContent).toBe('3/3');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp' }));
    expect(indicator.textContent).toBe('2/3');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    expect(indicator.textContent).toBe('1/3');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown' }));
    expect(indicator.textContent).toBe('2/3');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    expect(indicator.textContent).toBe('3/3');
    previous.click();
    expect(indicator.textContent).toBe('2/3');
    const input = slides[1].querySelector('input')!;
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(indicator.textContent).toBe('2/3');
    const textarea = slides[2].querySelector('textarea')!;
    textarea.focus();
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(indicator.textContent).toBe('2/3');
  });

  it('patches only the manifest runtime SHA, leaving authored CSS decoys untouched', () => {
    const decoy = '"runtimeSha256":"AAAA"';
    const output = injectHtmlExportRuntime(
      `<html><head><style>[data-he-content]{--x:'${decoy}'}</style><script id="he-manifest" type="application/json">{"runtimeSha256":"stale"}</script></head><body></body></html>`,
    );

    expect(output).toContain(`--x:'${decoy}'`);
    const manifest = output.match(/<script id="he-manifest"[^>]*>([\s\S]*?)<\/script>/);
    expect(manifest).not.toBeNull();
    expect(JSON.parse(manifest![1]).runtimeSha256).toBe(htmlExportRuntimeSha256());
  });

  it('is idempotent across double finalization', () => {
    const once = injectHtmlExportRuntime('<html><head></head><body>content</body></html>');
    const twice = injectHtmlExportRuntime(once);
    expect((twice.match(/id="nai-runtime"/g) ?? [])).toHaveLength(1);
    expect((twice.match(/http-equiv="Content-Security-Policy"/g) ?? [])).toHaveLength(1);
  });
});
