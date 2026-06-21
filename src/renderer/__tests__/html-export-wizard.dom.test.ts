// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountHtmlExportWizard, type HtmlExportDeps } from '../html-export-wizard';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const GENERATED_HTML = '<!doctype html><html><head><title>My Report</title></head><body><h1>Hi</h1></body></html>';

function setup(over: Partial<HtmlExportDeps> = {}, markdown = '# Title\n\nSome body.') {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const mdRef = { value: markdown };
  const deps: HtmlExportDeps = {
    getMarkdown: () => mdRef.value,
    getCurrentPath: () => null,
    getPendingTitle: () => 'Untitled',
    fetchDesignMd: vi.fn(async () => ({ ok: true, designMd: '## tokens', rawUrl: 'https://raw/x/DESIGN.md' })),
    saveHtml: vi.fn(async () => ({ saved: true, filePath: '/tmp/My Report.html' })),
    openSavedHtml: vi.fn(async () => ({ opened: true })),
    aiGenerate: vi.fn(() => ({ result: Promise.resolve(GENERATED_HTML), cancel: vi.fn() })),
    openExternal: vi.fn(),
    t: (k) => k,
    ...over,
  };
  const handle = mountHtmlExportWizard(host, deps);
  return { host, deps, handle, mdRef };
}

function click(host: HTMLElement, action: string) {
  const el = host.querySelector<HTMLElement>(`[data-he="${action}"]`);
  if (!el) throw new Error(`missing [data-he="${action}"] in step; html=${host.innerHTML.slice(0, 200)}`);
  el.click();
}

function setField(host: HTMLElement, name: string, value: string) {
  const el = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-he-field="${name}"]`);
  if (!el) throw new Error(`missing [data-he-field="${name}"]`);
  el.value = value;
}

describe('mountHtmlExportWizard — full flow', () => {
  it('orientation → layout → design → tone → generate → download → open-saved', async () => {
    const { host, deps, handle, mdRef } = setup();
    expect(handle.getState().step).toBe('choose-orientation');

    click(host, 'orient-vertical');
    expect(handle.getState().step).toBe('choose-layout');

    click(host, 'layout-slides'); // vertical + slides combo is allowed
    expect(handle.getState().step).toBe('choose-design');

    setField(host, 'design', 'replicate');
    click(host, 'design-submit');
    expect(handle.getState().step).toBe('fetching-design');
    await flush();
    expect(deps.fetchDesignMd).toHaveBeenCalledWith('replicate');
    expect(handle.getState().step).toBe('style-tone');
    expect(handle.getState().design).toEqual({ designMd: '## tokens', rawUrl: 'https://raw/x/DESIGN.md' });

    setField(host, 'tone', 'minimal and elegant');
    click(host, 'tone-submit');
    // Short markdown → no token warning → straight to generating.
    expect(handle.getState().step).toBe('generating');
    expect(deps.aiGenerate).toHaveBeenCalledTimes(1);
    expect((deps.aiGenerate as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('minimal and elegant');
    await flush();
    expect(handle.getState().step).toBe('generated');
    expect(handle.getState().generated?.title).toBe('My Report');
    expect(handle.getState().generated?.bytes).toBeGreaterThan(0);

    click(host, 'download');
    expect(handle.getState().step).toBe('saving');
    await flush();
    expect(deps.saveHtml).toHaveBeenCalledTimes(1);
    const saveArg = (deps.saveHtml as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // AC12: the saved artifact carries the injected base CSS plus all original content.
    expect(saveArg.html).toContain('data-notepad-ai-base="1"');
    expect(saveArg.html).toContain('<h1>Hi</h1>');
    expect(saveArg.html).toContain('<title>My Report</title>');
    expect(saveArg.defaultName).toBe('My Report.html'); // from AI <title> (doc is Untitled)
    expect(handle.getState().step).toBe('saved');
    expect(handle.getState().savedPath).toBe('/tmp/My Report.html');

    // Saved card shows "open in browser" and clicking it calls openSavedHtml once with the saved path.
    const openBtn = host.querySelector('[data-he="open-saved"]');
    expect(openBtn).toBeTruthy();
    click(host, 'open-saved');
    expect(handle.getState().step).toBe('opening-saved');
    await flush();
    expect(deps.openSavedHtml).toHaveBeenCalledTimes(1);
    expect(deps.openSavedHtml).toHaveBeenCalledWith('/tmp/My Report.html');
    expect(handle.getState().step).toBe('saved');

    // The Markdown source was never mutated by the wizard.
    expect(mdRef.value).toBe('# Title\n\nSome body.');
  });
});

describe('mountHtmlExportWizard — fetch failure falls back to tone-only', () => {
  it('FETCH_FAIL lands on style-tone with an error, then still generates', async () => {
    const { host, deps, handle } = setup({
      fetchDesignMd: vi.fn(async () => ({ ok: false, error: 'offline' })),
    });
    click(host, 'orient-horizontal');
    click(host, 'layout-scroll');
    setField(host, 'design', 'replicate');
    click(host, 'design-submit');
    await flush();
    expect(handle.getState().step).toBe('style-tone');
    expect(handle.getState().fetchError).toBe('offline');
    expect(handle.getState().design).toBeUndefined();
    // The error banner is rendered.
    expect(host.querySelector('.he-error')).toBeTruthy();

    // Tone-only generation still works.
    setField(host, 'tone', '');
    click(host, 'tone-submit');
    expect(handle.getState().step).toBe('generating');
    await flush();
    expect(handle.getState().step).toBe('generated');
  });
});

describe('mountHtmlExportWizard — token warning gate', () => {
  it('a long document stops at token-warning until confirmed', async () => {
    const { host, deps, handle } = setup({ maxSourceCharsForModel: () => 1000 }, 'z'.repeat(20000));
    click(host, 'orient-vertical');
    click(host, 'layout-scroll');
    click(host, 'design-skip');
    expect(handle.getState().step).toBe('style-tone');

    setField(host, 'tone', 'bold');
    click(host, 'tone-submit');
    // Generation must NOT start before confirmation.
    expect(handle.getState().step).toBe('token-warning');
    expect(deps.aiGenerate).not.toHaveBeenCalled();

    click(host, 'token-confirm');
    expect(handle.getState().step).toBe('generating');
    expect(deps.aiGenerate).toHaveBeenCalledTimes(1);
    await flush();
    expect(handle.getState().step).toBe('generated');
  });
});

describe('mountHtmlExportWizard — HTML-only model picker', () => {
  it('renders a model picker on style-tone and routes the chosen model to aiGenerate', async () => {
    const { host, deps, handle } = setup({
      listHtmlModels: async () => [
        { provider: 'chatgpt', id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', contextWindow: 400_000 },
        { provider: 'chatgpt', id: 'gpt-5.4', label: 'GPT-5.4', contextWindow: 1_000_000 },
      ],
      getDefaultModel: () => ({ provider: 'chatgpt', id: 'gpt-5.4-mini' }),
    });
    click(host, 'orient-vertical');
    click(host, 'layout-scroll');
    click(host, 'design-skip');
    await flush(); // model list resolves, style-tone re-renders with the picker
    const select = host.querySelector<HTMLSelectElement>('[data-he-field="model"]');
    expect(select).toBeTruthy();
    // Default is preselected.
    expect(select!.value).toBe('chatgpt:gpt-5.4-mini');
    // 1M-context models are distinguishable by a context badge in the option text.
    const optText = Array.from(select!.querySelectorAll('option')).map((o) => o.textContent);
    expect(optText).toContain('GPT-5.4 · 1M');
    expect(optText).toContain('GPT-5.4 mini · 400K');
    // Pick the bigger model.
    select!.value = 'chatgpt:gpt-5.4';
    click(host, 'tone-submit');
    await flush();
    expect(deps.aiGenerate).toHaveBeenCalledTimes(1);
    const passedModel = (deps.aiGenerate as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(passedModel).toEqual({ provider: 'chatgpt', id: 'gpt-5.4' });
  });
});

describe('mountHtmlExportWizard — non-HTML AI reply surfaces an error', () => {
  it('AI replies without an HTML document → error step', async () => {
    const { host, handle } = setup({
      aiGenerate: vi.fn(() => ({ result: Promise.resolve('Sorry, here is markdown instead'), cancel: vi.fn() })),
    });
    click(host, 'orient-vertical');
    click(host, 'layout-scroll');
    click(host, 'design-skip');
    setField(host, 'tone', '');
    click(host, 'tone-submit');
    await flush();
    expect(handle.getState().step).toBe('error');
    expect(host.querySelector('.he-error')).toBeTruthy();
  });
});

describe('mountHtmlExportWizard — open failure keeps the saved file', () => {
  it('OPEN_ERROR returns to the saved card with a visible error', async () => {
    const { host, handle } = setup({
      openSavedHtml: vi.fn(async () => ({ opened: false, error: 'no handler' })),
    });
    click(host, 'orient-vertical');
    click(host, 'layout-scroll');
    click(host, 'design-skip');
    setField(host, 'tone', '');
    click(host, 'tone-submit');
    await flush();
    click(host, 'download');
    await flush();
    expect(handle.getState().step).toBe('saved');
    click(host, 'open-saved');
    await flush();
    expect(handle.getState().step).toBe('saved');
    expect(handle.getState().error).toBe('no handler');
    expect(handle.getState().savedPath).toBeTruthy();
  });
});

describe('mountHtmlExportWizard — local model context badge + small-model notice (G003)', () => {
  it('lists a local model with a context badge and warns when its context window is small', async () => {
    const { host, handle } = setup({
      listHtmlModels: async () => [
        { provider: 'chatgpt', id: 'gpt-5.4', label: 'GPT-5.4', contextWindow: 1_000_000 },
        { provider: 'ollama', id: 'llama3:latest', label: 'llama3:latest', contextWindow: 8_192 },
      ],
      getDefaultModel: () => ({ provider: 'ollama', id: 'llama3:latest' }),
    });
    click(host, 'orient-vertical');
    click(host, 'layout-scroll');
    click(host, 'design-skip');
    await flush(); // model list resolves → style-tone re-renders with the picker
    const select = host.querySelector<HTMLSelectElement>('[data-he-field="model"]');
    expect(select).toBeTruthy();
    // The small local model (the default) is preselected; provider:id key survives a colon-in-id.
    expect(select!.value).toBe('ollama:llama3:latest');
    const optText = Array.from(select!.querySelectorAll('option')).map((o) => o.textContent);
    expect(optText).toContain('llama3:latest · 8K'); // local option + context badge
    expect(optText).toContain('GPT-5.4 · 1M');
    // Small-context advisory visible for the small local default (deps.t echoes the key).
    const note = host.querySelector<HTMLElement>('[data-he-note="model"]');
    expect(note).toBeTruthy();
    expect(note!.hidden).toBe(false);
    expect(note!.textContent).toContain('he.smallContext');
    // Switching to the large cloud model hides the advisory.
    select!.value = 'chatgpt:gpt-5.4';
    select!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(host.querySelector<HTMLElement>('[data-he-note="model"]')!.hidden).toBe(true);
    expect(handle.getState().step).toBe('style-tone');
  });

  it('does not show the small-context notice for large cloud models', async () => {
    const { host } = setup({
      listHtmlModels: async () => [
        { provider: 'chatgpt', id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', contextWindow: 400_000 },
      ],
      getDefaultModel: () => ({ provider: 'chatgpt', id: 'gpt-5.4-mini' }),
    });
    click(host, 'orient-vertical');
    click(host, 'layout-scroll');
    click(host, 'design-skip');
    await flush();
    const note = host.querySelector<HTMLElement>('[data-he-note="model"]');
    expect(note!.hidden).toBe(true);
  });
});

describe('mountHtmlExportWizard — auto/detail mode + purpose (G005 AC7/AC8/AC9/AC10)', () => {
  const toStyleTone = (host: HTMLElement) => {
    click(host, 'orient-vertical');
    click(host, 'layout-scroll');
    click(host, 'design-skip');
  };

  it('defaults to auto mode (no detail knobs) and shows the purpose select', () => {
    const { host } = setup();
    toStyleTone(host);
    expect(host.querySelector('[data-he-field="purpose"]')).toBeTruthy();
    // auto mode hides the detail knobs
    expect(host.querySelector('[data-he-field="density"]')).toBeNull();
    expect(host.querySelector('[data-he-field="interactive"]')).toBeNull();
  });

  it('switching to detail reveals density/width/interactive knobs', () => {
    const { host, handle } = setup();
    toStyleTone(host);
    click(host, 'mode-detail');
    expect(handle.getState().mode).toBe('detail');
    expect(host.querySelector('[data-he-field="density"]')).toBeTruthy();
    expect(host.querySelector('[data-he-field="readable-width"]')).toBeTruthy();
    expect(host.querySelector('[data-he-field="interactive"]')).toBeTruthy();
  });

  it('routes the chosen purpose + detail knobs into the generation prompt', async () => {
    const { host, deps } = setup();
    toStyleTone(host);
    click(host, 'mode-detail');
    (host.querySelector('[data-he-field="purpose"]') as HTMLSelectElement).value = 'landing';
    (host.querySelector('[data-he-field="density"]') as HTMLSelectElement).value = 'roomy';
    (host.querySelector('[data-he-field="interactive"]') as HTMLInputElement).checked = true;
    setField(host, 'tone', 'bold and modern');
    click(host, 'tone-submit');
    await flush();
    const prompt = (deps.aiGenerate as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain('PURPOSE:');
    expect(prompt).toContain('landing page');
    expect(prompt).toContain('DENSITY: roomy');
    expect(prompt).toContain('INTERACTIVITY: tasteful');
  });
});

describe('mountHtmlExportWizard — getdesign list rows (G005 AC11)', () => {
  const designs = [
    { slug: 'claude', name: 'Claude', pageUrl: 'https://getdesign.md/claude' },
    { slug: 'replicate', name: 'Replicate', pageUrl: 'https://getdesign.md/replicate' },
  ];

  it('renders a row per design, fills the input on pick, and opens the page link', async () => {
    const openExternal = vi.fn();
    const { host } = setup({
      listDesigns: vi.fn(async () => ({ ok: true, designs })),
      openExternal,
    });
    click(host, 'orient-vertical');
    click(host, 'layout-scroll');
    await flush(); // design list resolves + re-renders the choose-design step
    const rows = host.querySelectorAll('.he-design-row');
    expect(rows.length).toBe(2);

    host.querySelector<HTMLButtonElement>('[data-he="design-pick"][data-slug="replicate"]')!.click();
    expect(host.querySelector<HTMLInputElement>('[data-he-field="design"]')!.value).toBe('replicate');

    host.querySelector<HTMLElement>('[data-he="design-page"][data-url="https://getdesign.md/claude"]')!.click();
    expect(openExternal).toHaveBeenCalledWith('https://getdesign.md/claude');
  });

  it('falls back to the text input only when the catalog is empty/unavailable', async () => {
    const { host } = setup({ listDesigns: vi.fn(async () => ({ ok: false, error: 'offline' })) });
    click(host, 'orient-vertical');
    click(host, 'layout-scroll');
    await flush();
    expect(host.querySelectorAll('.he-design-row').length).toBe(0);
    expect(host.querySelector('[data-he-field="design"]')).toBeTruthy();
  });
});
