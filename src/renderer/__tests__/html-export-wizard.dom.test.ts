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
    expect(saveArg.html).toBe(GENERATED_HTML);
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
