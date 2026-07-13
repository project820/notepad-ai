// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { mountProviderSettingsPanel, type ProviderStatusView } from '../provider-settings-panel';

const statuses: ProviderStatusView[] = [
  { provider: 'claude', label: 'Claude', authKind: 'api_key', connected: false, cliStatus: { installed: true, authState: 'unknown' } },
];

describe('subscription login panel', () => {
  it('lazy-mounts advanced API-key and executable controls, then unmounts them', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    mountProviderSettingsPanel(parent, {
      statuses, onChatgptSignIn: vi.fn(), onChatgptSignOut: vi.fn(), onSaveKey: vi.fn(), onDeleteKey: vi.fn(), onSetCustomModel: vi.fn(),
      onSelectCliOverride: vi.fn(), onClearCliOverride: vi.fn(), onSubscriptionLogin: vi.fn(),
    });
    const advanced = parent.querySelector<HTMLDetailsElement>('[data-prov-advanced="claude"]')!;
    expect(parent.querySelector('[data-prov-action="subscription-login"]')).not.toBeNull();
    expect(parent.querySelector('[data-prov-key="claude"]')).toBeNull();
    expect(parent.querySelector('[data-prov-action="select-cli-override"]')).toBeNull();
    advanced.open = true;
    advanced.dispatchEvent(new Event('toggle', { bubbles: true }));
    expect(parent.querySelector('[data-prov-key="claude"]')).not.toBeNull();
    expect(parent.querySelector('[data-prov-action="select-cli-override"]')).not.toBeNull();
    advanced.open = false;
    advanced.dispatchEvent(new Event('toggle', { bubbles: true }));
    expect(parent.querySelector('[data-prov-key="claude"]')).toBeNull();
    expect(parent.querySelector('[data-prov-action="select-cli-override"]')).toBeNull();
  });
});
