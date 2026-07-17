// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createToolbar, type ToolbarHandlers } from '../toolbar';
import { createPreview } from '../preview';
import { loadPrefs, savePrefs, migratePrefs } from '../prefs';
import { t, setLocale } from '../i18n';
import { closeOpenMenu } from '../dropdown';

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
  closeOpenMenu();
  document.body.innerHTML = '';
  localStorage.clear();
  vi.useRealTimers();
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

describe('toolbar #G005 — raw line-alignment toggle', () => {
  it('reflects the current state in aria-pressed and flips it on click', () => {
    let on = false;
    const onToggleRawLineAlign = vi.fn(() => {
      on = !on;
    });
    const { host } = mountToolbar({ onToggleRawLineAlign, getRawLineAlign: () => on });
    const btn = host.querySelector<HTMLButtonElement>('#tb-raw-line-align')!;
    expect(btn).not.toBeNull();
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.getAttribute('data-tooltip')).toBe(t('tip.rawLineAlign'));

    btn.click();
    expect(onToggleRawLineAlign).toHaveBeenCalledTimes(1);
    expect(on).toBe(true);
    expect(btn.getAttribute('aria-pressed')).toBe('true');

    btn.click();
    expect(on).toBe(false);
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });

  it('renders aria-pressed=true when the pref is already on', () => {
    const { host } = mountToolbar({ getRawLineAlign: () => true });
    expect(host.querySelector('#tb-raw-line-align')!.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('prefs.rawLineAlign persistence (#G005)', () => {
  it('defaults to false', () => {
    expect(migratePrefs(null).rawLineAlign).toBe(false);
  });

  it('round-trips through save/load', () => {
    const p = migratePrefs(null);
    p.rawLineAlign = true;
    savePrefs(p);
    expect(loadPrefs().rawLineAlign).toBe(true);
  });
});

describe('i18n — raw line alignment tooltip (#G005)', () => {
  afterEach(() => setLocale('en'));

  it('exposes tip.rawLineAlign in all five locales', () => {
    const expected: Record<string, string> = {
      en: 'Align raw lines with preview',
      ko: '원본을 미리보기에 줄맞춤',
      'zh-Hans': '将原文行与预览对齐',
      'zh-Hant': '將原文行與預覽對齊',
      ja: '原文をプレビューに整列',
    };
    for (const [loc, label] of Object.entries(expected)) {
      setLocale(loc as never);
      expect(t('tip.rawLineAlign'), `tip @ ${loc}`).toBe(label);
    }
  });
});

describe('toolbar — model dropdown (G003 local providers)', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  afterEach(() => closeOpenMenu());

  it('lists local models with a provider+context hint and passes provider:id on select', async () => {
    const onModelChange = vi.fn();
    const { controls } = mountToolbar({
      onModelChange,
      getModel: () => 'gpt-5.4-mini',
      onOpenSettings: vi.fn(),
      loadModels: async () => [
        { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', provider: 'chatgpt', contextWindow: 400_000 },
        { id: 'llama3:latest', label: 'llama3:latest', provider: 'ollama', contextWindow: 32_000 },
        { id: 'grok-4.5', label: 'Grok 4.5', provider: 'grok', contextWindow: 256_000 },
        { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'claude', contextWindow: 200_000 },
      ],
    });
    await flush(); // model cache warmed by the startup loadModels()
    controls.querySelector<HTMLButtonElement>('#hdr-model')!.click();
    await flush();
    const items = Array.from(document.querySelectorAll('.pm-item'));
    const llama = items.find((i) => i.getAttribute('data-value') === 'ollama:llama3:latest');
    expect(llama).toBeTruthy();
    expect(llama!.textContent).toContain('Ollama'); // provider label
    expect(llama!.textContent).toContain('32K'); // context badge
    const grok = items.find((i) => i.getAttribute('data-value') === 'grok:grok-4.5');
    expect(grok).toBeTruthy();
    expect(grok!.textContent).toContain('Grok');
    expect(items.find((i) => i.getAttribute('data-value') === 'claude:claude-sonnet-4-6')).toBeUndefined();
    (llama as HTMLButtonElement).click();
    expect(onModelChange).toHaveBeenCalledWith('ollama:llama3:latest');
  });
  it('migrates a hidden persisted model to the first available model', async () => {
    const onModelChange = vi.fn();
    const { controls } = mountToolbar({
      onModelChange,
      getModel: () => ({ provider: 'grok', id: 'grok-composer-2.5-fast' }),
      loadModels: async () => [{ id: 'gpt-5.6', provider: 'chatgpt' }],
    });

    await flush();
    controls.querySelector<HTMLButtonElement>('#hdr-model')!.click();
    await flush();

    expect(onModelChange).toHaveBeenCalledTimes(1);
    expect(onModelChange).toHaveBeenCalledWith('chatgpt:gpt-5.6');
  });

  it('does not migrate a visible persisted model', async () => {
    const onModelChange = vi.fn();
    const { controls } = mountToolbar({
      onModelChange,
      getModel: () => ({ provider: 'chatgpt', id: 'gpt-5.6' }),
      loadModels: async () => [{ id: 'gpt-5.6', provider: 'chatgpt' }],
    });

    await flush();
    controls.querySelector<HTMLButtonElement>('#hdr-model')!.click();
    await flush();

    expect(onModelChange).not.toHaveBeenCalled();
  });
  it('uses the fresh inventory to hide a newly unavailable composer selection', async () => {
    const onModelChange = vi.fn();
    let calls = 0;
    const { controls } = mountToolbar({
      onModelChange,
      getModel: () => ({ provider: 'grok', id: 'grok-composer-2.5-fast' }),
      loadModels: async () => {
        calls += 1;
        return calls === 1
          ? [{ id: 'grok-composer-2.5-fast', provider: 'grok' }]
          : [{ id: 'gpt-5.6', provider: 'chatgpt' }];
      },
    });

    await flush();
    controls.querySelector<HTMLButtonElement>('#hdr-model')!.click();
    await flush();

    expect(document.querySelector('[data-value="grok:grok-composer-2.5-fast"]')).toBeNull();
    expect(onModelChange).toHaveBeenCalledTimes(1);
    expect(onModelChange).toHaveBeenCalledWith('chatgpt:gpt-5.6');
  });
  it('opens from the cached inventory when a forced refresh stalls', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const { controls } = mountToolbar({
      loadModels: () => {
        calls += 1;
        if (calls === 1) return Promise.resolve([{ id: 'gpt-5.6', provider: 'chatgpt' }]);
        return new Promise(() => {});
      },
    });

    await Promise.resolve();
    controls.querySelector<HTMLButtonElement>('#hdr-model')!.click();
    await vi.advanceTimersByTimeAsync(1_500);

    expect(document.querySelector('[data-value="chatgpt:gpt-5.6"]')).not.toBeNull();
  });
  it('hides composer from a stale cached inventory when the forced refresh stalls', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const { controls } = mountToolbar({
      loadModels: () => {
        calls += 1;
        return calls === 1
          ? Promise.resolve([{ id: 'grok-composer-2.5-fast', provider: 'grok' }])
          : new Promise(() => {});
      },
    });
    await Promise.resolve();
    controls.querySelector<HTMLButtonElement>('#hdr-model')!.click();
    await vi.advanceTimersByTimeAsync(1_500);

    expect(document.querySelector('[data-value="grok:grok-composer-2.5-fast"]')).toBeNull();
  });
  it('shows composer from a fresh inventory', async () => {
    const { controls } = mountToolbar({
      loadModels: async () => [{ id: 'grok-composer-2.5-fast', provider: 'grok' }],
    });
    await flush();
    controls.querySelector<HTMLButtonElement>('#hdr-model')!.click();
    await flush();

    expect(document.querySelector('[data-value="grok:grok-composer-2.5-fast"]')).not.toBeNull();
  });
  it('migrates a stale persisted composer after the startup snapshot resolves and refresh stalls', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    document.body.innerHTML = `<div id="navbar-controls"></div><div id="toolbar"></div>`;
    const { createToolbar } = await import('../toolbar');
    const onModelChange = vi.fn();
    let calls = 0;
    createToolbar(document.getElementById('toolbar')!, stubHandlers({
      getModel: () => ({ provider: 'grok', id: 'grok-composer-2.5-fast' }),
      onModelChange,
      loadModels: () => {
        calls += 1;
        return calls === 1
          ? Promise.resolve([{ id: 'gpt-5.6', provider: 'chatgpt' }])
          : new Promise(() => {});
      },
    }));
    await Promise.resolve();
    await Promise.resolve();

    document.querySelector<HTMLButtonElement>('#hdr-model')!.click();
    await vi.advanceTimersByTimeAsync(1_500);

    expect(onModelChange).toHaveBeenCalledTimes(1);
    expect(onModelChange).toHaveBeenCalledWith('chatgpt:gpt-5.6');
  });

  it('does not migrate while the startup snapshot remains unresolved', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    document.body.innerHTML = `<div id="navbar-controls"></div><div id="toolbar"></div>`;
    const { createToolbar } = await import('../toolbar');
    const onModelChange = vi.fn();
    createToolbar(document.getElementById('toolbar')!, stubHandlers({
      getModel: () => ({ provider: 'grok', id: 'grok-composer-2.5-fast' }),
      onModelChange,
      loadModels: () => new Promise(() => {}),
    }));

    document.querySelector<HTMLButtonElement>('#hdr-model')!.click();
    await vi.advanceTimersByTimeAsync(1_500);

    expect(onModelChange).not.toHaveBeenCalled();
  });

  it('does not migrate a visible selection while a transient empty inventory is reinjected', async () => {
    const onModelChange = vi.fn();
    const { controls } = mountToolbar({
      onModelChange,
      getModel: () => ({ provider: 'chatgpt', id: 'gpt-5.6' }),
      loadModels: async () => [],
    });

    await flush();
    controls.querySelector<HTMLButtonElement>('#hdr-model')!.click();
    await flush();

    expect(document.querySelector('[data-value="chatgpt:gpt-5.6"]')).not.toBeNull();
    expect(onModelChange).not.toHaveBeenCalled();
  });
});

describe('toolbar — AI consultant header button (AC1)', () => {
  it('renders #hdr-sidechat as a red "Ai" pill with the consultant tooltip', () => {
    const { controls } = mountToolbar();
    const btn = controls.querySelector<HTMLButtonElement>('#hdr-sidechat')!;
    expect(btn).not.toBeNull();
    expect(btn.classList.contains('hdr-ai-consultant')).toBe(true);
    expect(btn.textContent?.trim()).toBe('Ai');
    expect(btn.querySelector('.hdr-ai-label')).not.toBeNull();
    expect(btn.getAttribute('data-tooltip')).toBe(t('tip.sidechat'));
    expect(btn.getAttribute('aria-label')).toBe(t('tip.sidechat'));
    // no leftover floating action button in the header controls
    expect(controls.querySelector('#ai-fab')).toBeNull();
    expect(controls.querySelector('.ai-fab')).toBeNull();
  });

  it('clicking the AI consultant button toggles the unified chat', () => {
    const onToggleSideChat = vi.fn();
    const { controls } = mountToolbar({ onToggleSideChat });
    controls.querySelector<HTMLButtonElement>('#hdr-sidechat')!.click();
    expect(onToggleSideChat).toHaveBeenCalledTimes(1);
  });
});
