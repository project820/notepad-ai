// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { mountProviderSettingsPanel, type ProviderStatusView } from '../provider-settings-panel';

describe('subscription login panel', () => {
  it('uses in-app Claude sign-in and code entry without legacy advanced controls', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const onSubscriptionLogin = vi.fn();
    const onSubscriptionCode = vi.fn();
    const handle = mountProviderSettingsPanel(parent, {
      statuses: [{ provider: 'claude', label: 'Claude', authKind: 'api_key', connected: false } satisfies ProviderStatusView],
      onChatgptSignIn: vi.fn(),
      onChatgptSignOut: vi.fn(),
      onSubscriptionLogin,
      onSubscriptionCode,
    });

    parent.querySelector<HTMLButtonElement>('[data-prov-action="subscription-login"]')!.click();
    expect(onSubscriptionLogin).toHaveBeenCalledWith('claude');

    handle.setSubscriptionProgress({ provider: 'claude', kind: 'awaiting-code' });
    const input = parent.querySelector<HTMLInputElement>('[data-prov-login-code="claude"]')!;
    input.value = 'code-from-browser';
    parent.querySelector<HTMLButtonElement>('[data-prov-action="subscription-code"]')!.click();

    expect(onSubscriptionCode).toHaveBeenCalledWith('claude', 'code-from-browser');
    expect(parent.querySelector('[data-prov-advanced]')).toBeNull();
    expect(parent.querySelector('[data-prov-key]')).toBeNull();
    expect(parent.querySelector('[data-prov-action="select-cli-override"]')).toBeNull();
    expect(parent.textContent).not.toContain('claude login');
  });
});
