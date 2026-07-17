// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountProviderSettingsPanel, type ProviderStatusView } from '../provider-settings-panel';
import { mountStyleSettingPanel } from '../style-setting-panel';
import { DEFAULT_STYLE } from '../humanize-engine';
import { setLocale, type Locale } from '../i18n';

const statuses: ProviderStatusView[] = [
  { provider: 'chatgpt', label: 'ChatGPT', authKind: 'oauth', connected: true, accountLabel: 'me' },
  { provider: 'claude', label: 'Claude', authKind: 'api_key', connected: false },
  { provider: 'grok', label: 'Grok', authKind: 'api_key', connected: false },
  { provider: 'ollama', label: 'Ollama', authKind: 'local', connected: true, localUrl: 'http://127.0.0.1:11434', localUrlDefault: 'http://127.0.0.1:11434', localModelCount: 0 },
];

function mountProviders(overrides: Partial<Parameters<typeof mountProviderSettingsPanel>[1]> = {}) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const handlers = {
    statuses,
    onChatgptSignIn: vi.fn(),
    onChatgptSignOut: vi.fn(),
    onSubscriptionLogin: vi.fn(),
    onSaveLocalUrl: vi.fn(),
    onResetLocalUrl: vi.fn(),
    ...overrides,
  };
  mountProviderSettingsPanel(parent, handlers);
  return { parent, handlers };
}

afterEach(() => {
  document.body.innerHTML = '';
  setLocale('en');
  vi.restoreAllMocks();
});

describe('mountProviderSettingsPanel', () => {
  it('keeps account sign-in controls, adds the Grok key control, and removes legacy configuration controls', () => {
    const { parent, handlers } = mountProviders();
    parent.querySelector<HTMLButtonElement>('[data-prov-action="signout"]')!.click();

    expect(handlers.onChatgptSignOut).toHaveBeenCalledOnce();
    expect(parent.querySelector('[data-prov-action="subscription-login"][data-prov="claude"]')).not.toBeNull();
    expect(parent.querySelector('[data-prov-action="subscription-login"][data-prov="grok"]')).not.toBeNull();
    expect(parent.querySelector('[data-prov-key="grok"]')).not.toBeNull();
    expect(parent.querySelector('[data-prov-custom], [data-prov-advanced]')).toBeNull();
    expect(parent.querySelector('[data-prov-action="select-cli-override"], [data-prov-action="clear-cli-override"]')).toBeNull();
    expect(parent.querySelector('.prov-onboarding')).toBeNull();
  });

  it('saves and resets only the Ollama URL', async () => {
    const { parent, handlers } = mountProviders();
    parent.querySelector<HTMLButtonElement>('[data-prov-action="reset-url"]')!.click();
    await Promise.resolve();
    await Promise.resolve();
    const url = parent.querySelector<HTMLInputElement>('[data-prov-url="ollama"]')!;
    url.value = 'http://localhost:11500';
    parent.querySelector<HTMLButtonElement>('[data-prov-action="save-url"]')!.click();

    expect(handlers.onSaveLocalUrl).toHaveBeenCalledWith('ollama', 'http://localhost:11500');
    expect(handlers.onResetLocalUrl).toHaveBeenCalledWith('ollama');
    expect(parent.querySelector('[data-prov-row="lmstudio"]')).toBeNull();
  });

  it.each([
    ['en', 'Local models'],
    ['ko', '로컬 모델'],
    ['zh-Hans', '本地模型'],
    ['zh-Hant', '本機模型'],
    ['ja', 'ローカルモデル'],
  ] as const)('localizes the Ollama section header for %s', (locale: Locale, expected: string) => {
    setLocale(locale);
    const { parent } = mountProviders();
    expect(parent.querySelector('.prov-local-section')?.textContent).toBe(expected);
  });
});

describe('mountStyleSettingPanel', () => {
  it('emits onChange when difficulty changes', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const onChange = vi.fn();
    mountStyleSettingPanel(parent, { setting: DEFAULT_STYLE, onChange });
    const select = parent.querySelector<HTMLSelectElement>('select[data-style="difficulty"]')!;
    select.value = 'professional';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith({ difficulty: 'professional', naturalness: 'balanced' });
  });

  it('emits onChange when naturalness changes', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const onChange = vi.fn();
    mountStyleSettingPanel(parent, { setting: DEFAULT_STYLE, onChange });
    const select = parent.querySelector<HTMLSelectElement>('select[data-style="naturalness"]')!;
    select.value = 'off';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith({ difficulty: 'college', naturalness: 'off' });
  });
});
