// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountProviderSettingsPanel, type ProviderStatusView } from '../provider-settings-panel';
import { mountStyleSettingPanel } from '../style-setting-panel';
import { DEFAULT_STYLE } from '../humanize-engine';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const statuses: ProviderStatusView[] = [
  { provider: 'chatgpt', label: 'ChatGPT', authKind: 'oauth', connected: true, accountLabel: 'me' },
  { provider: 'claude', label: 'Claude', authKind: 'api_key', connected: false },
  { provider: 'openrouter', label: 'OpenRouter', authKind: 'api_key', connected: false },
];

function mountProviders(over: Partial<Parameters<typeof mountProviderSettingsPanel>[1]> = {}) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const handlers = {
    onChatgptSignIn: vi.fn(),
    onChatgptSignOut: vi.fn(),
    onSaveKey: vi.fn(),
    onDeleteKey: vi.fn(),
    onSetCustomModel: vi.fn(),
    statuses,
    ...over,
  };
  mountProviderSettingsPanel(parent, handlers);
  return { parent, handlers };
}

describe('mountProviderSettingsPanel — interactions', () => {
  it('ChatGPT sign-out fires when connected', () => {
    const { parent, handlers } = mountProviders();
    parent.querySelector<HTMLButtonElement>('[data-prov-action="signout"]')!.click();
    expect(handlers.onChatgptSignOut).toHaveBeenCalledTimes(1);
  });

  it('saves a Claude API key from its input and clears the field', () => {
    const { parent, handlers } = mountProviders();
    const input = parent.querySelector<HTMLInputElement>('input[data-prov-key="claude"]')!;
    input.value = 'sk-claude-key';
    parent.querySelector<HTMLButtonElement>('[data-prov-action="save-key"][data-prov="claude"]')!.click();
    expect(handlers.onSaveKey).toHaveBeenCalledWith('claude', 'sk-claude-key');
    expect(input.value).toBe('');
  });

  it('does not save an empty key', () => {
    const { parent, handlers } = mountProviders();
    parent.querySelector<HTMLButtonElement>('[data-prov-action="save-key"][data-prov="openrouter"]')!.click();
    expect(handlers.onSaveKey).not.toHaveBeenCalled();
  });

  it('sets a custom model id', () => {
    const { parent, handlers } = mountProviders();
    const input = parent.querySelector<HTMLInputElement>('input[data-prov-custom="claude"]')!;
    input.value = 'claude-future-1';
    parent.querySelector<HTMLButtonElement>('[data-prov-action="set-custom"][data-prov="claude"]')!.click();
    expect(handlers.onSetCustomModel).toHaveBeenCalledWith('claude', 'claude-future-1');
  });

  it('fires sign-in when ChatGPT is disconnected', () => {
    const off = statuses.map((s) => (s.provider === 'chatgpt' ? { ...s, connected: false } : s));
    const { parent, handlers } = mountProviders({ statuses: off });
    parent.querySelector<HTMLButtonElement>('[data-prov-action="signin"]')!.click();
    expect(handlers.onChatgptSignIn).toHaveBeenCalledTimes(1);
  });

  it('destroy clears the panel and detaches listeners', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const handle = mountProviderSettingsPanel(parent, {
      statuses,
      onChatgptSignIn: vi.fn(),
      onChatgptSignOut: vi.fn(),
      onSaveKey: vi.fn(),
      onDeleteKey: vi.fn(),
      onSetCustomModel: vi.fn(),
    });
    handle.destroy();
    expect(parent.innerHTML).toBe('');
  });
});

describe('mountStyleSettingPanel — interactions', () => {
  it('emits onChange when difficulty changes', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const onChange = vi.fn();
    mountStyleSettingPanel(parent, { setting: DEFAULT_STYLE, onChange });
    const sel = parent.querySelector<HTMLSelectElement>('select[data-style="difficulty"]')!;
    sel.value = 'professional';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith({ difficulty: 'professional', naturalness: 'balanced' });
  });

  it('emits onChange when naturalness changes', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const onChange = vi.fn();
    mountStyleSettingPanel(parent, { setting: DEFAULT_STYLE, onChange });
    const sel = parent.querySelector<HTMLSelectElement>('select[data-style="naturalness"]')!;
    sel.value = 'off';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith({ difficulty: 'college', naturalness: 'off' });
  });
});

describe('mountProviderSettingsPanel — local providers (G003)', () => {
  const localStatuses: ProviderStatusView[] = [
    { provider: 'ollama', label: 'Ollama', authKind: 'local', connected: true, localUrl: 'http://127.0.0.1:11434', localUrlDefault: 'http://127.0.0.1:11434', localModelCount: 0 },
  ];

  function mountLocal() {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const handlers = {
      onChatgptSignIn: vi.fn(),
      onChatgptSignOut: vi.fn(),
      onSaveKey: vi.fn(),
      onDeleteKey: vi.fn(),
      onSetCustomModel: vi.fn(),
      onSaveLocalUrl: vi.fn(),
      onResetLocalUrl: vi.fn(),
      statuses: localStatuses,
    };
    mountProviderSettingsPanel(parent, handlers);
    return { parent, handlers };
  }

  it('saves a typed server URL via onSaveLocalUrl', () => {
    const { parent, handlers } = mountLocal();
    const input = parent.querySelector<HTMLInputElement>('input[data-prov-url="ollama"]')!;
    input.value = 'http://localhost:11500';
    parent.querySelector<HTMLButtonElement>('[data-prov-action="save-url"][data-prov="ollama"]')!.click();
    expect(handlers.onSaveLocalUrl).toHaveBeenCalledWith('ollama', 'http://localhost:11500');
  });

  it('does not save an empty/whitespace URL', () => {
    const { parent, handlers } = mountLocal();
    const input = parent.querySelector<HTMLInputElement>('input[data-prov-url="ollama"]')!;
    input.value = '   ';
    parent.querySelector<HTMLButtonElement>('[data-prov-action="save-url"][data-prov="ollama"]')!.click();
    expect(handlers.onSaveLocalUrl).not.toHaveBeenCalled();
  });

  it('resets the server URL via onResetLocalUrl', () => {
    const { parent, handlers } = mountLocal();
    parent.querySelector<HTMLButtonElement>('[data-prov-action="reset-url"][data-prov="ollama"]')!.click();
    expect(handlers.onResetLocalUrl).toHaveBeenCalledWith('ollama');
  });

  it('never renders an API-key input or fires key handlers for a local row (offline is not auth)', () => {
    const { parent, handlers } = mountLocal();
    expect(parent.querySelector('input[data-prov-key="ollama"]')).toBeNull();
    expect(handlers.onSaveKey).not.toHaveBeenCalled();
    expect(handlers.onDeleteKey).not.toHaveBeenCalled();
  });
});
