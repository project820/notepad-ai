// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountHtmlExportWizard, type HtmlExportDeps } from '../html-export-wizard';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A valid ContentModel JSON reply (the AI outputs a content model, never HTML). */
const CONTENT_MODEL = {
  title: 'My Report',
  sections: [{ title: 'Intro', blocks: [{ kind: 'paragraph', text: 'Hello world.' }] }],
};
const CONTENT_JSON = JSON.stringify(CONTENT_MODEL);

function setup(over: Partial<HtmlExportDeps> = {}, markdown = '# Title\n\nSome body.') {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const mdRef = { value: markdown };
  const deps: HtmlExportDeps = {
    getMarkdown: () => mdRef.value,
    fetchDesignMd: vi.fn(async () => ({ ok: true, designMd: '## tokens', rawUrl: 'https://raw/x/DESIGN.md' })),
    aiGenerate: vi.fn(() => ({ result: Promise.resolve(CONTENT_JSON), cancel: vi.fn() })),
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

/** Last prompt string passed to aiGenerate. */
function lastPrompt(deps: HtmlExportDeps): string {
  const calls = (deps.aiGenerate as ReturnType<typeof vi.fn>).mock.calls;
  return calls[calls.length - 1][0] as string;
}

describe('mountHtmlExportWizard — generate composes ONE prompt from all four selections + the free requirement', () => {
  it('sends a single aiGenerate prompt reflecting orientation, layout, design, A/B/C/D mode, and the free requirement', async () => {
    const { host, deps, handle, mdRef } = setup();
    expect(handle.getState().step).toBe('choose-orientation');

    // Core selection 1 + 2: orientation + layout (vertical + slides is allowed).
    click(host, 'orient-vertical');
    click(host, 'layout-slides');
    expect(handle.getState().step).toBe('choose-design');

    // Core selection 3: a mandatory design.md (fetched from getdesign).
    setField(host, 'design', 'replicate');
    click(host, 'design-submit');
    expect(handle.getState().step).toBe('fetching-design');
    await flush();
    expect(deps.fetchDesignMd).toHaveBeenCalledWith('replicate');
    expect(handle.getState().step).toBe('summary-requirement');
    expect(handle.getState().designSource).toBe('getdesign');

    // Core selection 4: summary/chart strength A/B/C/D.
    click(host, 'summary-C');
    expect(handle.getState().summaryChartMode).toBe('C');

    // The single free-text requirement.
    setField(host, 'free-requirement', 'keep it punchy and chart-heavy');
    click(host, 'generate-submit');

    // Exactly ONE composed prompt block is sent to the model.
    expect(deps.aiGenerate).toHaveBeenCalledTimes(1);
    const prompt = lastPrompt(deps);
    // Every selection is provably reflected in that single block.
    expect(prompt).toContain('VERTICAL'); // orientation
    expect(prompt).toContain('SLIDES'); // layout
    expect(prompt).toContain('design source: getdesign'); // design provenance
    expect(prompt).toContain('## tokens'); // the fetched design.md content
    expect(prompt).toContain('summary/chart mode: C'); // A/B/C/D selection
    expect(prompt).toContain('keep it punchy and chart-heavy'); // free requirement

    // The reply is parsed into a validated content model — no HTML is authored.
    expect(handle.getState().step).toBe('generating');
    await flush();
    expect(handle.getState().step).toBe('generated');
    expect(handle.getState().contentModel?.title).toBe('My Report');

    // The Markdown source was never mutated by the wizard.
    expect(mdRef.value).toBe('# Title\n\nSome body.');
  });

  it('defaults to summary mode B when the user does not pick one', async () => {
    const { host, deps } = setup();
    click(host, 'orient-vertical');
    click(host, 'layout-scroll');
    click(host, 'design-default');
    setField(host, 'free-requirement', '');
    click(host, 'generate-submit');
    await flush();
    expect(lastPrompt(deps)).toContain('summary/chart mode: B');
  });

  it('keeps the typed free requirement when switching A/B/C/D (no re-render wipe)', async () => {
    const { host, deps } = setup();
    click(host, 'orient-vertical');
    click(host, 'layout-scroll');
    click(host, 'design-default');
    // Type the requirement, then change the summary mode (which re-renders).
    const ta = host.querySelector<HTMLTextAreaElement>('[data-he-field="free-requirement"]')!;
    ta.value = 'audience: execs';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    click(host, 'summary-A');
    // The textarea is repopulated from state after the re-render.
    expect(host.querySelector<HTMLTextAreaElement>('[data-he-field="free-requirement"]')!.value).toBe('audience: execs');
    click(host, 'generate-submit');
    await flush();
    expect(lastPrompt(deps)).toContain('audience: execs');
  });
});

describe('mountHtmlExportWizard — design fetch failure keeps choose-design (design.md is mandatory)', () => {
  it('FETCH_FAIL stays on choose-design with an error and never advances to generation', async () => {
    const { host, deps, handle } = setup({
      fetchDesignMd: vi.fn(async () => ({ ok: false, error: 'offline' })),
    });
    click(host, 'orient-horizontal');
    click(host, 'layout-scroll');
    setField(host, 'design', 'replicate');
    click(host, 'design-submit');
    await flush();

    // The wizard did NOT silently proceed.
    expect(handle.getState().step).toBe('choose-design');
    expect(handle.getState().fetchError).toBe('offline');
    expect(handle.getState().design).toBeUndefined();
    expect(host.querySelector('.he-error')).toBeTruthy();
    expect(deps.aiGenerate).not.toHaveBeenCalled();

    // The explicit default-design action is the only no-fetch way forward.
    click(host, 'design-default');
    expect(handle.getState().step).toBe('summary-requirement');
    setField(host, 'free-requirement', '');
    click(host, 'generate-submit');
    expect(handle.getState().step).toBe('generating');
    await flush();
    expect(handle.getState().step).toBe('generated');
    // The default-design provenance is recorded in the single prompt.
    expect(lastPrompt(deps)).toContain('design source: default');
  });
});

describe('mountHtmlExportWizard — token warning gate', () => {
  it('a long document stops at token-warning until confirmed', async () => {
    const { host, deps, handle } = setup({ maxSourceCharsForModel: () => 1000 }, 'z'.repeat(20000));
    click(host, 'orient-vertical');
    click(host, 'layout-scroll');
    click(host, 'design-default');
    expect(handle.getState().step).toBe('summary-requirement');

    setField(host, 'free-requirement', 'bold');
    click(host, 'generate-submit');
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
  it('renders a model picker on summary-requirement and routes the chosen model to aiGenerate', async () => {
    const { host, deps } = setup({
      listHtmlModels: async () => [
        { provider: 'chatgpt', id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', contextWindow: 400_000 },
        { provider: 'chatgpt', id: 'gpt-5.6', label: 'GPT-5.6', contextWindow: 1_000_000 },
        { provider: 'chatgpt', id: 'gpt-5.4', label: 'GPT-5.4', contextWindow: 1_000_000 },
      ],
      getDefaultModel: () => ({ provider: 'chatgpt', id: 'gpt-5.4-mini' }),
    });
    click(host, 'orient-vertical');
    click(host, 'layout-scroll');
    click(host, 'design-default');
    await flush(); // model list resolves, summary-requirement re-renders with the picker
    const select = host.querySelector<HTMLSelectElement>('[data-he-field="model"]');
    expect(select).toBeTruthy();
    expect(select!.value).toBe('chatgpt:gpt-5.4-mini');
    const optText = Array.from(select!.querySelectorAll('option')).map((o) => o.textContent);
    expect(optText).toContain('GPT-5.6 · 1M');
    expect(optText).toContain('GPT-5.4 mini · 400K');
    expect(optText).not.toContain('GPT-5.4 · 1M');
    // Pick the bigger model.
    select!.value = 'chatgpt:gpt-5.6';
    click(host, 'generate-submit');
    await flush();
    expect(deps.aiGenerate).toHaveBeenCalledTimes(1);
    const passedModel = (deps.aiGenerate as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(passedModel).toEqual({ provider: 'chatgpt', id: 'gpt-5.6' });
  });
});

describe('mountHtmlExportWizard — invalid AI reply surfaces an error', () => {
  it('an AI reply that is not a valid content model → error step', async () => {
    const { host, handle } = setup({
      aiGenerate: vi.fn(() => ({ result: Promise.resolve('Sorry, here is some markdown instead'), cancel: vi.fn() })),
    });
    click(host, 'orient-vertical');
    click(host, 'layout-scroll');
    click(host, 'design-default');
    setField(host, 'free-requirement', '');
    click(host, 'generate-submit');
    await flush();
    expect(handle.getState().step).toBe('error');
    expect(host.querySelector('.he-error')).toBeTruthy();
  });

  it('an AI reply that smuggles HTML is rejected (content models never contain markup)', async () => {
    const { host, handle } = setup({
      aiGenerate: vi.fn(() => ({
        result: Promise.resolve('<!doctype html><html><body><h1>nope</h1></body></html>'),
        cancel: vi.fn(),
      })),
    });
    click(host, 'orient-vertical');
    click(host, 'layout-scroll');
    click(host, 'design-default');
    setField(host, 'free-requirement', '');
    click(host, 'generate-submit');
    await flush();
    expect(handle.getState().step).toBe('error');
  });
});

describe('mountHtmlExportWizard — local model context badge + small-model notice (G003)', () => {
  it('lists a local model with a context badge and warns when its context window is small', async () => {
    const { host, handle } = setup({
      listHtmlModels: async () => [
        { provider: 'chatgpt', id: 'gpt-5.6', label: 'GPT-5.6', contextWindow: 1_000_000 },
        { provider: 'ollama', id: 'llama3:latest', label: 'llama3:latest', contextWindow: 8_192 },
        { provider: 'grok', id: 'grok-4.5', label: 'Grok 4.5', contextWindow: 256_000 },
      ],
      getDefaultModel: () => ({ provider: 'ollama', id: 'llama3:latest' }),
    });
    click(host, 'orient-vertical');
    click(host, 'layout-scroll');
    click(host, 'design-default');
    await flush(); // model list resolves → summary-requirement re-renders with the picker
    const select = host.querySelector<HTMLSelectElement>('[data-he-field="model"]');
    expect(select).toBeTruthy();
    expect(select!.value).toBe('ollama:llama3:latest');
    const optText = Array.from(select!.querySelectorAll('option')).map((o) => o.textContent);
    expect(optText).toContain('llama3:latest · 8K');
    expect(optText).toContain('GPT-5.6 · 1M');
    expect(optText).toContain('Grok 4.5 · 256K');
    const note = host.querySelector<HTMLElement>('[data-he-note="model"]');
    expect(note).toBeTruthy();
    expect(note!.hidden).toBe(false);
    expect(note!.textContent).toContain('he.smallContext');
    // Switching to the large cloud model hides the advisory.
    select!.value = 'chatgpt:gpt-5.6';
    select!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(host.querySelector<HTMLElement>('[data-he-note="model"]')!.hidden).toBe(true);
    expect(handle.getState().step).toBe('summary-requirement');
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
    click(host, 'design-default');
    await flush();
    const note = host.querySelector<HTMLElement>('[data-he-note="model"]');
    expect(note!.hidden).toBe(true);
  });
});

describe('mountHtmlExportWizard — purpose/density/etc are demoted to an optional advanced panel', () => {
  const toSummary = (host: HTMLElement) => {
    click(host, 'orient-vertical');
    click(host, 'layout-scroll');
    click(host, 'design-default');
  };

  it('shows the core controls and keeps the advanced knobs collapsed/optional', () => {
    const { host } = setup();
    toSummary(host);
    // Core controls are present and not gated by the advanced panel.
    expect(host.querySelector('[data-he-field="free-requirement"]')).toBeTruthy();
    expect(host.querySelector('[data-he="summary-A"]')).toBeTruthy();
    expect(host.querySelector('[data-he="summary-D"]')).toBeTruthy();
    // Advanced is a collapsed <details> by default.
    const adv = host.querySelector('details.he-advanced');
    expect(adv).toBeTruthy();
    expect((adv as HTMLDetailsElement).open).toBe(false);
    // Purpose lives inside advanced; auto mode hides the detail knobs.
    expect(host.querySelector('[data-he-field="purpose"]')).toBeTruthy();
    expect(host.querySelector('[data-he-field="density"]')).toBeNull();
    expect(host.querySelector('[data-he-field="interactive"]')).toBeNull();
  });

  it('switching to detail reveals density/width/interactive knobs', () => {
    const { host, handle } = setup();
    toSummary(host);
    click(host, 'mode-detail');
    expect(handle.getState().mode).toBe('detail');
    expect(host.querySelector('[data-he-field="density"]')).toBeTruthy();
    expect(host.querySelector('[data-he-field="readable-width"]')).toBeTruthy();
    expect(host.querySelector('[data-he-field="interactive"]')).toBeTruthy();
  });
  it('passes detail density and readable-width selections through to saved HTML', async () => {
    let savedHtml = '';
    const { host } = setup({
      saveHtml: vi.fn(async ({ html }) => {
        savedHtml = html;
        return { saved: true, filePath: '/tmp/export.html' };
      }),
    });
    toSummary(host);
    click(host, 'mode-detail');
    setField(host, 'density', 'roomy');
    setField(host, 'readable-width', 'wide');
    click(host, 'generate-submit');
    await flush();
    click(host, 'save-html');
    await flush();

    expect(savedHtml).toContain('--he-readable-width: clamp(820px, 88vw, 1280px);');
    expect(savedHtml).toContain('--he-rhythm: 48px;');
  });
});

describe('mountHtmlExportWizard — getdesign list rows', () => {
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
