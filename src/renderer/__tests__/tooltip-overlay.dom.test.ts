// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { installTooltips } from '../tooltips';
import { wireWordmark, wordmarkTooltip, NOTEPAD_REPO_URL } from '../header-wordmark';
import { paintAccountState } from '../toolbar';
import { t } from '../i18n';

// MutationObserver callbacks run on a microtask; let them drain.
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('tooltip overlay (tooltips.ts) — AC7', () => {
  let uninstall: () => void;

  function addAnchor(tooltip: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.setAttribute('data-tooltip', tooltip);
    btn.innerHTML = '<svg></svg>';
    document.body.appendChild(btn);
    return btn;
  }

  afterEach(() => {
    uninstall?.();
    document.body.innerHTML = '';
    document.body.className = '';
  });

  it('marks the body so the CSS pseudo tooltip is suppressed (no double render)', () => {
    uninstall = installTooltips();
    expect(document.body.classList.contains('app-tooltips-on')).toBe(true);
  });

  it('creates a body-level .app-tooltip on pointer-over and clears it on pointer-out', () => {
    uninstall = installTooltips();
    const btn = addAnchor('Italic');
    btn.dispatchEvent(new Event('pointerover', { bubbles: true }));
    const tip = document.querySelector('.app-tooltip');
    expect(tip).not.toBeNull();
    expect(tip!.textContent).toBe('Italic');
    expect(tip!.getAttribute('role')).toBe('tooltip');
    expect(tip!.parentElement).toBe(document.body);

    btn.dispatchEvent(new Event('pointerout', { bubbles: true }));
    expect(document.querySelector('.app-tooltip')).toBeNull();
  });

  it('shows on focusin and hides on focusout (keyboard users)', () => {
    uninstall = installTooltips();
    const btn = addAnchor('Strikethrough');
    btn.dispatchEvent(new Event('focusin', { bubbles: true }));
    expect(document.querySelector('.app-tooltip')!.textContent).toBe('Strikethrough');
    btn.dispatchEvent(new Event('focusout', { bubbles: true }));
    expect(document.querySelector('.app-tooltip')).toBeNull();
  });

  it('delegates from a descendant (hovering the inner svg resolves the anchor)', () => {
    uninstall = installTooltips();
    const btn = addAnchor('Code');
    btn.querySelector('svg')!.dispatchEvent(new Event('pointerover', { bubbles: true }));
    expect(document.querySelector('.app-tooltip')!.textContent).toBe('Code');
  });

  it('keeps the tooltip when the pointer moves within the same anchor', () => {
    uninstall = installTooltips();
    const btn = addAnchor('Bold');
    const svg = btn.querySelector('svg')!;
    btn.dispatchEvent(new Event('pointerover', { bubbles: true }));
    expect(document.querySelector('.app-tooltip')).not.toBeNull();
    // Leaving the button toward its own child must NOT tear the tooltip down.
    btn.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: svg }));
    expect(document.querySelector('.app-tooltip')).not.toBeNull();
  });

  it('removes the orphan tooltip the moment its anchor detaches from the DOM', async () => {
    uninstall = installTooltips();
    const btn = addAnchor('Quote');
    btn.dispatchEvent(new Event('pointerover', { bubbles: true }));
    expect(document.querySelector('.app-tooltip')).not.toBeNull();

    btn.remove();
    await flush();
    expect(document.querySelector('.app-tooltip')).toBeNull();
  });

  it('removes the tooltip when a dropdown menu opens', async () => {
    uninstall = installTooltips();
    const btn = addAnchor('Link');
    btn.dispatchEvent(new Event('pointerover', { bubbles: true }));
    expect(document.querySelector('.app-tooltip')).not.toBeNull();

    const menu = document.createElement('div');
    menu.className = 'pm-menu';
    document.body.appendChild(menu);
    document.body.classList.add('menu-open');
    await flush();
    expect(document.querySelector('.app-tooltip')).toBeNull();
  });

  it('does not open a tooltip while a menu is already open', () => {
    uninstall = installTooltips();
    const menu = document.createElement('div');
    menu.className = 'pm-menu';
    document.body.appendChild(menu);

    const btn = addAnchor('Heading');
    btn.dispatchEvent(new Event('pointerover', { bubbles: true }));
    expect(document.querySelector('.app-tooltip')).toBeNull();
  });

  it('hides on mousedown anywhere', () => {
    uninstall = installTooltips();
    const btn = addAnchor('List');
    btn.dispatchEvent(new Event('pointerover', { bubbles: true }));
    expect(document.querySelector('.app-tooltip')).not.toBeNull();
    document.dispatchEvent(new Event('mousedown', { bubbles: true }));
    expect(document.querySelector('.app-tooltip')).toBeNull();
  });

  it('uninstall removes the body marker and any live tooltip', () => {
    const teardown = installTooltips();
    const btn = addAnchor('Image');
    btn.dispatchEvent(new Event('pointerover', { bubbles: true }));
    expect(document.querySelector('.app-tooltip')).not.toBeNull();
    teardown();
    expect(document.body.classList.contains('app-tooltips-on')).toBe(false);
    expect(document.querySelector('.app-tooltip')).toBeNull();
    uninstall = () => {};
  });
});

describe('wordmark wiring (header-wordmark.ts) — AC2', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('composes the tooltip as "v<version> · <star prompt>"', () => {
    expect(wordmarkTooltip('0.2.0')).toBe(`v0.2.0 · ${t('tip.wordmark')}`);
    expect(wordmarkTooltip('')).toBe(t('tip.wordmark'));
  });

  it('opens the repository externally on click', () => {
    const el = document.createElement('a');
    el.id = 'wordmark';
    document.body.appendChild(el);
    const openExternal = vi.fn();
    wireWordmark(el, { openExternal, getVersion: () => Promise.resolve('0.2.0') });

    el.dispatchEvent(new Event('click', { bubbles: true }));
    expect(openExternal).toHaveBeenCalledWith(NOTEPAD_REPO_URL);
  });

  it('opens the repository on Enter / Space for keyboard users', () => {
    const el = document.createElement('a');
    document.body.appendChild(el);
    const openExternal = vi.fn();
    wireWordmark(el, { openExternal, getVersion: () => Promise.resolve('') });

    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    expect(openExternal).toHaveBeenCalledTimes(2);
    expect(openExternal).toHaveBeenCalledWith(NOTEPAD_REPO_URL);
  });

  it('writes the version-prefixed tooltip + aria-label once the version resolves', async () => {
    const el = document.createElement('a');
    document.body.appendChild(el);
    wireWordmark(el, { openExternal: vi.fn(), getVersion: () => Promise.resolve('9.9.9') });

    // Synchronous label has no version yet.
    expect(el.dataset.tooltip).toBe(t('tip.wordmark'));
    await flush();
    const expected = `v9.9.9 · ${t('tip.wordmark')}`;
    expect(el.dataset.tooltip).toBe(expected);
    expect(el.getAttribute('aria-label')).toBe(expected);
  });

  it('falls back to the bare prompt when the version lookup rejects', async () => {
    const el = document.createElement('a');
    document.body.appendChild(el);
    wireWordmark(el, { openExternal: vi.fn(), getVersion: () => Promise.reject(new Error('no ipc')) });
    await flush();
    expect(el.dataset.tooltip).toBe(t('tip.wordmark'));
  });
});

describe('account green-dot tooltip (paintAccountState) — AC3', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function accountBtn(): HTMLElement {
    const btn = document.createElement('button');
    btn.id = 'hdr-account';
    btn.className = 'hdr-icbtn hdr-account';
    btn.setAttribute('data-tooltip', t('tip.account'));
    document.body.appendChild(btn);
    return btn;
  }

  it('signed-in: shows the dot and an explanatory tooltip', () => {
    const btn = accountBtn();
    paintAccountState(true);
    expect(btn.classList.contains('hdr-account-signed-in')).toBe(true);
    expect(btn.getAttribute('data-tooltip')).toBe(t('tip.accountSignedIn'));
    expect(btn.getAttribute('aria-label')).toBe(t('tip.accountSignedIn'));
  });

  it('signed-out: clears the dot and restores the default tooltip', () => {
    const btn = accountBtn();
    paintAccountState(true);
    paintAccountState(false);
    expect(btn.classList.contains('hdr-account-signed-in')).toBe(false);
    expect(btn.getAttribute('data-tooltip')).toBe(t('tip.account'));
  });
});
