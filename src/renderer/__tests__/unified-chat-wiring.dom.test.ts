// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../settings-modal', () => ({
  openSettingsModal: vi.fn(),
  triggerCliOnboarding: vi.fn(),
}));

import { initUnifiedChatWiring, resolveHtmlExportDefaultModel } from '../unified-chat-wiring';
import type { AppContext } from '../app-context';
import type { Prefs } from '../prefs';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup(models: Promise<any[]>, statuses: Promise<any[]>, prefs: Partial<Prefs> = {}) {
  document.body.innerHTML = '<div class="content-row"></div><div id="unified-chat"></div><div class="uc-resizer"></div>';
  (window as unknown as { api: unknown }).api = {
    aiModelsHtml: vi.fn(() => models),
    aiProvidersStatus: vi.fn(() => statuses),
    listDesigns: vi.fn(async () => []),
  };
  const status = vi.fn();
  const ctx = {
    currentPath: null,
    pendingTitle: null,
    suppressEditorChange: false,
    editor: { getDoc: () => '# Draft' },
    setStatus: status,
  } as unknown as AppContext;
  initUnifiedChatWiring(ctx, {
    prefs: { theme: 'system', fontSize: 'md', ...prefs },
    loadModelsCached: vi.fn(),
    invalidateModels: vi.fn(),
    getAuth: vi.fn(),
    setAuth: vi.fn(),
    paintAccountState: vi.fn(),
    scheduleSessionSnapshot: vi.fn(),
    onSuppressedEditorChange: vi.fn(),
    tryMutateDocument: vi.fn(() => true),
    onProjectSetup: vi.fn(),
  });
  document.querySelector<HTMLButtonElement>('.uc-mode[data-mode="html"]')!.click();
  return { host: document.querySelector<HTMLElement>('#unified-chat')!, status };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('HTML export wizard entry', () => {
  it('renders a loading shell before gates settle, then mounts the first wizard step', async () => {
    const models = deferred<any[]>();
    const statuses = deferred<any[]>();
    const { host } = setup(models.promise, statuses.promise);

    expect(host.querySelector('.he-host .he-status')).not.toBeNull();
    expect(host.querySelector('.he-host .he-spinner')).not.toBeNull();
    expect(host.querySelector('[data-he="orient-vertical"]')).toBeNull();

    models.resolve([]);
    await Promise.resolve();
    statuses.resolve([{ provider: 'chatgpt', authKind: 'oauth', connected: true, label: 'ChatGPT' }]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(host.querySelector('[data-he="orient-vertical"]')).not.toBeNull();
  });
  it('rejects an out-of-lineup chat default before the wizard consumes it', () => {
    expect(resolveHtmlExportDefaultModel({ provider: 'chatgpt', id: 'gpt-5.4-mini' })).toBeUndefined();
    expect(resolveHtmlExportDefaultModel({ provider: 'chatgpt', id: 'gpt-5.6-sol' })).toEqual(
      { provider: 'chatgpt', id: 'gpt-5.6-sol' },
    );
  });
  it('uses the inventory-first model when the chat selection is outside the HTML lineup', async () => {
    const { host } = setup(
      Promise.resolve([
        { provider: 'chatgpt', id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', contextWindow: 400_000 },
        { provider: 'chatgpt', id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', contextWindow: 400_000 },
      ]),
      Promise.resolve([{ provider: 'chatgpt', authKind: 'oauth', connected: true, label: 'ChatGPT' }]),
      { selectedModel: { provider: 'chatgpt', id: 'gpt-5.4-mini' } },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    host.querySelector<HTMLButtonElement>('[data-he="orient-vertical"]')!.click();
    host.querySelector<HTMLButtonElement>('[data-he="layout-scroll"]')!.click();
    host.querySelector<HTMLButtonElement>('[data-he="design-default"]')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(host.querySelector<HTMLSelectElement>('[data-he-field="model"]')?.value).toBe('chatgpt:gpt-5.6-sol');
  });

  it('replaces the loading shell with no-provider guidance when entry gates fail', async () => {
    const models = deferred<any[]>();
    const statuses = deferred<any[]>();
    const { host, status } = setup(models.promise, statuses.promise);

    models.resolve([]);
    await Promise.resolve();
    statuses.resolve([{ provider: 'chatgpt', authKind: 'oauth', connected: false, label: 'ChatGPT' }]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(host.querySelector('.he-host')).toBeNull();
    expect(host.querySelector('[data-he="orient-vertical"]')).toBeNull();
    expect(host.textContent).toContain('No AI provider is connected.');
    expect(status).toHaveBeenCalled();
  });
});
