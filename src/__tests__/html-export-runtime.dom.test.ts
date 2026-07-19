// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { bundleSanitizedHtml } from '../main/html-export-shell';
import { htmlExportRuntimeSha256, injectHtmlExportRuntime } from '../main/html-export-runtime';
import { sanitizeHtmlExport } from '../main/html-export-sanitize';
import { htmlExportRuntimeLabels, type HtmlExportRuntimeLocale } from '../main/html-export-runtime-labels';

function mount(
  html: string,
  mode: 'scroll' | 'slide' = 'scroll',
  locale: HtmlExportRuntimeLocale = 'en',
  styleSheets?: Array<{ cssRules: unknown[] }>,
): void {
  document.documentElement.innerHTML = injectHtmlExportRuntime(html, mode, htmlExportRuntimeLabels(locale));
  if (styleSheets) Object.defineProperty(document, 'styleSheets', { configurable: true, value: styleSheets });
  HTMLElement.prototype.scrollIntoView = () => {};
  const source = document.querySelector<HTMLScriptElement>('#nai-runtime')?.textContent;
  if (!source) throw new Error('runtime was not injected');
  window.eval(source);
}

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-nai-runtime');
  document.documentElement.innerHTML = '';
  vi.unstubAllGlobals();
  delete (document as { styleSheets?: unknown }).styleSheets;
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
  it('keeps the fallback functional when content-root variables are not theme-conditioned', () => {
    mount('<html><head><style>@layer he-authored{[data-he-content]{--foreground:#111;color:var(--foreground)}}</style></head><body><div data-he-content></div></body></html>');
    const content = document.querySelector<HTMLElement>('[data-he-content]')!;

    document.querySelector<HTMLButtonElement>('#nai-runtime-toggle')!.click();

    expect(content.dataset.theme).toBe('dark');
    expect(document.querySelector('#nai-theme-fallback')).not.toBeNull();
    expect(content.matches('[data-he-content][data-theme="dark"]')).toBe(true);
  });
  it('keeps the fallback when a theme-conditioned rule has no custom properties', () => {
    mount('<html><head><style>[data-he-content][data-theme="dark"]{color:#111}</style></head><body><div data-he-content></div></body></html>');

    expect(document.querySelector('#nai-theme-fallback')).not.toBeNull();
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
  it('keeps the dark fallback for a light-only authored palette', () => {
    mount('<html><head><style>[data-he-content][data-theme="light"]{--surface:#fff}</style></head><body><div data-he-content></div></body></html>');
    const content = document.querySelector<HTMLElement>('[data-he-content]')!;

    document.querySelector<HTMLButtonElement>('#nai-runtime-toggle')!.click();

    expect(content.dataset.theme).toBe('dark');
    expect(document.querySelector('#nai-theme-fallback')?.textContent).toContain('filter:invert(1)');
  });
  it('skips the fallback when both authored theme palettes are present', () => {
    mount('<html><head><style>[data-he-content][data-theme="light"]{--surface:#fff}[data-he-content][data-theme="dark"]{--surface:#111}</style></head><body><div data-he-content></div></body></html>');

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
  it('applies functional body theme palettes in finalized artifacts without a fallback', () => {
    const sanitized = sanitizeHtmlExport({
      html: '<html><head><style>:where(body[data-theme="dark"]){--body-where:#111}:is(body[data-theme="dark"]){--body-is:#222}</style></head><body><main>content</main></body></html>',
      isAllowedAssetId: () => true,
    });
    expect(sanitized.ok).toBe(true);
    if (!sanitized.ok) return;
    expect(sanitized.contentCss).toContain(
      '[data-he-content]:where([data-he-content][data-theme="dark"]){--body-where:#111}',
    );
    expect(sanitized.contentCss).toContain(
      '[data-he-content]:is([data-he-content][data-theme="dark"]){--body-is:#222}',
    );

    mount(bundleSanitizedHtml(sanitized).html);
    const content = document.querySelector<HTMLElement>('[data-he-content]')!;
    document.querySelector<HTMLButtonElement>('#nai-runtime-toggle')!.click();

    expect(content.matches('[data-he-content]:where([data-he-content][data-theme="dark"])')).toBe(true);
    expect(content.matches('[data-he-content]:is([data-he-content][data-theme="dark"])')).toBe(true);
    expect(document.querySelector('#nai-theme-fallback')).toBeNull();
  });
  it('preserves case-sensitive custom properties and resolves their var() references in finalized artifacts', () => {
    const sanitized = sanitizeHtmlExport({
      html: '<html><head><style>:where([data-theme="dark"]){--AccentColor:rgb(1, 2, 3)}:where([data-theme="dark"]){--Resolved:var(--AccentColor)}</style></head><body><main>content</main></body></html>',
      isAllowedAssetId: () => true,
    });
    expect(sanitized.ok).toBe(true);
    if (!sanitized.ok) return;

    const finalized = bundleSanitizedHtml(sanitized).html;
    expect(finalized).toMatch(/--AccentColor:rgb\(1,\s*2,\s*3\)/);
    mount(finalized);
    document.querySelector<HTMLButtonElement>('#nai-runtime-toggle')!.click();

    const authoredCss = Array.from(document.head.querySelectorAll('style'))[1]?.textContent ?? '';
    expect(authoredCss).toMatch(/--AccentColor:rgb\(1,\s*2,\s*3\)/);
    expect(authoredCss).toContain('--Resolved:var(--AccentColor)');
  });
  it('skips the fallback for a :is theme palette', () => {
    mount('<html><head><style>[data-he-content]:is([data-theme="dark"]){--surface:#111}</style></head><body><div data-he-content></div></body></html>');

    expect(document.querySelector('#nai-theme-fallback')).toBeNull();
  });
  it('injects the fallback when a theme palette is only inside a non-matching media rule', () => {
    const matchMedia = vi.fn((condition: string) => ({ matches: condition !== 'print' }));
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: matchMedia,
    });
    mount(
      '<html><head></head><body><div data-he-content></div></body></html>',
      'scroll',
      'en',
      [{ cssRules: [{ type: 4, conditionText: 'print', cssRules: [{ selectorText: '[data-he-content][data-theme="dark"]', style: ['--surface'] }] }] }],
    );
    expect(matchMedia).toHaveBeenCalledWith('print');
    expect(document.querySelector('#nai-theme-fallback')).not.toBeNull();
  });

  it('skips the fallback when a theme palette is inside a matching media rule', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (condition: string) => ({ matches: condition === 'screen' }),
    });
    mount(
      '<html><head></head><body><div data-he-content></div></body></html>',
      'scroll',
      'en',
      [{ cssRules: [{ type: 4, conditionText: 'screen', cssRules: [{ selectorText: '[data-he-content][data-theme="dark"]', style: ['--surface'] }] }] }],
    );
    expect(document.querySelector('#nai-theme-fallback')).toBeNull();
  });


  it('localizes runtime controls while keeping the visible slide indicator numeric', () => {
    mount('<html><head></head><body><section class="slide">one</section><section class="slide">two</section></body></html>', 'slide', 'ko');

    const [previous, next] = Array.from(document.querySelectorAll<HTMLButtonElement>('.nai-slide-nav button'));
    const indicator = document.querySelector('.nai-slide-nav span')!;
    expect(document.querySelector('#nai-runtime-toggle')?.getAttribute('aria-label')).toBe('어두운 테마로 전환');
    expect(previous.getAttribute('aria-label')).toBe('이전 슬라이드');
    expect(next.getAttribute('title')).toBe('다음 슬라이드');
    expect(indicator.textContent).toBe('1/2');
    expect(indicator.getAttribute('aria-label')).toBe('슬라이드 1/2');
  });

  it('has non-empty runtime labels for all supported locales', () => {
    for (const locale of ['en', 'ko', 'zh-Hans', 'zh-Hant', 'ja'] as const) {
      const labels = htmlExportRuntimeLabels(locale);
      expect(Object.values(labels).every(Boolean), locale).toBe(true);
    }
  });

  it('skips the fallback for authored theme variables inside media rules', () => {
    mount('<html><head><style>@media screen{[data-he-content][data-theme="dark"]{--surface:#111}}</style></head><body><div data-he-content></div></body></html>');
    expect(document.querySelector('#nai-theme-fallback')).toBeNull();
  });
  it('hides inactive slides over authored important display rules and restores the active display', () => {
    mount('<html><head><style>section.slide{display:flex!important}</style></head><body><section class="slide">one</section><section class="slide">two</section></body></html>', 'slide');

    const slides = Array.from(document.querySelectorAll<HTMLElement>('section.slide'));
    const [, next] = Array.from(document.querySelectorAll<HTMLButtonElement>('.nai-slide-nav button'));

    expect(getComputedStyle(slides[0]).display).toBe('flex');
    expect(getComputedStyle(slides[1]).display).toBe('none');
    expect(slides[1].style.getPropertyPriority('display')).toBe('important');

    next.click();

    expect(getComputedStyle(slides[0]).display).toBe('none');
    expect(getComputedStyle(slides[1]).display).toBe('flex');
    expect(slides[1].style.display).toBe('');
  });
  it('shows every slide while printing, restores the active slide afterwards, and includes print-only control hiding', () => {
    mount('<html><head></head><body><section class="slide">one</section><section class="slide">two</section></body></html>', 'slide');

    const slides = Array.from(document.querySelectorAll<HTMLElement>('section.slide'));
    const [, next] = Array.from(document.querySelectorAll<HTMLButtonElement>('.nai-slide-nav button'));
    next.click();

    window.dispatchEvent(new Event('beforeprint'));
    expect(slides.every((slide) => slide.style.display === '')).toBe(true);

    window.dispatchEvent(new Event('afterprint'));
    expect(slides[0].style.getPropertyPriority('display')).toBe('important');
    expect(slides[1].style.display).toBe('');
    expect(document.querySelector('#nai-print-controls')?.textContent)
      .toContain('@media print{#nai-runtime-toggle,#nai-slide-nav{display:none!important}}');
  });
  it('uses the print media change listener when print events are unavailable', () => {
    let printListener: ((event: MediaQueryListEvent) => void) | undefined;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        matches: false,
        addEventListener: (type: string, listener: (event: MediaQueryListEvent) => void) => {
          if (query === 'print' && type === 'change') printListener = listener;
        },
      }),
    });
    mount('<html><head></head><body><section class="slide">one</section><section class="slide">two</section></body></html>', 'slide');

    const slides = Array.from(document.querySelectorAll<HTMLElement>('section.slide'));
    expect(printListener).toBeTypeOf('function');
    printListener!({ matches: true } as MediaQueryListEvent);
    expect(slides.every((slide) => slide.style.display === '')).toBe(true);
    printListener!({ matches: false } as MediaQueryListEvent);
    expect(slides[0].style.display).toBe('');
    expect(slides[1].style.getPropertyPriority('display')).toBe('important');
  });
  it('preserves required inputs that match :required in finalized artifacts', () => {
    const sanitized = sanitizeHtmlExport({
      html: '<html><head></head><body><input required></body></html>',
      isAllowedAssetId: () => true,
    });
    expect(sanitized.ok).toBe(true);
    if (!sanitized.ok) return;

    mount(bundleSanitizedHtml(sanitized).html);
    const input = document.querySelector<HTMLInputElement>('input')!;
    expect(input.hasAttribute('required')).toBe(true);
    expect(input.matches(':required')).toBe(true);
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
  it('counts only top-level slide sections so nested slide content remains visible', () => {
    mount('<html><head></head><body><section class="slide" id="parent">parent<section class="slide" id="nested">nested</section></section><section class="slide" id="second">second</section></body></html>', 'slide');

    const parent = document.querySelector<HTMLElement>('#parent')!;
    const nested = document.querySelector<HTMLElement>('#nested')!;
    const second = document.querySelector<HTMLElement>('#second')!;
    const indicator = document.querySelector('.nai-slide-nav span')!;
    const [previous, next] = Array.from(document.querySelectorAll<HTMLButtonElement>('.nai-slide-nav button'));

    expect(indicator.textContent).toBe('1/2');
    expect(parent.style.display).toBe('');
    expect(nested.style.display).toBe('');
    next.click();
    expect(indicator.textContent).toBe('2/2');
    expect(second.style.display).toBe('');
    previous.click();
    expect(indicator.textContent).toBe('1/2');
    expect(parent.style.display).toBe('');
    expect(nested.style.display).toBe('');
  });

  it('patches only the manifest runtime SHA, leaving authored CSS decoys untouched', () => {
    const decoy = '"runtimeSha256":"AAAA"';
    const output = injectHtmlExportRuntime(
      `<html><head><style>[data-he-content]{--x:'${decoy}'}</style><script id="he-manifest" type="application/json">{"runtimeSha256":"stale"}</script></head><body></body></html>`,
      'slide',
      htmlExportRuntimeLabels('ko'),
    );

    expect(output).toContain(`--x:'${decoy}'`);
    const manifest = output.match(/<script id="he-manifest"[^>]*>([\s\S]*?)<\/script>/);
    expect(manifest).not.toBeNull();
    expect(JSON.parse(manifest![1]).runtimeSha256).toBe(
      htmlExportRuntimeSha256('slide', htmlExportRuntimeLabels('ko')),
    );
  });

  it('is idempotent across double finalization', () => {
    const once = injectHtmlExportRuntime('<html><head></head><body>content</body></html>');
    const twice = injectHtmlExportRuntime(once);
    expect((twice.match(/id="nai-runtime"/g) ?? [])).toHaveLength(1);
    expect((twice.match(/http-equiv="Content-Security-Policy"/g) ?? [])).toHaveLength(1);
  });
});
