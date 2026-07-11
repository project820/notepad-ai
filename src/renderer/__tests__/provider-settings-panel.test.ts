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

const localOffline: ProviderStatusView[] = [
  { provider: 'ollama', label: 'Ollama', authKind: 'local', connected: true, localUrl: 'http://127.0.0.1:11434', localUrlDefault: 'http://127.0.0.1:11434', localModelCount: 0 },
  { provider: 'lmstudio', label: 'LM Studio', authKind: 'local', connected: true, localUrl: 'http://127.0.0.1:1234', localUrlDefault: 'http://127.0.0.1:1234', localModelCount: 0 },
];

describe('renderProviderSettingsPanel — local providers (G003)', () => {
  it('renders a URL input + save/reset per local provider instead of an API key', () => {
    const html = renderProviderSettingsPanel({ statuses: localOffline });
    expect(html).toContain('data-prov-url="ollama"');
    expect(html).toContain('data-prov-url="lmstudio"');
    expect(html).toContain('data-prov-action="save-url"');
    expect(html).toContain('data-prov-action="reset-url"');
    // Local rows never offer an API-key input.
    expect(html).not.toContain('data-prov-key="ollama"');
    expect(html).not.toContain('data-prov-key="lmstudio"');
  });

  it('prefills the configured server URL', () => {
    const html = renderProviderSettingsPanel({
      statuses: [
        { provider: 'ollama', label: 'Ollama', authKind: 'local', connected: true, localUrl: 'http://127.0.0.1:9999', localUrlDefault: 'http://127.0.0.1:11434', localModelCount: 0 },
      ],
    });
    expect(html).toContain('value="http://127.0.0.1:9999"');
  });

  it('shows an offline state as friendly guidance, never an auth error or "Not connected"', () => {
    const html = renderProviderSettingsPanel({ statuses: localOffline });
    expect(html).toContain('No local models found. Start Ollama or load a model in LM Studio.');
    expect(html).toContain('prov-local-note');
    expect(html).not.toContain('prov-error');
    expect(html).not.toContain('Not connected');
  });

  it('shows a positive "models available" status when local models are discovered', () => {
    const html = renderProviderSettingsPanel({
      statuses: [
        { provider: 'ollama', label: 'Ollama', authKind: 'local', connected: true, localUrl: 'http://127.0.0.1:11434', localUrlDefault: 'http://127.0.0.1:11434', localModelCount: 2 },
      ],
    });
    expect(html).toContain('Models available');
    expect(html).toContain('prov-status-on');
  });

  it('suppresses the zero-auth notice when a local provider has models, even with no cloud auth', () => {
    const statuses: ProviderStatusView[] = [
      { provider: 'chatgpt', label: 'ChatGPT', authKind: 'oauth', connected: false },
      { provider: 'ollama', label: 'Ollama', authKind: 'local', connected: true, localModelCount: 1 },
    ];
    expect(renderProviderSettingsPanel({ statuses })).not.toContain('No AI provider connected');
  });

  it('still shows the zero-auth notice when cloud is off and local has no models', () => {
    const statuses: ProviderStatusView[] = [
      { provider: 'chatgpt', label: 'ChatGPT', authKind: 'oauth', connected: false },
      { provider: 'ollama', label: 'Ollama', authKind: 'local', connected: true, localModelCount: 0 },
    ];
    expect(renderProviderSettingsPanel({ statuses })).toContain('No AI provider connected');
  });

  it('keeps cloud rows (API key + custom model) intact alongside local rows (no regression)', () => {
    const statuses: ProviderStatusView[] = [
      { provider: 'claude', label: 'Claude (API key)', authKind: 'api_key', connected: false },
      { provider: 'ollama', label: 'Ollama', authKind: 'local', connected: true, localModelCount: 0 },
    ];
    const html = renderProviderSettingsPanel({ statuses });
    expect(html).toContain('data-prov-key="claude"');
    expect(html).toContain('data-prov-custom="claude"');
    // The local row gets no custom-model input.
    expect(html).not.toContain('data-prov-custom="ollama"');
  });
});

describe('renderProviderSettingsPanel — CLI providers (G006)', () => {
  const grokConnected: ProviderStatusView[] = [
    { provider: 'grok', label: 'Grok (CLI)', authKind: 'cli', connected: true },
  ];
  const grokOffline: ProviderStatusView[] = [
    { provider: 'grok', label: 'Grok (CLI)', authKind: 'cli', connected: false, error: 'Grok CLI not found. Install grok and run `grok login`.' },
  ];

  it('renders a cli row with NO API-key or URL controls and NO custom-model input', () => {
    const html = renderProviderSettingsPanel({ statuses: grokConnected });
    expect(html).toContain('data-prov-row="grok"');
    expect(html).not.toContain('data-prov-key="grok"'); // no API key input
    expect(html).not.toContain('data-prov-url="grok"'); // no server URL input
    expect(html).not.toContain('data-prov-custom="grok"'); // no custom-model input
    expect(html).toContain('Connected · local CLI');
  });

  it('surfaces the install/login guidance error when the CLI is absent', () => {
    const html = renderProviderSettingsPanel({ statuses: grokOffline });
    expect(html).toContain('Not connected');
    expect(html).toMatch(/grok login|Install/);
  });

  it('a connected cli provider satisfies the zero-auth notice (counts as usable)', () => {
    const html = renderProviderSettingsPanel({ statuses: grokConnected });
    expect(html).not.toContain('No AI provider connected');
  });
  it('renders an installed CLI with unverified auth as usable without a disconnected badge', () => {
    const html = renderProviderSettingsPanel({
      statuses: [{
        provider: 'grok',
        label: 'Grok (CLI)',
        authKind: 'cli',
        connected: false,
        authUnverified: true,
        error: 'Grok CLI is installed, but its sign-in status could not be verified. Run `grok login` in a terminal, then reopen the app.',
      }],
    });
    expect(html).toContain('Status unverified');
    expect((html.match(/grok login/g) ?? [])).toHaveLength(1);
    expect(html).toContain('prov-status-unknown');
    expect(html).not.toContain('Not connected');
    expect(html).not.toContain('No AI provider connected');
    expect((html.match(/prov-local-note/g) ?? [])).toHaveLength(0);
  });
});
