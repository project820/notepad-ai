// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createToolbar, type ToolbarHandlers } from '../toolbar';
import { createPreview } from '../preview';
import { loadPrefs, savePrefs, migratePrefs } from '../prefs';
import { t } from '../i18n';

function stubHandlers(over: Partial<ToolbarHandlers> = {}): ToolbarHandlers {
  return {
    onFormat: vi.fn(),
    onInsertTable: vi.fn(),
    onTogglePreview: vi.fn(),
    onToggleSideChat: vi.fn(),
    onThemeChange: vi.fn(),
    onFontSizeChange: vi.fn(),
    onModelChange: vi.fn(),
    onLocaleChange: vi.fn(),
    onSignIn: vi.fn(),
    onSignOut: vi.fn(),
    getTheme: () => 'system',
    getFontSize: () => 'md',
    getModel: () => 'gpt-5.4-mini',
    getLocale: () => 'en',
    getAuth: () => ({ signedIn: false }),
    loadModels: async () => [],
    ...over,
  };
}

function mountToolbar(over: Partial<ToolbarHandlers> = {}) {
  document.body.innerHTML = `<div id="navbar-controls"></div><div id="toolbar"></div>`;
  const host = document.getElementById('toolbar') as HTMLDivElement;
  const handlers = stubHandlers(over);
  createToolbar(host, handlers);
  return { host, controls: document.getElementById('navbar-controls') as HTMLDivElement, handlers };
}

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('toolbar #4 — left-panel toggle moved into the toolbar (AC5)', () => {
  it('renders #tb-toggle-outline inside the toolbar .tb-lead group', () => {
    const { host } = mountToolbar();
    const lead = host.querySelector('.tb-row .tb-lead');
    expect(lead).not.toBeNull();
    const btn = host.querySelector('#tb-toggle-outline');
    expect(btn).not.toBeNull();
    expect(lead!.contains(btn)).toBe(true);
    expect(btn!.getAttribute('data-tooltip')).toBe(t('tip.outline'));
  });

  it('no longer renders the #hdr-outline button in the header controls', () => {
    const { controls } = mountToolbar();
    expect(controls.querySelector('#hdr-outline')).toBeNull();
  });

  it('clicking the toolbar outline toggle calls onToggleOutline', () => {
    const onToggleOutline = vi.fn();
    const { host } = mountToolbar({ onToggleOutline });
    host.querySelector<HTMLButtonElement>('#tb-toggle-outline')!.click();
    expect(onToggleOutline).toHaveBeenCalledTimes(1);
  });
});

describe('toolbar #6 — footnote button (AC7)', () => {
  it('renders a footnote button with the tip.footnote tooltip', () => {
    const { host } = mountToolbar();
    const btn = host.querySelector<HTMLButtonElement>('[data-id="fmt-footnote"]');
    expect(btn).not.toBeNull();
    expect(btn!.getAttribute('data-tooltip')).toBe(t('tip.footnote'));
  });

  it('clicking the footnote button dispatches the footnote format action', () => {
    const onFormat = vi.fn();
    const { host } = mountToolbar({ onFormat });
    host.querySelector<HTMLButtonElement>('[data-id="fmt-footnote"]')!.click();
    expect(onFormat).toHaveBeenCalledWith('footnote');
  });
});

describe('toolbar #8 — preview line-number toggle (AC8)', () => {
  it('reflects the current state in aria-pressed and flips it on click', () => {
    let on = false;
    const onTogglePreviewLines = vi.fn(() => {
      on = !on;
    });
    const { host } = mountToolbar({ onTogglePreviewLines, getPreviewLines: () => on });
    const btn = host.querySelector<HTMLButtonElement>('#tb-preview-lines')!;
    expect(btn).not.toBeNull();
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.getAttribute('data-tooltip')).toBe(t('tip.previewLines'));

    btn.click();
    expect(onTogglePreviewLines).toHaveBeenCalledTimes(1);
    expect(on).toBe(true);
    expect(btn.getAttribute('aria-pressed')).toBe('true');

    btn.click();
    expect(on).toBe(false);
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });

  it('renders aria-pressed=true when the pref is already on', () => {
    const { host } = mountToolbar({ getPreviewLines: () => true });
    expect(host.querySelector('#tb-preview-lines')!.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('preview.setLineNumbers toggles the gutter class', () => {
  it('adds and removes the preview-line-numbers class on the preview root', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const preview = createPreview(parent);
    expect(preview.el.classList.contains('preview-line-numbers')).toBe(false);
    preview.setLineNumbers(true);
    expect(preview.el.classList.contains('preview-line-numbers')).toBe(true);
    preview.setLineNumbers(false);
    expect(preview.el.classList.contains('preview-line-numbers')).toBe(false);
  });
});

describe('prefs.previewLineNumbers persistence (AC8)', () => {
  it('defaults to false', () => {
    expect(migratePrefs(null).previewLineNumbers).toBe(false);
  });

  it('round-trips through save/load', () => {
    const p = migratePrefs(null);
    p.previewLineNumbers = true;
    savePrefs(p);
    expect(loadPrefs().previewLineNumbers).toBe(true);
  });
});
