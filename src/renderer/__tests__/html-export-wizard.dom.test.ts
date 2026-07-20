// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountHtmlExportWizard, type HtmlExportDeps } from '../html-export-wizard';
import type { GenerationAttemptResult } from '../../main/html-export-generation-orchestrator';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async (predicate: () => boolean, tries = 80): Promise<void> => {
  for (let i = 0; i < tries; i++) {
    await flush();
    if (predicate()) return;
  }
};

/** A successful finalized generation result (main-owned; opaque IDs only). */
const FINAL_RESULT = {
  state: 'final',
  attemptId: 'attempt-1',
  finalizedArtifactId: 'final-1',
  resolvedArtifactId: 'resolved-1',
  sanitizedArtifactId: 'sanitized-1',
  route: { provider: 'chatgpt', model: 'gpt-5.4-mini', transport: 'cli' },
} as unknown as GenerationAttemptResult;

/** Non-final failures with explicit pipeline stages and kinds. */
const FAILED_RESULT = {
  state: 'failed',
  stage: 'generate',
  kind: 'pipeline-reject',
  route: { provider: 'chatgpt', model: 'gpt-5.4-mini', transport: 'cli' },
} as unknown as GenerationAttemptResult;

const SANITIZE_FAILED_RESULT = {
  state: 'failed',
  stage: 'sanitize',
  kind: 'pipeline-reject',
  route: { provider: 'chatgpt', model: 'gpt-5.4-mini', transport: 'cli' },
} as unknown as GenerationAttemptResult;

const LAYOUT_QUARANTINE_FAILED_RESULT = {
  state: 'failed',
  stage: 'quarantine',
  kind: 'layout-violation',
  route: { provider: 'chatgpt', model: 'gpt-5.4-mini', transport: 'cli' },
} as unknown as GenerationAttemptResult;

const INFRASTRUCTURE_QUARANTINE_FAILED_RESULT = {
  state: 'failed',
  stage: 'quarantine',
  kind: 'quarantine-unavailable',
  route: { provider: 'chatgpt', model: 'gpt-5.4-mini', transport: 'cli' },
} as unknown as GenerationAttemptResult;

const PARTIAL_LAYOUT_RESULT = {
  state: 'partial',
  attemptId: 'attempt-1',
  resolvedArtifactId: 'resolved-1',
  quarantineKind: 'layout-violation',
  route: { provider: 'chatgpt', model: 'gpt-5.4-mini', transport: 'cli' },
  callCount: 1,
} as unknown as GenerationAttemptResult;

const GENERATION_ERROR_CASES: ReadonlyArray<readonly [GenerationAttemptResult, string]> = [
  [FAILED_RESULT, 'he.error.generate'],
  [SANITIZE_FAILED_RESULT, 'he.error.sanitize'],
  [LAYOUT_QUARANTINE_FAILED_RESULT, 'he.error.containment'],
  [INFRASTRUCTURE_QUARANTINE_FAILED_RESULT, 'he.error.generate'],
  [PARTIAL_LAYOUT_RESULT, 'he.error.containment'],
];

function setup(over: Partial<HtmlExportDeps> = {}, markdown = '# Title\n\nSome body.') {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const mdRef = { value: markdown };
  const deps: HtmlExportDeps = {
    getMarkdown: () => mdRef.value,
    fetchDesignMd: vi.fn(async () => ({ ok: true, designMd: '## tokens', rawUrl: 'https://raw/x/DESIGN.md' })),
    generateHtmlExport: vi.fn(async () => FINAL_RESULT),
    saveHtmlFinalized: vi.fn(async () => ({ saved: true, filePath: 'export.html' })),
    cancelHtmlGeneration: vi.fn(),
    getDefaultModel: () => ({ provider: 'chatgpt', id: 'gpt-5.4-mini' }),
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

/** The request object passed to the last generateHtmlExport call. */
function lastRequest(deps: HtmlExportDeps): {
  prompt: string;
  model: { provider: string; id: string };
  viewport?: { width: number; height: number };
  reasoningEffort?: 'low';
  mode?: 'slide' | 'scroll';
} {
  const calls = (deps.generateHtmlExport as ReturnType<typeof vi.fn>).mock.calls;
  return calls[calls.length - 1][0];
}

describe('mountHtmlExportWizard — generate composes ONE direct-authoring prompt from the selections + the free requirement', () => {
  it('sends a single direct prompt reflecting orientation, layout, design.md, and the free requirement', async () => {
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

    // The single free-text requirement.
    setField(host, 'free-requirement', 'keep it punchy and chart-heavy');
    click(host, 'generate-submit');

    // Exactly ONE composed prompt is sent to the main-owned generator.
    expect(deps.generateHtmlExport).toHaveBeenCalledTimes(1);
    const { prompt } = lastRequest(deps);
    // Every selection is provably reflected in that single prompt.
    expect(prompt).toContain('PORTRAIT'); // orientation (vertical → portrait)
    expect(prompt).toContain('SLIDE'); // layout (slides → slide)
    expect(prompt).toContain('## tokens'); // the fetched design.md content
    expect(prompt).toContain('keep it punchy and chart-heavy'); // free requirement

    // The reply is a finalized artifact descriptor — no HTML is authored in the renderer.
    expect(handle.getState().step).toBe('generating');
    await flush();
    expect(handle.getState().step).toBe('generated');
    expect(handle.getState().finalized?.finalizedArtifactId).toBe('final-1');

    // The Markdown source was never mutated by the wizard.
    expect(mdRef.value).toBe('# Title\n\nSome body.');
  });

  it('keeps the typed free requirement when switching A/B/C/D (no re-render wipe)', async () => {
    const { host, deps } = setup();
    click(host, 'orient-vertical');
    click(host, 'layout-scroll');
    click(host, 'design-default');
    const ta = host.querySelector<HTMLTextAreaElement>('[data-he-field="free-requirement"]')!;
    ta.value = 'audience: execs';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    click(host, 'summary-A');
    expect(host.querySelector<HTMLTextAreaElement>('[data-he-field="free-requirement"]')!.value).toBe('audience: execs');
    click(host, 'generate-submit');
    await flush();
    expect(lastRequest(deps).prompt).toContain('audience: execs');
  });
});

describe('mountHtmlExportWizard — summary/chart mode + advanced knobs thread into the direct prompt', () => {
  it('embeds the chosen A/B/C/D summary mode and advanced knobs in the composed prompt', async () => {
    const { host, deps } = setup();
    click(host, 'orient-vertical');
    click(host, 'layout-scroll');
    click(host, 'design-default');

    // Core A/B/C/D control — pick C (Detailed brief).
    click(host, 'summary-C');
    // Advanced knobs: open detail mode and pick width + interactive.
    click(host, 'mode-detail');
    setField(host, 'readable-width', 'wide');
    const interactive = host.querySelector<HTMLInputElement>('[data-he-field="interactive"]')!;
    interactive.checked = true;
    setField(host, 'free-requirement', 'board-ready digest');
    click(host, 'generate-submit');
    await flush();

    expect(deps.generateHtmlExport).toHaveBeenCalledTimes(1);
    const { prompt } = lastRequest(deps);
    expect(prompt).toContain('summary/chart strength: C');
    expect(prompt).toContain('Detailed brief');
    expect(prompt).toContain('readable width: WIDE reading measure');
    expect(prompt).toContain('interactivity: inline JavaScript runs in the final document.');
    expect(prompt).toContain('board-ready digest');
  });
});

describe('mountHtmlExportWizard — >30k single-pass fail-fast (no generation)', () => {
  it('stops with a localized too-long error and never calls generateHtmlExport', async () => {
    const longMd = `# Long\n\n${'x'.repeat(30_001)}`;
    const { host, deps, handle } = setup({}, longMd);
    click(host, 'orient-vertical');
    click(host, 'layout-scroll');
    click(host, 'design-default');
    setField(host, 'free-requirement', '');
    click(host, 'generate-submit');
    await flush();

    expect(deps.generateHtmlExport).not.toHaveBeenCalled();
    expect(handle.getState().step).toBe('error');
    expect(handle.getState().error).toBe('he.error.tooLongSinglePass');
    expect(host.querySelector('.he-error')?.textContent).toContain('he.error.tooLongSinglePass');
  });
});
describe('mountHtmlExportWizard — per-model single-pass limit via maxSourceCharsForModel', () => {
  it('gates generation when source exceeds the model budget even if under the 30k default', async () => {
    // Source is longer than a small model budget but under the generous 30k default.
    const md = `# Title\n\n${'x'.repeat(500)}`;
    expect(md.length).toBeLessThan(30_000);
    const { host, deps, handle } = setup(
      {
        maxSourceCharsForModel: () => 100,
        getDefaultModel: () => ({ provider: 'ollama', id: 'local-8k', contextWindow: 8_192 }),
      },
      md,
    );
    click(host, 'orient-vertical');
    click(host, 'layout-scroll');
    click(host, 'design-default');
    setField(host, 'free-requirement', '');
    click(host, 'generate-submit');
    await flush();

    expect(deps.generateHtmlExport).not.toHaveBeenCalled();
    expect(handle.getState().step).toBe('error');
    expect(handle.getState().error).toBe('he.error.tooLongSinglePass');
  });

  it('keeps the 30k default when maxSourceCharsForModel is omitted', async () => {
    // Under 30k and no per-model limit → generation proceeds.
    const md = `# Title\n\n${'y'.repeat(500)}`;
    const { host, deps, handle } = setup({}, md);
    click(host, 'orient-vertical');
    click(host, 'layout-scroll');
    click(host, 'design-default');
    setField(host, 'free-requirement', '');
    click(host, 'generate-submit');
    await flush();

    expect(deps.generateHtmlExport).toHaveBeenCalledTimes(1);
    expect(handle.getState().step).toBe('generated');
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
    expect(deps.generateHtmlExport).not.toHaveBeenCalled();

    // The explicit default-design action is the only no-fetch way forward.
    click(host, 'design-default');
    expect(handle.getState().step).toBe('summary-requirement');
    setField(host, 'free-requirement', '');
    click(host, 'generate-submit');
    expect(handle.getState().step).toBe('generating');
    await flush();
    expect(handle.getState().step).toBe('generated');
  });
});

describe('mountHtmlExportWizard — save wires the finalized artifact through the main pipeline', () => {
  it('save-html submits ONLY the opaque finalized IDs (never bytes) to saveHtmlFinalized', async () => {
    const { host, deps } = setup();
    click(host, 'orient-vertical');
    click(host, 'layout-scroll');
    click(host, 'design-default');
    setField(host, 'free-requirement', '');
    click(host, 'generate-submit');
    await flush();
    click(host, 'save-html');
    await settle(() => (deps.saveHtmlFinalized as ReturnType<typeof vi.fn>).mock.calls.length > 0);

    expect(deps.saveHtmlFinalized).toHaveBeenCalledTimes(1);
    const arg = (deps.saveHtmlFinalized as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.attemptId).toBe('attempt-1');
    expect(arg.finalizedArtifactId).toBe('final-1');
    // The renderer never touches HTML bytes on the save path.
    expect(arg).not.toHaveProperty('html');
    expect(host.querySelector('.he-card-saved')).toBeTruthy();
  });
});

describe('mountHtmlExportWizard — HTML-only model picker', () => {
  it('renders a model picker on summary-requirement and routes the chosen model to generateHtmlExport', async () => {
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
    // Pick the bigger model.
    select!.value = 'chatgpt:gpt-5.6';
    click(host, 'generate-submit');
    await flush();
    expect(deps.generateHtmlExport).toHaveBeenCalledTimes(1);
    expect(lastRequest(deps).model).toEqual({ provider: 'chatgpt', id: 'gpt-5.6' });
  });

  it('keeps allowlisted LM Studio models visible in the picker (not dropped by a general display policy)', async () => {
    const { host } = setup({
      listHtmlModels: async () => [
        { provider: 'chatgpt', id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', contextWindow: 400_000 },
        { provider: 'lmstudio', id: 'local-llama', label: 'Local Llama', contextWindow: 32_000 },
      ],
      getDefaultModel: () => ({ provider: 'chatgpt', id: 'gpt-5.4-mini' }),
    });
    click(host, 'orient-vertical');
    click(host, 'layout-scroll');
    click(host, 'design-default');
    await flush();
    const select = host.querySelector<HTMLSelectElement>('[data-he-field="model"]');
    expect(select).toBeTruthy();
    const values = Array.from(select!.querySelectorAll('option')).map((o) => (o as HTMLOptionElement).value);
    // The LM Studio model is not the current selection, yet it must remain offered.
    expect(values).toContain('lmstudio:local-llama');
    expect(values).toContain('chatgpt:gpt-5.4-mini');
  });
});
describe('mountHtmlExportWizard — GPT Fast mode', () => {
  it('shows only for the exact GPT lineup, persists its value, and sends low effort', async () => {
    const onFastModeChange = vi.fn();
    const { host, deps } = setup({
      listHtmlModels: async () => [
        { provider: 'chatgpt', id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
        { provider: 'grok', id: 'grok-4.5', label: 'Grok 4.5' },
        { provider: 'chatgpt', id: 'gpt-5.6', label: 'GPT-5.6' },
      ],
      getDefaultModel: () => ({ provider: 'chatgpt', id: 'gpt-5.6-sol' }),
      onFastModeChange,
    });
    click(host, 'orient-vertical');
    click(host, 'layout-scroll');
    click(host, 'design-default');
    await flush();

    const fast = host.querySelector<HTMLInputElement>('[data-he-field="fast"]');
    expect(fast).toBeTruthy();
    fast!.checked = true;
    fast!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onFastModeChange).toHaveBeenCalledWith(true);

    click(host, 'generate-submit');
    await flush();
    expect(lastRequest(deps).reasoningEffort).toBe('low');

    click(host, 'back');
    const select = host.querySelector<HTMLSelectElement>('[data-he-field="model"]')!;
    select.value = 'grok:grok-4.5';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(host.querySelector('[data-he-field="fast"]')).toBeNull();
  });
});

describe('mountHtmlExportWizard — sticky model selection survives re-renders', () => {
  it('keeps the chosen model after A/B/C/D and Auto/Detail toggles', async () => {
    const chosen: string[] = [];
    const { host, deps } = setup({
      listHtmlModels: async () => [
        { provider: 'chatgpt', id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', contextWindow: 400_000 },
        { provider: 'chatgpt', id: 'gpt-5.6', label: 'GPT-5.6', contextWindow: 1_000_000 },
        { provider: 'grok', id: 'grok-4.5', label: 'Grok 4.5', contextWindow: 256_000 },
      ],
      getDefaultModel: () => ({ provider: 'chatgpt', id: 'gpt-5.4-mini' }),
      onModelChosen: (m) => chosen.push(`${m.provider}:${m.id}`),
    });
    click(host, 'orient-vertical');
    click(host, 'layout-scroll');
    click(host, 'design-default');
    await flush();
    const select = host.querySelector<HTMLSelectElement>('[data-he-field="model"]')!;
    select.value = 'chatgpt:gpt-5.6';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(chosen).toContain('chatgpt:gpt-5.6');

    // Re-renders that previously wiped the picker back to the default.
    click(host, 'summary-A');
    click(host, 'mode-detail');
    click(host, 'mode-auto');
    expect(host.querySelector<HTMLSelectElement>('[data-he-field="model"]')!.value).toBe('chatgpt:gpt-5.6');

    click(host, 'generate-submit');
    await flush();
    expect(lastRequest(deps).model).toEqual({ provider: 'chatgpt', id: 'gpt-5.6' });
  });
});

describe('mountHtmlExportWizard — viewport + abandon invalidation', () => {
  it('sends an orientation-derived viewport with generateHtmlExport (portrait 720×1280)', async () => {
    const { host, deps } = setup();
    click(host, 'orient-vertical');
    click(host, 'layout-scroll');
    click(host, 'design-default');
    setField(host, 'free-requirement', '');
    click(host, 'generate-submit');
    await flush();

    expect(deps.generateHtmlExport).toHaveBeenCalledTimes(1);
    expect(lastRequest(deps).viewport).toEqual({ width: 720, height: 1280 });
    expect(lastRequest(deps).mode).toBe('scroll');
  });

  it('sends landscape 1280×720 when orientation is horizontal', async () => {
    const { host, deps } = setup();
    click(host, 'orient-horizontal');
    click(host, 'layout-scroll');
    click(host, 'design-default');
    setField(host, 'free-requirement', '');
    click(host, 'generate-submit');
    await flush();

    expect(lastRequest(deps).viewport).toEqual({ width: 1280, height: 720 });
  });
  it('sends slide mode when the slides layout is selected', async () => {
    const { host, deps } = setup();
    click(host, 'orient-horizontal');
    click(host, 'layout-slides');
    click(host, 'design-default');
    click(host, 'generate-submit');
    await flush();

    expect(lastRequest(deps).mode).toBe('slide');
  });

  it('abandon (destroy) after generated invokes cancelHtmlGeneration so main can invalidate the finalized attempt', async () => {
    const { host, deps, handle } = setup();
    click(host, 'orient-vertical');
    click(host, 'layout-scroll');
    click(host, 'design-default');
    setField(host, 'free-requirement', '');
    click(host, 'generate-submit');
    await flush();
    expect(handle.getState().step).toBe('generated');
    expect(handle.getState().finalized?.finalizedArtifactId).toBe('final-1');

    // destroy() is the cleanup abandon path (generated step has no cancel button in the footer).
    (deps.cancelHtmlGeneration as ReturnType<typeof vi.fn>).mockClear();
    handle.destroy();
    expect(deps.cancelHtmlGeneration).toHaveBeenCalledTimes(1);
  });

  it('regenerate that now exceeds the single-pass limit invalidates the prior finalized attempt before the too-long error', async () => {
    const { host, deps, handle, mdRef } = setup({ maxSourceCharsForModel: () => 50 });
    click(host, 'orient-vertical');
    click(host, 'layout-scroll');
    click(host, 'design-default');
    setField(host, 'free-requirement', '');
    click(host, 'generate-submit');
    await flush();
    expect(handle.getState().step).toBe('generated');

    // Grow the source past the model budget, then Regenerate: the preflight returns
    // too-long WITHOUT starting a new generation (which would otherwise supersede
    // it), so it must invalidate the prior finalized attempt rather than leak it.
    (deps.cancelHtmlGeneration as ReturnType<typeof vi.fn>).mockClear();
    mdRef.value = `# Title\n\n${'x'.repeat(200)}`;
    click(host, 'regenerate');
    expect(handle.getState().step).toBe('error');
    expect(handle.getState().error).toBe('he.error.tooLongSinglePass');
    expect(deps.cancelHtmlGeneration).toHaveBeenCalledTimes(1);
  });

  it('BACK from generated also invokes cancelHtmlGeneration (abandons the finalized attempt)', async () => {
    const { host, deps, handle } = setup();
    click(host, 'orient-vertical');
    click(host, 'layout-scroll');
    click(host, 'design-default');
    setField(host, 'free-requirement', '');
    click(host, 'generate-submit');
    await flush();
    expect(handle.getState().step).toBe('generated');

    (deps.cancelHtmlGeneration as ReturnType<typeof vi.fn>).mockClear();
    click(host, 'back');
    expect(deps.cancelHtmlGeneration).toHaveBeenCalledTimes(1);
    expect(handle.getState().step).toBe('summary-requirement');
  });
});

describe('mountHtmlExportWizard — a non-final generation result surfaces an error', () => {
  it.each(GENERATION_ERROR_CASES)('maps %s to the localized error key', async (result, expectedError) => {
    const { host, handle } = setup({
      generateHtmlExport: vi.fn(async () => result),
    });
    click(host, 'orient-vertical');
    click(host, 'layout-scroll');
    click(host, 'design-default');
    setField(host, 'free-requirement', '');
    click(host, 'generate-submit');
    await settle(() => handle.getState().step === 'error');
    expect(handle.getState().step).toBe('error');
    expect(handle.getState().error).toBe(expectedError);
    expect(host.querySelector('.he-error')?.textContent).toContain(expectedError);
  });

  it('invalidates the non-final attempt via cancelHtmlGeneration before the error state', async () => {
    const order: string[] = [];
    const { host, handle, deps } = setup({
      generateHtmlExport: vi.fn(async () => FAILED_RESULT),
      cancelHtmlGeneration: vi.fn(() => {
        order.push('cancel');
      }),
    });
    click(host, 'orient-vertical');
    click(host, 'layout-scroll');
    click(host, 'design-default');
    setField(host, 'free-requirement', '');
    click(host, 'generate-submit');
    await settle(() => handle.getState().step === 'error');
    expect(handle.getState().step).toBe('error');
    expect(deps.cancelHtmlGeneration).toHaveBeenCalledTimes(1);
    // cancel was invoked while handling the non-final result (not only on destroy).
    expect(order).toEqual(['cancel']);
  });

  it('invalidates the attempt when generateHtmlExport rejects', async () => {
    const { host, handle, deps } = setup({
      generateHtmlExport: vi.fn(async () => {
        throw new Error('network');
      }),
    });
    click(host, 'orient-vertical');
    click(host, 'layout-scroll');
    click(host, 'design-default');
    setField(host, 'free-requirement', '');
    click(host, 'generate-submit');
    await settle(() => handle.getState().step === 'error');
    expect(handle.getState().step).toBe('error');
    expect(deps.cancelHtmlGeneration).toHaveBeenCalledTimes(1);
  });
});
describe('mountHtmlExportWizard — failure recovery (back + retry)', () => {
  it('BACK from error returns to summary-requirement with sticky settings', async () => {
    const { host, handle } = setup({
      generateHtmlExport: vi.fn(async () => SANITIZE_FAILED_RESULT),
      listHtmlModels: async () => [
        { provider: 'chatgpt', id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', contextWindow: 400_000 },
        { provider: 'chatgpt', id: 'gpt-5.6', label: 'GPT-5.6', contextWindow: 1_000_000 },
      ],
      getDefaultModel: () => ({ provider: 'chatgpt', id: 'gpt-5.4-mini' }),
    });
    click(host, 'orient-vertical');
    click(host, 'layout-scroll');
    click(host, 'design-default');
    await flush();
    const select = host.querySelector<HTMLSelectElement>('[data-he-field="model"]')!;
    select.value = 'chatgpt:gpt-5.6';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    setField(host, 'free-requirement', 'keep charts');
    host.querySelector<HTMLTextAreaElement>('[data-he-field="free-requirement"]')!
      .dispatchEvent(new Event('input', { bubbles: true }));
    click(host, 'summary-C');
    click(host, 'generate-submit');
    await settle(() => handle.getState().step === 'error');
    expect(host.querySelector('[data-he="back"]')).toBeTruthy();
    expect(host.querySelector('[data-he="retry"]')).toBeTruthy();

    click(host, 'back');
    expect(handle.getState().step).toBe('summary-requirement');
    expect(handle.getState().summaryChartMode).toBe('C');
    expect(handle.getState().freeRequirement).toBe('keep charts');
    expect(host.querySelector<HTMLSelectElement>('[data-he-field="model"]')!.value).toBe('chatgpt:gpt-5.6');
  });

  it('Retry from error re-runs generation with the same sticky model', async () => {
    const gen = vi.fn(async () => SANITIZE_FAILED_RESULT);
    const { host, handle, deps } = setup({
      generateHtmlExport: gen,
      listHtmlModels: async () => [
        { provider: 'chatgpt', id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', contextWindow: 400_000 },
        { provider: 'chatgpt', id: 'gpt-5.6', label: 'GPT-5.6', contextWindow: 1_000_000 },
      ],
      getDefaultModel: () => ({ provider: 'chatgpt', id: 'gpt-5.4-mini' }),
    });
    click(host, 'orient-vertical');
    click(host, 'layout-scroll');
    click(host, 'design-default');
    await flush();
    const select = host.querySelector<HTMLSelectElement>('[data-he-field="model"]')!;
    select.value = 'chatgpt:gpt-5.6';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    click(host, 'generate-submit');
    await settle(() => handle.getState().step === 'error');
    expect(gen).toHaveBeenCalledTimes(1);

    click(host, 'retry');
    await settle(() => gen.mock.calls.length >= 2);
    expect(gen).toHaveBeenCalledTimes(2);
    expect(lastRequest(deps).model).toEqual({ provider: 'chatgpt', id: 'gpt-5.6' });
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

describe('mountHtmlExportWizard — flat Auto/Detail flow (no nested advanced panel)', () => {
  const toSummary = (host: HTMLElement) => {
    click(host, 'orient-vertical');
    click(host, 'layout-scroll');
    click(host, 'design-default');
  };

  it('shows Auto|Detail, summary, purpose, free-req, and model without a nested advanced panel', () => {
    const { host } = setup();
    toSummary(host);
    expect(host.querySelector('[data-he="mode-auto"]')).toBeTruthy();
    expect(host.querySelector('[data-he="mode-detail"]')).toBeTruthy();
    expect(host.querySelector('[data-he-field="free-requirement"]')).toBeTruthy();
    expect(host.querySelector('[data-he="summary-A"]')).toBeTruthy();
    expect(host.querySelector('[data-he="summary-D"]')).toBeTruthy();
    expect(host.querySelector('details.he-advanced')).toBeNull();
    expect(host.querySelector('[data-he-field="purpose"]')).toBeTruthy();
    // Density/width knobs only appear in Detail mode.
    expect(host.querySelector('[data-he-field="density"]')).toBeNull();
    expect(host.querySelector('[data-he-field="interactive"]')).toBeNull();
  });

  it('switching to detail reveals density/width/interactive knobs on one row', () => {
    const { host, handle } = setup();
    toSummary(host);
    click(host, 'mode-detail');
    expect(handle.getState().mode).toBe('detail');
    expect(host.querySelector('[data-he-field="density"]')).toBeTruthy();
    expect(host.querySelector('[data-he-field="readable-width"]')).toBeTruthy();
    expect(host.querySelector('[data-he-field="interactive"]')).toBeTruthy();
    expect(host.querySelector('.he-detail-row')).toBeTruthy();
  });

  it('maps roomy density to the sparse direct prompt directive', async () => {
    const { host, deps } = setup();
    toSummary(host);
    click(host, 'mode-detail');
    setField(host, 'density', 'roomy');
    click(host, 'generate-submit');
    await flush();
    expect(lastRequest(deps).prompt).toContain(
      'density: MINIMAL (sparse, high whitespace, one primary claim per unit)',
    );
  });

  it('maps compact density to the dense direct prompt directive', async () => {
    const { host, deps } = setup();
    toSummary(host);
    click(host, 'mode-detail');
    setField(host, 'density', 'compact');
    click(host, 'generate-submit');
    await flush();
    expect(lastRequest(deps).prompt).toContain(
      'density: FULL (dense, preserve detail and evidence)',
    );
  });

  it('preserves a non-core purpose preset (blog/portfolio/proposal) as a prompt hint', async () => {
    const { host, deps } = setup();
    toSummary(host);
    const purposeSel = host.querySelector<HTMLSelectElement>('[data-he-field="purpose"]')!;
    purposeSel.value = 'blog';
    purposeSel.dispatchEvent(new Event('change', { bubbles: true }));
    click(host, 'generate-submit');
    await flush();
    // Blog collapses to DOCUMENT in the 4-value model but its intent is carried forward.
    expect(lastRequest(deps).prompt).toContain('a blog post');
  });

  it('drops stale detail directives when the user switches back to Auto', async () => {
    const { host, deps } = setup();
    toSummary(host);
    click(host, 'mode-detail');
    setField(host, 'readable-width', 'wide');
    click(host, 'generate-submit');
    await flush();
    // Detail mode → the readable-width directive is present.
    expect(lastRequest(deps).prompt).toContain('WIDE reading measure');

    // Back to the form, switch to Auto, regenerate: the stale detail directive is gone.
    click(host, 'back');
    click(host, 'mode-auto');
    click(host, 'generate-submit');
    await flush();
    expect(lastRequest(deps).prompt).not.toContain('WIDE reading measure');
  });

  it('clears the custom-purpose directive when the input is emptied', async () => {
    const { host, deps } = setup();
    toSummary(host);
    click(host, 'mode-detail');
    const purposeSel = host.querySelector<HTMLSelectElement>('[data-he-field="purpose"]')!;
    purposeSel.value = 'custom';
    purposeSel.dispatchEvent(new Event('change', { bubbles: true }));
    setField(host, 'custom-purpose', 'a snazzy microsite');
    click(host, 'generate-submit');
    await flush();
    expect(lastRequest(deps).prompt).toContain('a snazzy microsite');

    // Back, clear the custom-purpose input, submit again: the directive is dropped.
    click(host, 'back');
    const cp = host.querySelector<HTMLInputElement>('[data-he-field="custom-purpose"]')!;
    cp.value = '';
    cp.dispatchEvent(new Event('input', { bubbles: true }));
    click(host, 'generate-submit');
    await flush();
    expect(lastRequest(deps).prompt).not.toContain('a snazzy microsite');
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
