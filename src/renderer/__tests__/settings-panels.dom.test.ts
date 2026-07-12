// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountProviderSettingsPanel, type ProviderStatusView } from '../provider-settings-panel';
import { __resetCliOnboardingPromptForTests, openSettingsModal, triggerCliOnboarding } from '../settings-modal';
import { mountStyleSettingPanel } from '../style-setting-panel';
import { DEFAULT_STYLE } from '../humanize-engine';
import { setLocale, type Locale } from '../i18n';
import type { ProviderAuthStatus } from '../../main/ai/types';

afterEach(() => {
  document.body.innerHTML = '';
  setLocale('en');
  vi.restoreAllMocks();
  localStorage.clear();
  __resetCliOnboardingPromptForTests();
});

const statuses: ProviderStatusView[] = [
  { provider: 'chatgpt', label: 'ChatGPT', authKind: 'oauth', connected: true, accountLabel: 'me' },
  { provider: 'claude', label: 'Claude', authKind: 'api_key', connected: false },
  { provider: 'openrouter', label: 'OpenRouter', authKind: 'api_key', connected: false },
];
const SETTINGS_LOCALE_EXPECTATIONS: ReadonlyArray<{
  locale: Locale;
  dialog: string;
  close: string;
  grokSetupError: string;
  statusLoadFailed: string;
  retry: string;
  grokUnverified: string;
  grokAuthUnknown: string;
}> = [
  {
    locale: 'en',
    dialog: 'Settings',
    close: 'Close',
    grokSetupError: 'Grok CLI is unavailable. Install it and run `grok login` in a terminal, then reopen the app.',
    statusLoadFailed: 'Could not load provider status. Try again.',
    retry: 'Retry',
    grokUnverified: 'Status unverified',
    grokAuthUnknown: 'Grok CLI is installed, but its sign-in status could not be verified. Run `grok login` in a terminal, then reopen the app.',
  },
  {
    locale: 'ko',
    dialog: '설정',
    close: '닫기',
    grokSetupError: 'Grok CLI를 사용할 수 없습니다. 설치한 뒤 터미널에서 `grok login`을 실행하고 앱을 다시 여세요.',
    statusLoadFailed: '제공자 상태를 불러오지 못했습니다. 다시 시도하세요.',
    retry: '다시 시도',
    grokUnverified: '상태 미확인',
    grokAuthUnknown: 'Grok CLI는 설치되어 있지만 로그인 상태를 확인할 수 없습니다. 터미널에서 `grok login`을 실행한 후 앱을 다시 여세요.',
  },
  {
    locale: 'zh-Hans',
    dialog: '设置',
    close: '关闭',
    grokSetupError: 'Grok CLI 不可用。请安装后在终端运行 `grok login`，然后重新打开应用。',
    statusLoadFailed: '无法加载提供商状态。请重试。',
    retry: '重试',
    grokUnverified: '状态未确认',
    grokAuthUnknown: 'Grok CLI 已安装，但无法验证登录状态。请在终端运行 `grok login`，然后重新打开应用。',
  },
  {
    locale: 'zh-Hant',
    dialog: '設定',
    close: '關閉',
    grokSetupError: 'Grok CLI 無法使用。請安裝後在終端機執行 `grok login`，然後重新開啟應用程式。',
    statusLoadFailed: '無法載入供應商狀態。請重試。',
    retry: '重試',
    grokUnverified: '狀態未確認',
    grokAuthUnknown: 'Grok CLI 已安裝，但無法驗證登入狀態。請在終端機執行 `grok login`，然後重新開啟應用程式。',
  },
  {
    locale: 'ja',
    dialog: '設定',
    close: '閉じる',
    grokSetupError: 'Grok CLI は利用できません。インストール後にターミナルで `grok login` を実行し、アプリを開き直してください。',
    statusLoadFailed: 'プロバイダーの状態を読み込めませんでした。もう一度お試しください。',
    retry: '再試行',
    grokUnverified: '状態未確認',
    grokAuthUnknown: 'Grok CLI はインストールされていますが、サインイン状態を確認できません。ターミナルで `grok login` を実行してからアプリを開き直してください。',
  },
];

const EN_GROK_SETUP_ERROR = SETTINGS_LOCALE_EXPECTATIONS[0].grokSetupError;
const EN_STATUS_LOAD_FAILED = SETTINGS_LOCALE_EXPECTATIONS[0].statusLoadFailed;
const EN_RETRY = SETTINGS_LOCALE_EXPECTATIONS[0].retry;
const EN_GROK_UNVERIFIED = SETTINGS_LOCALE_EXPECTATIONS[0].grokUnverified;
const EN_GROK_AUTH_UNKNOWN = SETTINGS_LOCALE_EXPECTATIONS[0].grokAuthUnknown;
const GROK_SETUP_STATUS: ProviderAuthStatus = {
  provider: 'grok',
  label: 'Grok (CLI)',
  authKind: 'cli',
  connected: false,
  errorCode: 'grok_cli_setup_required',
};

function installProviderStatusApi(aiProvidersStatus = vi.fn().mockResolvedValue([GROK_SETUP_STATUS])) {
  const apiWindow = window as unknown as { api?: unknown };
  const hadApi = Object.prototype.hasOwnProperty.call(window, 'api');
  const previousApi = apiWindow.api;
  apiWindow.api = {
    aiProvidersStatus,
    localAiGetConfig: vi.fn().mockResolvedValue({
      ollama: 'http://127.0.0.1:11434',
      lmstudio: 'http://127.0.0.1:1234',
    }),
    aiModels: vi.fn().mockResolvedValue([]),
    mdHandlerStatus: vi.fn().mockResolvedValue({ supported: false, registered: false }),
  };

  return () => {
    if (hadApi) apiWindow.api = previousApi;
    else Reflect.deleteProperty(apiWindow, 'api');
  };
}

async function flushSettingsRender() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

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

  it('saves a Claude API key from its input and clears the field after a successful save', async () => {
    const { parent, handlers } = mountProviders();
    const input = parent.querySelector<HTMLInputElement>('input[data-prov-key="claude"]')!;
    input.value = 'sk-claude-key';
    parent.querySelector<HTMLButtonElement>('[data-prov-action="save-key"][data-prov="claude"]')!.click();
    expect(handlers.onSaveKey).toHaveBeenCalledWith('claude', 'sk-claude-key');
    await Promise.resolve();
    expect(input.value).toBe('');
  });
  it('shows Grok API-key controls while retaining its independent CLI badge', () => {
    const { parent, handlers } = mountProviders({
      statuses: [{
        provider: 'grok',
        label: 'Grok (xAI API · CLI fallback)',
        authKind: 'api_key',
        connected: true,
        keyLast4: '1234',
        cliStatus: { installed: true, authState: 'unknown', errorCode: 'grok_cli_auth_unknown' },
      }],
    });
    const input = parent.querySelector<HTMLInputElement>('input[data-prov-key="grok"]');
    expect(input).not.toBeNull();
    expect(parent.querySelector('[data-prov-cli-status="grok"]')?.textContent).toContain('CLI status unverified');
    input!.value = 'xai-key';
    parent.querySelector<HTMLButtonElement>('[data-prov-action="save-key"][data-prov="grok"]')!.click();
    expect(handlers.onSaveKey).toHaveBeenCalledWith('grok', 'xai-key');
  });

  it('does not save an empty key', () => {
    const { parent, handlers } = mountProviders();
    parent.querySelector<HTMLButtonElement>('[data-prov-action="save-key"][data-prov="openrouter"]')!.click();
    expect(handlers.onSaveKey).not.toHaveBeenCalled();
  });
  it('retains the API key input and shows an error when persistence fails', async () => {
    const { parent } = mountProviders({
      onSaveKey: vi.fn(() => Promise.reject(new Error('fsync failed'))),
    });
    const input = parent.querySelector<HTMLInputElement>('input[data-prov-key="claude"]')!;
    input.value = 'sk-claude-key';
    parent.querySelector<HTMLButtonElement>('[data-prov-action="save-key"][data-prov="claude"]')!.click();

    await Promise.resolve();
    await Promise.resolve();
    expect(input.value).toBe('sk-claude-key');
    expect(parent.querySelector('.prov-error[data-prov-save-error]')?.textContent).toContain('Unable to save API key');
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
describe('openSettingsModal — accessibility', () => {
  it('localizes dialog and close accessible labels across all five locales', () => {
    try {
      for (const { locale, dialog: dialogLabel, close: closeLabel } of SETTINGS_LOCALE_EXPECTATIONS) {
        setLocale(locale);
        openSettingsModal({ onSetCustomModel: vi.fn() });

        const dialog = document.querySelector<HTMLElement>('.settings-modal')!;
        const close = document.querySelector<HTMLButtonElement>('#settings-close')!;
        expect(dialog.getAttribute('aria-label'), `dialog label @ ${locale}`).toBe(dialogLabel);
        expect(close.getAttribute('aria-label'), `close label @ ${locale}`).toBe(closeLabel);

        close.click();
        expect(document.querySelector('.settings-modal-root')).toBeNull();
      }
    } finally {
      document.querySelector<HTMLButtonElement>('#settings-close')?.click();
      setLocale('en');
    }
  });

  it('localizes stable provider setup codes across all five locales', async () => {
    const restoreApi = installProviderStatusApi();
    try {
      for (const { locale, grokSetupError } of SETTINGS_LOCALE_EXPECTATIONS) {
        setLocale(locale);
        openSettingsModal({ onSetCustomModel: vi.fn() });
        await flushSettingsRender();

        const error = document.querySelector<HTMLElement>('.prov-error')!;
        expect(error.textContent, `Grok setup error @ ${locale}`).toBe(grokSetupError);
        expect(error.textContent).not.toContain('settings.prov.error.grokCliSetupRequired');
        expect(error.textContent?.match(/grok login/g)).toHaveLength(1);
        expect(document.querySelectorAll('.prov-local-note')).toHaveLength(0);
        if (locale !== 'en') {
          expect(error.textContent).not.toContain(EN_GROK_SETUP_ERROR);
          expect(error.textContent).not.toContain('Grok CLI is unavailable');
        }

        document.querySelector<HTMLButtonElement>('#settings-close')!.click();
        expect(document.querySelector('.settings-modal-root')).toBeNull();
      }
    } finally {
      document.querySelector<HTMLButtonElement>('#settings-close')?.click();
      restoreApi();
      setLocale('en');
    }
  });
  it('renders Claude setup guidance exactly once', async () => {
    const restoreApi = installProviderStatusApi(
      vi.fn().mockResolvedValue([{
        provider: 'claude',
        label: 'Claude',
        authKind: 'api_key',
        connected: false,
        errorCode: 'claude_cli_setup_required',
      } satisfies ProviderAuthStatus]),
    );
    try {
      openSettingsModal({ onSetCustomModel: vi.fn() });
      await flushSettingsRender();

      expect(document.querySelectorAll('.prov-error')).toHaveLength(1);
      expect(document.querySelector('.prov-error')?.textContent?.match(/claude login/g)).toHaveLength(1);
      expect(document.querySelectorAll('.prov-local-note')).toHaveLength(0);
    } finally {
      document.querySelector<HTMLButtonElement>('#settings-close')?.click();
      restoreApi();
    }
  });

  it('shows CLI connectivity without claiming Claude has an API key', async () => {
    const restoreApi = installProviderStatusApi(
      vi.fn().mockResolvedValue([{
        provider: 'claude',
        label: 'Claude (CLI)',
        authKind: 'api_key',
        connected: true,
        connectionSource: 'cli',
      } satisfies ProviderAuthStatus]),
    );
    try {
      openSettingsModal({ onSetCustomModel: vi.fn() });
      await flushSettingsRender();

      expect(document.querySelector('.prov-status')?.textContent).toContain('Connected · local CLI');
      expect(document.querySelector('.prov-status')?.textContent).not.toContain('Key set');
      expect(document.querySelectorAll('.prov-local-note')).toHaveLength(1);
    } finally {
      document.querySelector<HTMLButtonElement>('#settings-close')?.click();
      restoreApi();
    }
  });

  it.each(SETTINGS_LOCALE_EXPECTATIONS)('localizes retryable provider-status load failures @ $locale', async ({
    locale,
    statusLoadFailed,
    retry,
  }) => {
    const aiProvidersStatus = vi.fn()
      .mockRejectedValueOnce(new Error('IPC unavailable'))
      .mockResolvedValueOnce([]);
    const restoreApi = installProviderStatusApi(aiProvidersStatus);
    try {
      setLocale(locale);
      openSettingsModal({ onSetCustomModel: vi.fn() });
      await flushSettingsRender();

      const loadError = document.querySelector<HTMLElement>('.prov-load-error')!;
      const retryButton = document.querySelector<HTMLButtonElement>('[data-prov-action="retry-status"]')!;
      expect(loadError.textContent, `load failure @ ${locale}`).toBe(`${statusLoadFailed} ${retry}`);
      expect(retryButton.textContent, `retry label @ ${locale}`).toBe(retry);
      expect(loadError.textContent).not.toContain('settings.prov.statusLoadFailed');
      expect(retryButton.textContent).not.toContain('settings.prov.retry');
      expect(document.querySelector('.prov-zero-auth')).toBeNull();
      if (locale !== 'en') {
        expect(loadError.textContent).not.toContain(EN_STATUS_LOAD_FAILED);
        expect(retryButton.textContent).not.toContain(EN_RETRY);
      }

      retryButton.click();
      await flushSettingsRender();

      expect(aiProvidersStatus).toHaveBeenCalledTimes(2);
      expect(document.querySelector('.prov-zero-auth')).not.toBeNull();
    } finally {
      document.querySelector<HTMLButtonElement>('#settings-close')?.click();
      restoreApi();
      setLocale('en');
    }
  });

  it('uses localized unknown-error copy and escapes the raw diagnostic detail', async () => {
    const rawError = '<img src=x onerror=alert(1)>';
    const restoreApi = installProviderStatusApi(
      vi.fn().mockResolvedValue([{
        provider: 'openrouter',
        label: 'OpenRouter',
        authKind: 'api_key',
        connected: false,
        error: rawError,
      } satisfies ProviderAuthStatus]),
    );
    try {
      openSettingsModal({ onSetCustomModel: vi.fn() });
      await flushSettingsRender();

      expect(document.querySelector('.prov-error')?.textContent).toBe('We could not determine this provider’s status. Try again.');
      expect(document.querySelector('.prov-error-detail')?.textContent).toBe(rawError);
      expect(document.querySelector('.prov-error-detail img')).toBeNull();
    } finally {
      document.querySelector<HTMLButtonElement>('#settings-close')?.click();
      restoreApi();
    }
  });

  it.each(SETTINGS_LOCALE_EXPECTATIONS)('localizes installed-but-auth-unverified Grok guidance @ $locale', async ({
    locale,
    grokUnverified,
    grokAuthUnknown,
  }) => {
    const restoreApi = installProviderStatusApi(
      vi.fn().mockResolvedValue([{
        provider: 'grok',
        label: 'Grok (CLI)',
        authKind: 'cli',
        connected: false,
        authUnverified: true,
        installed: true,
        errorCode: 'grok_cli_auth_unknown',
      } satisfies ProviderAuthStatus]),
    );
    try {
      setLocale(locale);
      openSettingsModal({ onSetCustomModel: vi.fn() });
      await flushSettingsRender();

      const status = document.querySelector<HTMLElement>('.prov-status')!;
      const guidance = document.querySelector<HTMLElement>('.prov-error')!;
      const row = document.querySelector<HTMLElement>('[data-prov-row="grok"]')!;
      expect(status.textContent, `unverified badge @ ${locale}`).toBe(grokUnverified);
      expect(guidance.textContent, `unverified guidance @ ${locale}`).toBe(grokAuthUnknown);
      expect(status.classList.contains('prov-status-unknown')).toBe(true);
      expect(status.textContent).not.toContain('settings.prov.unverified');
      expect(guidance.textContent).not.toContain('settings.prov.error.grokCliAuthUnknown');
      expect(status.textContent).not.toContain('Not connected');
      expect(row.textContent?.match(/grok login/g), `Grok login guidance count @ ${locale}`).toHaveLength(1);
      expect(document.querySelector('.prov-zero-auth')).toBeNull();
      expect(document.querySelectorAll('.prov-local-note')).toHaveLength(0);
      if (locale !== 'en') {
        expect(status.textContent).not.toContain(EN_GROK_UNVERIFIED);
        expect(guidance.textContent).not.toContain(EN_GROK_AUTH_UNKNOWN);
      }
    } finally {
      document.querySelector<HTMLButtonElement>('#settings-close')?.click();
      restoreApi();
      setLocale('en');
    }
  });

  it('keeps onboarding visible for a contradictory unverified-but-not-installed status (registry parity)', async () => {
    const restoreApi = installProviderStatusApi(
      vi.fn().mockResolvedValue([{
        provider: 'grok',
        label: 'Grok (CLI)',
        authKind: 'cli',
        connected: false,
        authUnverified: true,
        installed: false,
        errorCode: 'grok_cli_setup_required',
      } satisfies ProviderAuthStatus]),
    );
    try {
      openSettingsModal({ onSetCustomModel: vi.fn() });
      await flushSettingsRender();

      // Mirrors ProviderRegistry.isAttemptableStatus(): not installed means not
      // usable — zero-auth onboarding stays, and no unverified badge renders.
      expect(document.querySelector('.prov-zero-auth')).not.toBeNull();
      expect(document.querySelector('.prov-status-unknown')).toBeNull();
      expect(document.querySelector('.prov-status')?.classList.contains('prov-status-off')).toBe(true);
    } finally {
      document.querySelector<HTMLButtonElement>('#settings-close')?.click();
      restoreApi();
    }
  });
  it('renders Claude API and CLI states independently, including auth failure', async () => {
    const restoreApi = installProviderStatusApi(vi.fn().mockResolvedValue([{
      provider: 'claude',
      label: 'Claude',
      authKind: 'api_key',
      connected: true,
      connectionSource: 'api_key',
      keyLast4: '1234',
      cliStatus: { installed: true, authState: 'auth_failed', errorCode: 'claude_cli_login_required' },
    } satisfies ProviderAuthStatus]));
    try {
      openSettingsModal({ onSetCustomModel: vi.fn() });
      await flushSettingsRender();
      const row = document.querySelector('[data-prov-row="claude"]')!;
      expect(row.textContent).toContain('••••1234');
      expect(row.textContent).toContain('CLI login required');
      expect(row.querySelector('[data-prov-cli-status="claude"]')).not.toBeNull();
    } finally {
      document.querySelector<HTMLButtonElement>('#settings-close')?.click();
      restoreApi();
    }
  });

  it('dismisses the inline CLI guide only by its button and keeps its accessibility contract', () => {
    const { parent } = mountProviders({
      statuses: [{
        provider: 'claude',
        label: 'Claude',
        authKind: 'api_key',
        connected: false,
        cliStatus: { installed: true, authState: 'unknown' },
      }],
    });
    const card = parent.querySelector<HTMLElement>('.prov-onboarding')!;
    expect(card.getAttribute('role')).toBe('status');
    expect(card.getAttribute('aria-live')).toBe('polite');
    const dismiss = card.querySelector<HTMLButtonElement>('[data-prov-action="dismiss-cli-onboarding"]')!;
    expect(dismiss.getAttribute('aria-label')).toBe('Dismiss CLI setup guide');
    dismiss.click();
    expect(parent.querySelector('.prov-onboarding')).toBeNull();
    expect(JSON.parse(localStorage.getItem('notepad-ai:cli-onboarding-dismissed:v1') ?? '{}')).toEqual({ claude: 1 });
  });

  it('deduplicates no-auth onboarding triggers without affecting manual settings opens', () => {
    const open = vi.fn();
    triggerCliOnboarding(open);
    triggerCliOnboarding(open);
    expect(open).toHaveBeenCalledTimes(1);
  });
});
