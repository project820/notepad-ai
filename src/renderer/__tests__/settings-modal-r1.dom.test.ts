// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { openSettingsModal } from '../settings-modal';
import { mountProviderSettingsPanel, type ProviderStatusView } from '../provider-settings-panel';
import type { ModelRef, ProviderAuthStatus } from '../../main/ai/types';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const statuses: ProviderAuthStatus[] = [
  { provider: 'chatgpt', label: 'ChatGPT', authKind: 'oauth', connected: true, accountLabel: 'me' },
  { provider: 'claude', label: 'Claude', authKind: 'api_key', connected: false },
  { provider: 'openrouter', label: 'OpenRouter', authKind: 'api_key', connected: false },
  { provider: 'ollama', label: 'Ollama', authKind: 'local', connected: true },
  { provider: 'lmstudio', label: 'LM Studio', authKind: 'local', connected: true },
  { provider: 'grok', label: 'Grok (CLI)', authKind: 'cli', connected: false },
];
const models: ModelRef[] = [
  { provider: 'ollama', id: 'llama', humanizeEngineId: 'none', requiresAuth: false },
  { provider: 'lmstudio', id: 'local', humanizeEngineId: 'none', requiresAuth: false },
];

function flush() {
  return Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
}

function installApi() {
  const status = deferred<ProviderAuthStatus[]>();
  const config = deferred<{ ollama: string; lmstudio: string }>();
  const modelSnapshot = deferred<ModelRef[]>();
  const authLogout = vi.fn().mockResolvedValue(undefined);
  (window as unknown as { api: unknown }).api = {
    aiProvidersStatus: vi.fn(() => status.promise),
    localAiGetConfig: vi.fn(() => config.promise),
    aiModels: vi.fn(() => modelSnapshot.promise),
    authLogout,
    mdHandlerStatus: vi.fn().mockResolvedValue({ supported: false, registered: false }),
  };
  return { status, config, models: modelSnapshot, authLogout };
}

function providerDom() {
  return document.querySelector<HTMLElement>('#settings-providers .prov-root')!.outerHTML;
}

async function closeModal() {
  document.querySelector<HTMLButtonElement>('#settings-close')?.click();
  await flush();
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});
let convergedProviderDom: string | undefined;


describe('openSettingsModal R1 reconciliation', () => {
  it('paints six stable busy skeleton rows before any IPC result and starts all resources in parallel', () => {
    const api = installApi();
    openSettingsModal({ onSetCustomModel: vi.fn() });

    const rows = document.querySelectorAll<HTMLElement>('[data-prov-row]');
    expect(rows).toHaveLength(6);
    expect([...rows].map((row) => row.dataset.provRow)).toEqual(['chatgpt', 'claude', 'openrouter', 'ollama', 'lmstudio', 'grok']);
    expect([...rows].every((row) => row.getAttribute('aria-busy') === 'true')).toBe(true);
    expect(api.status).toBeDefined();
    expect((window.api.aiProvidersStatus as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
    expect((window.api.localAiGetConfig as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
    expect((window.api.aiModels as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(true);
  });
  it('records emptyPanelFrames=0 at the synchronous first paint', () => {
    installApi();
    let emptyPanelFrames = 0;

    openSettingsModal({ onSetCustomModel: vi.fn() });
    if (document.querySelectorAll('#settings-providers [data-prov-row]').length === 0) emptyPanelFrames += 1;

    expect(emptyPanelFrames).toBe(0);
    expect(document.querySelectorAll('#settings-providers [data-prov-row]')).toHaveLength(6);
  });

  it('records awaitedModelsBeforePaint=false while aiModels remains pending', () => {
    installApi(); // Its models promise deliberately never resolves.
    let awaitedModelsBeforePaint = true;

    openSettingsModal({ onSetCustomModel: vi.fn() });
    if (document.querySelectorAll('#settings-providers [data-prov-row]').length === 6) {
      awaitedModelsBeforePaint = false;
    }

    expect(awaitedModelsBeforePaint).toBe(false);
    expect(document.querySelectorAll('#settings-providers [data-prov-row][aria-busy="true"]')).toHaveLength(6);
  });

  it('records fullRemountCountPerAction=0 while an auth action preserves panel and row identities', async () => {
    const api = installApi();
    openSettingsModal({ onSetCustomModel: vi.fn() });
    api.status.resolve(statuses);
    await flush();

    const panelRoot = document.querySelector<HTMLElement>('#settings-providers .prov-root')!;
    const rows = [...document.querySelectorAll<HTMLElement>('#settings-providers [data-prov-row]')];
    let fullRemountCountPerAction = 0;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) {
          if (node === panelRoot) fullRemountCountPerAction += 1;
        }
      }
    });
    observer.observe(document.querySelector('#settings-providers')!, { childList: true });

    document.querySelector<HTMLButtonElement>('[data-prov-action="signout"]')!.click();
    await flush();
    observer.disconnect();

    expect(api.authLogout).toHaveBeenCalledOnce();
    expect(document.querySelector('#settings-providers .prov-root')).toBe(panelRoot);
    expect([...document.querySelectorAll<HTMLElement>('#settings-providers [data-prov-row]')]).toEqual(rows);
    expect(fullRemountCountPerAction).toBe(0);
  });

  it('records stalePaintAfterClose=0 for late IPC resolutions', async () => {
    const api = installApi();
    openSettingsModal({ onSetCustomModel: vi.fn() });
    await closeModal();

    let stalePaintAfterClose = 0;
    const observer = new MutationObserver((records) => {
      stalePaintAfterClose += records.reduce((count, record) => count + record.addedNodes.length + record.removedNodes.length, 0);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    api.status.resolve(statuses);
    api.config.resolve({ ollama: 'http://late', lmstudio: 'http://late' });
    api.models.resolve(models);
    await flush();
    observer.disconnect();

    expect(stalePaintAfterClose).toBe(0);
    expect(document.querySelector('.settings-modal-root')).toBeNull();
  });

  it('buffers config/models until status, then patches only changed slots while retaining focus and row identity', async () => {
    const api = installApi();
    openSettingsModal({ onSetCustomModel: vi.fn() });
    const chatRow = document.querySelector<HTMLElement>('[data-prov-row="chatgpt"]')!;
    const claudeRow = document.querySelector<HTMLElement>('[data-prov-row="claude"]')!;

    api.config.resolve({ ollama: 'http://localhost:11434', lmstudio: 'http://localhost:1234' });
    api.models.resolve(models);
    await flush();
    expect(document.querySelector<HTMLElement>('[data-prov-row="chatgpt"]')).toBe(chatRow);
    expect(chatRow.getAttribute('aria-busy')).toBe('true');

    api.status.resolve(statuses);
    await flush();
    const input = document.querySelector<HTMLInputElement>('input[data-prov-key="claude"]')!;
    input.value = 'typed key';
    input.focus();
    input.setSelectionRange(2, 7);
    expect(document.querySelector<HTMLElement>('[data-prov-row="claude"]')).toBe(claudeRow);
    expect(document.querySelector('[data-prov-row="ollama"]')?.textContent).toContain('Models available');

    // A config-only refresh does not replace unrelated row content or its focused input.
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('typed key');
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(7);
  });
  it('replaces only a changed row while restoring its focused input and selection', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const initial: ProviderStatusView[] = [
      { provider: 'claude', label: 'Claude', authKind: 'api_key', connected: false },
      { provider: 'openrouter', label: 'OpenRouter', authKind: 'api_key', connected: false },
    ];
    const handle = mountProviderSettingsPanel(parent, {
      statuses: initial,
      onChatgptSignIn: vi.fn(),
      onChatgptSignOut: vi.fn(),
      onSaveKey: vi.fn(),
      onDeleteKey: vi.fn(),
      onSetCustomModel: vi.fn(),
    });
    const row = parent.querySelector<HTMLElement>('[data-prov-row="claude"]')!;
    const input = parent.querySelector<HTMLInputElement>('input[data-prov-key="claude"]')!;
    input.value = 'preserve me';
    input.focus();
    input.setSelectionRange(2, 8);

    handle.patch({
      statuses: [
        { ...initial[0], error: 'status changed' },
        initial[1],
      ],
    });

    expect(parent.querySelector('[data-prov-row="claude"]')).toBe(row);
    const restored = parent.querySelector<HTMLInputElement>('input[data-prov-key="claude"]')!;
    expect(document.activeElement).toBe(restored);
    expect(restored.value).toBe('preserve me');
    expect(restored.selectionStart).toBe(2);
    expect(restored.selectionEnd).toBe(8);
  });

  it('does not paint late IPC results into a closed generation', async () => {
    const api = installApi();
    openSettingsModal({ onSetCustomModel: vi.fn() });
    await closeModal();

    api.status.resolve(statuses);
    api.config.resolve({ ollama: 'http://late', lmstudio: 'http://late' });
    api.models.resolve(models);
    await flush();
    expect(document.querySelector('.settings-modal-root')).toBeNull();
  });

  it.each([
    ['status', 'config', 'models'],
    ['status', 'models', 'config'],
    ['config', 'status', 'models'],
    ['config', 'models', 'status'],
    ['models', 'status', 'config'],
    ['models', 'config', 'status'],
  ] as const)('converges for %s → %s → %s, including a reopened generation', async (...order) => {
    const first = installApi();
    openSettingsModal({ onSetCustomModel: vi.fn() });
    await closeModal();
    const second = installApi();
    openSettingsModal({ onSetCustomModel: vi.fn() });

    const resources = {
      status: () => second.status.resolve(statuses),
      config: () => second.config.resolve({ ollama: 'http://localhost:11434', lmstudio: 'http://localhost:1234' }),
      models: () => second.models.resolve(models),
    };
    for (const resource of order) {
      resources[resource]();
      await flush();
    }

    const actual = providerDom();
    expect(actual).toContain('Models available');
    expect(actual).toContain('http://localhost:11434');
    if (convergedProviderDom === undefined) convergedProviderDom = actual;
    else expect(actual).toBe(convergedProviderDom);

    // Late completions from the closed modal are stale and cannot affect this root.
    first.status.resolve([]);
    first.config.resolve({ ollama: 'http://stale', lmstudio: 'http://stale' });
    first.models.resolve([]);
    await flush();
    expect(providerDom()).toBe(actual);
  });
});
