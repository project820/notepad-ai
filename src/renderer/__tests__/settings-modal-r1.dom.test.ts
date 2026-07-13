// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSettingsModal } from '../settings-modal';
import type { ModelRef, ProviderAuthStatus } from '../../main/ai/types';

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const statuses: ProviderAuthStatus[] = [
  { provider: 'chatgpt', label: 'ChatGPT', authKind: 'oauth', connected: true, accountLabel: 'me' },
  { provider: 'claude', label: 'Claude', authKind: 'api_key', connected: false },
  { provider: 'grok', label: 'Grok', authKind: 'api_key', connected: false },
  { provider: 'ollama', label: 'Ollama', authKind: 'local', connected: true },
  { provider: 'openrouter', label: 'OpenRouter', authKind: 'api_key', connected: true, keyLast4: '1234' },
  { provider: 'lmstudio', label: 'LM Studio', authKind: 'local', connected: true },
];
const models: ModelRef[] = [{ provider: 'ollama', id: 'llama', humanizeEngineId: 'none', requiresAuth: false }];

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

function open() {
  openSettingsModal({ onSetCustomModel: vi.fn() });
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('openSettingsModal provider list', () => {
  it('paints only the four supported rows in account-first order before IPC resolves', () => {
    const api = installApi();
    open();

    const rows = [...document.querySelectorAll<HTMLElement>('[data-prov-row]')];
    expect(rows.map((row) => row.dataset.provRow)).toEqual(['chatgpt', 'claude', 'grok', 'ollama']);
    expect(rows.every((row) => row.getAttribute('aria-busy') === 'true')).toBe(true);
    expect(api.status).toBeDefined();
    expect((window.api.aiProvidersStatus as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
    expect((window.api.localAiGetConfig as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
    expect((window.api.aiModels as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(true);
  });

  it('keeps OpenRouter and LM Studio hidden after legacy status and model data arrive', async () => {
    const api = installApi();
    open();
    api.config.resolve({ ollama: 'http://localhost:11434', lmstudio: 'http://localhost:1234' });
    api.models.resolve(models);
    api.status.resolve(statuses);
    await flush();

    expect(document.querySelector('[data-prov-row="openrouter"]')).toBeNull();
    expect(document.querySelector('[data-prov-row="lmstudio"]')).toBeNull();
    expect(document.querySelector('[data-prov-row="ollama"]')?.textContent).toContain('Models available');
    expect(document.querySelector('.prov-local-section')?.textContent).toBe('Local models');
    expect(document.querySelector('#settings-providers')?.textContent).not.toContain('claude login');
  });

  it('retains row and panel identity across ChatGPT sign-out refreshes', async () => {
    const api = installApi();
    open();
    api.config.resolve({ ollama: 'http://localhost:11434', lmstudio: 'http://localhost:1234' });
    api.models.resolve(models);
    api.status.resolve(statuses);
    await flush();

    const panel = document.querySelector('#settings-providers .prov-root');
    const rows = [...document.querySelectorAll<HTMLElement>('#settings-providers [data-prov-row]')];
    document.querySelector<HTMLButtonElement>('[data-prov-action="signout"]')!.click();
    await flush();

    expect(api.authLogout).toHaveBeenCalledOnce();
    expect(document.querySelector('#settings-providers .prov-root')).toBe(panel);
    expect([...document.querySelectorAll<HTMLElement>('#settings-providers [data-prov-row]')]).toEqual(rows);
  });

  it('does not apply pending provider results after the modal closes', async () => {
    const api = installApi();
    open();
    document.querySelector<HTMLButtonElement>('#settings-close')!.click();
    api.status.resolve(statuses);
    api.config.resolve({ ollama: 'http://late', lmstudio: 'http://late' });
    api.models.resolve(models);
    await flush();

    expect(document.querySelector('.settings-modal-root')).toBeNull();
  });
});
