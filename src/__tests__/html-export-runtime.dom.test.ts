// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { injectHtmlExportRuntime } from '../main/html-export-runtime';

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

  it('adds the fallback theme stylesheet when authored theme variables are absent', () => {
    mount('<html><head><style>body{color:black}</style></head><body></body></html>');
    expect(document.querySelector('#nai-theme-fallback')?.textContent).toContain('[data-theme="dark"]');
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

  it('is idempotent across double finalization', () => {
    const once = injectHtmlExportRuntime('<html><head></head><body>content</body></html>');
    const twice = injectHtmlExportRuntime(once);
    expect((twice.match(/id="nai-runtime"/g) ?? [])).toHaveLength(1);
    expect((twice.match(/http-equiv="Content-Security-Policy"/g) ?? [])).toHaveLength(1);
  });
});
