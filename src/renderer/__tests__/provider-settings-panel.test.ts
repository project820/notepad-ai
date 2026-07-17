// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';

import {
  mountProviderSettingsPanel,
  renderProviderSettingsPanel,
  type ProviderStatusView,
} from '../provider-settings-panel';

const statuses: ProviderStatusView[] = [
  { provider: 'chatgpt', label: 'ChatGPT', authKind: 'oauth', connected: false },
  { provider: 'claude', label: 'Claude', authKind: 'api_key', connected: false, cliStatus: { installed: true, authState: 'unknown' } },
  { provider: 'grok', label: 'Grok', authKind: 'api_key', connected: false, cliStatus: { installed: true, authState: 'unknown' } },
  { provider: 'ollama', label: 'Ollama', authKind: 'local', connected: true, localUrl: 'http://127.0.0.1:11434', localUrlDefault: 'http://127.0.0.1:11434', localModelCount: 0 },
];

function mount(overrides: Partial<Parameters<typeof mountProviderSettingsPanel>[1]> = {}) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const handlers = {
    statuses,
    onChatgptSignIn: vi.fn(),
    onChatgptSignOut: vi.fn(),
    onSubscriptionLogin: vi.fn(),
    onSubscriptionLogout: vi.fn(),
    onSubscriptionCode: vi.fn(),
    onSubscriptionCancel: vi.fn(),
    onSaveLocalUrl: vi.fn(),
    onResetLocalUrl: vi.fn(),
    onSetApiKey: vi.fn(),
    onDeleteProviderKey: vi.fn(),
    ...overrides,
  };
  const handle = mountProviderSettingsPanel(parent, handlers);
  return { parent, handlers, handle };
}

describe('renderProviderSettingsPanel', () => {
  it('renders the cloud account providers in order, then a local-model section with Ollama', () => {
    const html = renderProviderSettingsPanel({ statuses });
    const order = ['chatgpt', 'claude', 'grok', 'ollama'].map((provider) => html.indexOf(`data-prov-row="${provider}"`));

    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(html).toContain('prov-local-section');
    expect(html.indexOf('prov-local-section')).toBeGreaterThan(order[2]);
    expect(html.indexOf('prov-local-section')).toBeLessThan(order[3]);
  });

  it('does not expose retired providers, executable, custom-model, or onboarding UI', () => {
    const html = renderProviderSettingsPanel({ statuses });

    expect(html).not.toContain('OpenRouter');
    expect(html).not.toContain('LM Studio');
    expect(html).not.toContain('data-prov-custom=');
    expect(html).not.toContain('set-custom');
    expect(html).not.toContain('cli-override');
    expect(html).not.toContain('select-cli-override');
    expect(html).not.toContain('dismiss-cli-onboarding');
    expect(html).not.toContain('claude login');
  });

  it('keeps ChatGPT OAuth and Claude/Grok subscription sign-in controls', () => {
    const html = renderProviderSettingsPanel({ statuses });
    expect(html).toContain('data-prov-action="signin"');
    expect(html).toContain('data-prov-action="subscription-login" data-prov="claude"');
    expect(html).toContain('data-prov-action="subscription-login" data-prov="grok"');
  });
  it('renders a password input and save button for Grok’s xAI API key', () => {
    const html = renderProviderSettingsPanel({ statuses });

    expect(html).toContain('data-prov-key="grok"');
    expect(html).toContain('type="password"');
    expect(html).toContain('data-prov-action="save-key" data-prov="grok"');
  });

  it('does not surface a retained API-key identifier for a legacy connected provider', () => {
    const html = renderProviderSettingsPanel({
      statuses: [{ provider: 'claude', label: 'Claude', authKind: 'api_key', connected: true, keyLast4: '1234' }],
    });
    expect(html).toContain('Signed in');
    expect(html).not.toContain('1234');
    expect(html).not.toContain('API key');
  });
});

describe('mountProviderSettingsPanel', () => {
  it('submits an awaiting Claude code but keeps Grok to its sign-in button', () => {
    const { parent, handlers, handle } = mount();
    handle.setSubscriptionProgress({ provider: 'claude', kind: 'awaiting-code' });

    const code = parent.querySelector<HTMLInputElement>('[data-prov-login-code="claude"]')!;
    code.value = 'claude-code';
    parent.querySelector<HTMLButtonElement>('[data-prov-action="subscription-code"]')!.click();

    expect(handlers.onSubscriptionCode).toHaveBeenCalledWith('claude', 'claude-code');
    expect(parent.querySelector('[data-prov-row="grok"] [data-prov-login-code]')).toBeNull();
    expect(parent.querySelector('[data-prov-action="subscription-login"][data-prov="grok"]')).not.toBeNull();
  });

  it('saves and resets Ollama URLs without exposing other local providers', async () => {
    const { parent, handlers } = mount();
    parent.querySelector<HTMLButtonElement>('[data-prov-action="reset-url"]')!.click();
    await Promise.resolve();
    await Promise.resolve();
    const input = parent.querySelector<HTMLInputElement>('[data-prov-url="ollama"]')!;
    input.value = 'http://localhost:11500';
    parent.querySelector<HTMLButtonElement>('[data-prov-action="save-url"]')!.click();

    expect(handlers.onSaveLocalUrl).toHaveBeenCalledWith('ollama', 'http://localhost:11500');
    expect(handlers.onResetLocalUrl).toHaveBeenCalledWith('ollama');
    expect(parent.querySelector('[data-prov-row="lmstudio"]')).toBeNull();
  });
  it('saves a trimmed Grok API key and clears the input', () => {
    const { parent, handlers } = mount();
    const input = parent.querySelector<HTMLInputElement>('[data-prov-key="grok"]')!;
    input.value = '  xai-key  ';

    parent.querySelector<HTMLButtonElement>('[data-prov-action="save-key"][data-prov="grok"]')!.click();

    expect(handlers.onSetApiKey).toHaveBeenCalledWith('grok', 'xai-key');
    expect(input.value).toBe('');
  });

  it('does not save an empty Grok API key', () => {
    const { parent, handlers } = mount();
    const input = parent.querySelector<HTMLInputElement>('[data-prov-key="grok"]')!;
    input.value = '   ';

    parent.querySelector<HTMLButtonElement>('[data-prov-action="save-key"][data-prov="grok"]')!.click();

    expect(handlers.onSetApiKey).not.toHaveBeenCalled();
  });

  it('deletes a connected Grok API key', () => {
    const connected = statuses.map((status) => status.provider === 'grok'
      ? { ...status, connected: true, keyLast4: '1234' }
      : status);
    const { parent, handlers } = mount({ statuses: connected });

    parent.querySelector<HTMLButtonElement>('[data-prov-action="delete-key"][data-prov="grok"]')!.click();

    expect(handlers.onDeleteProviderKey).toHaveBeenCalledWith('grok');
  });
});
