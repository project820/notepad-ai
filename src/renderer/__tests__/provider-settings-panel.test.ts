import { describe, expect, it } from 'vitest';

import {
  renderProviderSettingsPanel,
  type ProviderStatusView,
} from '../provider-settings-panel';

const connected: ProviderStatusView[] = [
  { provider: 'chatgpt', label: 'ChatGPT', authKind: 'oauth', connected: true, accountLabel: 'me@x.com · plus' },
  { provider: 'claude', label: 'Claude (API key)', authKind: 'api_key', connected: true, keyLast4: '1234' },
  { provider: 'openrouter', label: 'OpenRouter (API key)', authKind: 'api_key', connected: false },
];

const allOff: ProviderStatusView[] = [
  { provider: 'chatgpt', label: 'ChatGPT', authKind: 'oauth', connected: false },
  { provider: 'claude', label: 'Claude (API key)', authKind: 'api_key', connected: false },
  { provider: 'openrouter', label: 'OpenRouter (API key)', authKind: 'api_key', connected: false },
];

describe('renderProviderSettingsPanel', () => {
  it('lists all three providers', () => {
    const html = renderProviderSettingsPanel({ statuses: connected });
    expect(html).toContain('ChatGPT');
    expect(html).toContain('Claude (API key)');
    expect(html).toContain('OpenRouter (API key)');
  });

  it('shows a zero-auth onboarding notice only when no provider is connected (AC23)', () => {
    expect(renderProviderSettingsPanel({ statuses: allOff })).toContain('No AI provider connected');
    expect(renderProviderSettingsPanel({ statuses: connected })).not.toContain('No AI provider connected');
  });

  it('renders ChatGPT as sign-in (OAuth), not an API key input', () => {
    const html = renderProviderSettingsPanel({ statuses: allOff });
    expect(html).toContain('data-prov-action="signin"');
    // ChatGPT row must not offer a key input
    const chatgptRow = html.slice(html.indexOf('data-prov-row="chatgpt"'), html.indexOf('data-prov-row="claude"'));
    expect(chatgptRow).not.toContain('data-prov-key="chatgpt"');
  });

  it('renders API-key inputs for Claude and OpenRouter', () => {
    const html = renderProviderSettingsPanel({ statuses: allOff });
    expect(html).toContain('data-prov-key="claude"');
    expect(html).toContain('data-prov-key="openrouter"');
  });

  it('shows only the last 4 chars of a saved key, never the full key', () => {
    const html = renderProviderSettingsPanel({ statuses: connected });
    expect(html).toContain('••••1234');
    expect(html).not.toMatch(/sk-[A-Za-z0-9]/); // no raw key material
  });

  it('renders a custom model-ID input per provider (catalog-staleness fallback)', () => {
    const html = renderProviderSettingsPanel({ statuses: connected });
    expect(html).toContain('data-prov-custom="chatgpt"');
    expect(html).toContain('data-prov-custom="claude"');
    expect(html).toContain('data-prov-custom="openrouter"');
  });

  it('shows connected status with account/key detail', () => {
    const html = renderProviderSettingsPanel({ statuses: connected });
    expect(html).toContain('me@x.com · plus');
    expect(html).toContain('Connected');
  });

  it('renders an inline error when a provider reports one', () => {
    const html = renderProviderSettingsPanel({
      statuses: [{ provider: 'claude', label: 'Claude', authKind: 'api_key', connected: false, error: 'Invalid key' }],
    });
    expect(html).toContain('Invalid key');
    expect(html).toContain('prov-error');
  });

  it('escapes HTML in labels and account details', () => {
    const html = renderProviderSettingsPanel({
      statuses: [{ provider: 'claude', label: '<b>x</b>', authKind: 'api_key', connected: true, keyLast4: '<i>' }],
    });
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('does not throw on empty statuses and still warns about zero auth', () => {
    const html = renderProviderSettingsPanel({ statuses: [] });
    expect(typeof html).toBe('string');
    expect(html).toContain('No AI provider connected');
  });
});
