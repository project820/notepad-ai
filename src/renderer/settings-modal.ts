/**
 * settings-modal.ts — the AI settings overlay (G001/G004 renderer).
 *
 * Hosts the multi-provider settings panel (sign-in / API keys / custom model
 * ID / zero-auth notice / actionable errors — AC22/23/24) and the unified
 * Style panel (difficulty + always-on humanize naturalness — AC16). All IPC and
 * prefs side effects are injected so the panels stay DOM-testable in isolation.
 */

import { mountProviderSettingsPanel, type ProviderSettingsHandle, type ProviderStatusView } from './provider-settings-panel';
import { openLoginModal } from './login-modal';
import { t } from './i18n';
import type { AiProviderId, ModelRef, ProviderAuthStatus, ProviderAuthStatusCode } from '../main/ai/types';
import { trapModalFocus } from './modal-a11y';

const PROVIDER_STATUS_ERROR_KEYS: Record<ProviderAuthStatusCode, string> = {
  claude_cli_setup_required: 'settings.prov.error.claudeCliSetupRequired',
  claude_cli_auth_unknown: 'settings.prov.cliBadge.unknown',
  claude_cli_login_required: 'settings.prov.error.claudeCliLoginRequired',
  grok_cli_setup_required: 'settings.prov.error.grokCliSetupRequired',
  grok_cli_auth_unknown: 'settings.prov.error.grokCliAuthUnknown',
};

// Default local server URLs. Mirrors src/main/ai/local-config.ts but defined
// here so the renderer never imports the Electron-bound local-config module
// (which uses `require('electron')`). Ollama / LM Studio use fixed default ports.
const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_LMSTUDIO_BASE_URL = 'http://127.0.0.1:1234';
const KNOWN_PROVIDER_ROWS: readonly ProviderStatusView[] = [
  { provider: 'chatgpt', label: 'ChatGPT', authKind: 'oauth', connected: false },
  { provider: 'claude', label: 'Claude', authKind: 'api_key', connected: false },
  { provider: 'openrouter', label: 'OpenRouter', authKind: 'api_key', connected: false },
  { provider: 'ollama', label: 'Ollama', authKind: 'local', connected: false },
  { provider: 'lmstudio', label: 'LM Studio', authKind: 'local', connected: false },
  { provider: 'grok', label: 'Grok (CLI)', authKind: 'cli', connected: false },
];

type ProviderSnapshot = {
  statuses?: ProviderAuthStatus[];
  statusLoadFailed?: boolean;
  config?: { ollama: string; lmstudio: string };
  models?: ModelRef[];
  cliOverrides?: Record<'claude' | 'grok', { path: string } | null>;
};

type ProviderSnapshotPatch = Pick<ProviderSnapshot, 'statuses' | 'statusLoadFailed' | 'config' | 'models' | 'cliOverrides'>;

function reconcile(snapshot: ProviderSnapshot, patch: ProviderSnapshotPatch): ProviderSnapshot {
  return { ...snapshot, ...patch };
}

export type SettingsModalDeps = {
  /** Fired after any auth change (sign-in/out, key save/delete) so callers can refresh model caches. */
  onAfterAuthChange?: () => void;
  /** Persist a chosen provider+model selection. */
  onSetCustomModel: (provider: AiProviderId, modelId: string) => void;
};
let cliOnboardingPrompted = false;

/** Opens settings at most once for no-auth AI calls; user-initiated settings remain unrestricted. */
export function triggerCliOnboarding(open: () => void): void {
  if (cliOnboardingPrompted) return;
  cliOnboardingPrompted = true;
  open();
}
export function __resetCliOnboardingPromptForTests(): void {
  cliOnboardingPrompted = false;
}

export type LocalViewContext = {
  config: { ollama: string; lmstudio: string };
  modelCount: (provider: AiProviderId) => number;
};

function localizedProviderStatusError(s: ProviderAuthStatus): string | undefined {
  if (s.errorCode) return t(PROVIDER_STATUS_ERROR_KEYS[s.errorCode]);
  return s.error ? t('settings.prov.error.unknown') : undefined;
}

export function toView(
  s: ProviderAuthStatus,
  local: LocalViewContext,
  cliOverrides?: Record<'claude' | 'grok', { path: string } | null>,
): ProviderStatusView | null {
  if (s.authKind === 'local' && (s.provider === 'ollama' || s.provider === 'lmstudio')) {
    // Local servers are discovery, not auth: render a URL row + run-server hint.
    return {
      provider: s.provider,
      label: s.label,
      authKind: 'local',
      connected: s.connected,
      connectionSource: s.connectionSource,
      error: localizedProviderStatusError(s),
      errorCode: s.errorCode,
      errorDetail: s.error,
      localUrl: s.provider === 'ollama' ? local.config.ollama : local.config.lmstudio,
      localUrlDefault: s.provider === 'ollama' ? DEFAULT_OLLAMA_BASE_URL : DEFAULT_LMSTUDIO_BASE_URL,
      localModelCount: local.modelCount(s.provider),
    };
  }
  if (s.authKind === 'cli') {
    // CLI providers (grok): status + install/login guidance row, no key/URL input.
    return {
      provider: s.provider,
      label: s.label,
      authKind: 'cli',
      connected: s.connected,
      connectionSource: s.connectionSource,
      authUnverified: s.authUnverified,
      installed: s.installed,
      error: localizedProviderStatusError(s),
      errorCode: s.errorCode,
      errorDetail: s.error,
      cliOverridePath: s.provider === 'grok' ? cliOverrides?.grok?.path : undefined,
    };
  }
  if (s.provider !== 'chatgpt' && s.provider !== 'claude' && s.provider !== 'openrouter') return null;
  if (s.authKind !== 'oauth' && s.authKind !== 'api_key') return null;
  return {
    provider: s.provider,
    label: s.label,
    authKind: s.authKind,
    connected: s.connected,
    connectionSource: s.connectionSource,
    accountLabel: s.accountLabel,
    keyLast4: s.keyLast4,
    error: localizedProviderStatusError(s),
    errorCode: s.errorCode,
    errorDetail: s.error,
    // Claude uses the local `claude` CLI first (free); the API key is an optional fallback.
    cliStatus: s.cliStatus,
    hint: s.provider === 'claude' && !s.errorCode ? t('settings.prov.claudeCliHint') : undefined,
    cliOverridePath: s.provider === 'claude' ? cliOverrides?.claude?.path : undefined,
  };
}

export function openSettingsModal(deps: SettingsModalDeps): void {
  if (document.querySelector('.settings-modal-root')) return;

  const root = document.createElement('div');
  root.className = 'settings-modal-root';
  root.innerHTML = `
    <div class="settings-modal" role="dialog" aria-label="${t('settings.title')}">
      <div class="settings-modal-header">
        <div class="settings-modal-title">${t('settings.title')}</div>
        <button class="settings-modal-close" id="settings-close" aria-label="${t('login.close')}">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><line x1="2.5" y1="2.5" x2="9.5" y2="9.5"/><line x1="9.5" y1="2.5" x2="2.5" y2="9.5"/></svg>
        </button>
      </div>
      <div class="settings-modal-body">
        <div class="settings-section" id="settings-providers"></div>
        <div class="settings-section" id="settings-md-handler"></div>
      </div>
    </div>
  `;
  document.body.appendChild(root);

  const provHost = root.querySelector('#settings-providers') as HTMLElement;
  const mdHandlerHost = root.querySelector('#settings-md-handler') as HTMLElement;
  let provHandle: ProviderSettingsHandle | null = null;
  let generation = 0;
  const snapshots = new Map<number, ProviderSnapshot>();

  const viewsFor = (snapshot: ProviderSnapshot): ProviderStatusView[] => {
    if (!snapshot.statuses && !snapshot.statusLoadFailed) {
      return KNOWN_PROVIDER_ROWS.map((row) => ({ ...row, loading: true }));
    }
    if (snapshot.statusLoadFailed) {
      return KNOWN_PROVIDER_ROWS.map((row) => ({ ...row, loading: true }));
    }
    const local: LocalViewContext = {
      config: snapshot.config ?? {
        ollama: DEFAULT_OLLAMA_BASE_URL,
        lmstudio: DEFAULT_LMSTUDIO_BASE_URL,
      },
      modelCount: (provider) => (snapshot.models ?? []).filter((model) => model.provider === provider).length,
    };
    const statusesByProvider = new Map(snapshot.statuses!.map((status) => [status.provider, status]));
    const statusResultWasEmpty = snapshot.statuses!.length === 0;
    return KNOWN_PROVIDER_ROWS.map((row) => {
      const status = statusesByProvider.get(row.provider);
      if (!status) return { ...row, loading: !statusResultWasEmpty };
      return toView(status, local, snapshot.cliOverrides) ?? { ...row, loading: true };
    });
  };

  const patchFromSnapshot = (gen: number, patch: ProviderSnapshotPatch) => {
    if (gen !== generation || !root.isConnected) return;
    const next = reconcile(snapshots.get(gen) ?? {}, patch);
    snapshots.set(gen, next);
    provHandle?.patch({
      statuses: viewsFor(next),
      loadError: next.statusLoadFailed ? t('settings.prov.statusLoadFailed') : undefined,
    });
  };

  const loadProviders = (): Promise<void> => {
    const gen = ++generation;
    snapshots.set(gen, {});
    // Start all IPC reads before registering any completion handler. No resource
    // (especially the model cache refresh) is allowed to delay the skeleton paint.
    let statusRequest: Promise<ProviderAuthStatus[]>;
    let configRequest: Promise<{ ollama: string; lmstudio: string }>;
    let modelsRequest: Promise<ModelRef[]>;
    let cliOverridesRequest: Promise<Record<'claude' | 'grok', { path: string } | null>>;
    try {
      statusRequest = window.api.aiProvidersStatus();
    } catch {
      statusRequest = Promise.reject();
    }
    try {
      configRequest = window.api.localAiGetConfig();
    } catch {
      configRequest = Promise.reject();
    }
    try {
      modelsRequest = window.api.aiModels(true);
    } catch {
      modelsRequest = Promise.reject();
    }
    try {
      cliOverridesRequest = window.api.cliOverrides();
    } catch {
      cliOverridesRequest = Promise.reject();
    }
    const statusDone = statusRequest.then(
      (statuses) => patchFromSnapshot(gen, { statuses, statusLoadFailed: false }),
      () => patchFromSnapshot(gen, { statusLoadFailed: true }),
    );
    void configRequest.then(
      (config) => patchFromSnapshot(gen, { config }),
      () => patchFromSnapshot(gen, {}),
    );
    void modelsRequest.then(
      (models) => patchFromSnapshot(gen, { models }),
      () => patchFromSnapshot(gen, {}),
    );
    void cliOverridesRequest.then(
      (cliOverrides) => patchFromSnapshot(gen, { cliOverrides }),
      () => patchFromSnapshot(gen, {}),
    );
    return statusDone;
  };

  let releaseFocusTrap: (() => void) | null = null;
  const close = () => {
    generation += 1;
    releaseFocusTrap?.();
    releaseFocusTrap = null;
    provHandle?.destroy();
    root.remove();
  };
  root.querySelector('#settings-close')!.addEventListener('click', close);
  root.addEventListener('mousedown', (e) => {
    if (e.target === root) close();
  });
  releaseFocusTrap = trapModalFocus({
    dialog: root.querySelector('.settings-modal') as HTMLElement,
    onEscape: close,
  });

  provHandle = mountProviderSettingsPanel(provHost, {
    statuses: KNOWN_PROVIDER_ROWS.map((row) => ({ ...row, loading: true })),
    onRetryStatus: () => void loadProviders(),
    onChatgptSignIn: () =>
      openLoginModal({
        onAfterLogin: () => {
          deps.onAfterAuthChange?.();
          void loadProviders();
        },
      }),
    onChatgptSignOut: async () => {
      await window.api.authLogout();
      deps.onAfterAuthChange?.();
      await loadProviders();
    },
    onSaveKey: async (provider, key) => {
      await window.api.aiSetApiKey(provider, key);
      deps.onAfterAuthChange?.();
      await loadProviders();
    },
    onDeleteKey: async (provider) => {
      await window.api.aiDeleteProviderKey(provider);
      deps.onAfterAuthChange?.();
      await loadProviders();
    },
    onSetCustomModel: (provider, modelId) => {
      deps.onSetCustomModel(provider, modelId);
      close();
    },
    onSaveLocalUrl: async (provider, url) => {
      try {
        await window.api.localAiSetConfig({ [provider]: url });
      } catch {
        /* invalid URL rejected in main; retain the last confirmed configuration */
      }
      deps.onAfterAuthChange?.();
      await loadProviders();
    },
    onResetLocalUrl: async (provider) => {
      const def = provider === 'ollama' ? DEFAULT_OLLAMA_BASE_URL : DEFAULT_LMSTUDIO_BASE_URL;
      try {
        await window.api.localAiSetConfig({ [provider]: def });
      } catch {
        /* ignore */
      }
      deps.onAfterAuthChange?.();
      await loadProviders();
    },
    onSelectCliOverride: async (provider) => {
      await window.api.cliSelectOverride(provider);
      await loadProviders();
    },
    onClearCliOverride: async (provider) => {
      await window.api.cliClearOverride(provider);
      await loadProviders();
    },
  });
  mountMdHandlerSection(mdHandlerHost);
  void loadProviders();
}

/**
 * "Default .md editor" section (⑥ os-integration, AC9). Reuses the provider-panel
 * title/button/status classes. Registration is user-initiated and idempotent —
 * the button only fires `registerMdHandler` on an explicit click. Unsupported
 * builds (dev / non-darwin) show an explicit unsupported state with the button
 * disabled rather than a silent no-op.
 */
function mountMdHandlerSection(host: HTMLElement) {
  host.innerHTML = `
    <h2 class="prov-title">${t('settings.mdHandler.title')}</h2>
    <p class="md-handler-desc">${t('settings.mdHandler.desc')}</p>
    <div class="md-handler-controls">
      <button class="prov-btn prov-btn-primary" id="md-handler-set" type="button">${t('settings.mdHandler.button')}</button>
      <span class="prov-status" id="md-handler-status"></span>
    </div>
  `;

  const btn = host.querySelector('#md-handler-set') as HTMLButtonElement;
  const statusEl = host.querySelector('#md-handler-status') as HTMLElement;

  const setStatus = (text: string, on: boolean) => {
    statusEl.textContent = text;
    statusEl.classList.toggle('prov-status-on', on);
    statusEl.classList.toggle('prov-status-off', !on);
  };
  const showUnsupported = () => {
    btn.disabled = true;
    setStatus(t('settings.mdHandler.unsupported'), false);
  };
  const showRegistered = () => {
    btn.disabled = true;
    setStatus(t('settings.mdHandler.registered'), true);
  };

  void (async () => {
    try {
      const s = await window.api.mdHandlerStatus();
      if (!s.supported) showUnsupported();
      else if (s.registered) showRegistered();
    } catch {
      showUnsupported();
    }
  })();

  btn.addEventListener('click', () => {
    void (async () => {
      btn.disabled = true;
      try {
        const r = await window.api.registerMdHandler();
        if (r.ok && r.registered) {
          // defaultSet === false → registered but the default couldn't be set
          // automatically; guide the one-time Finder fallback instead.
          if (r.defaultSet === false) {
            setStatus(t('settings.mdHandler.partial'), true);
            btn.disabled = true;
          } else {
            showRegistered();
          }
        } else if (r.error === 'unsupported') {
          showUnsupported();
        } else {
          setStatus(r.error ?? t('settings.mdHandler.unsupported'), false);
          btn.disabled = false;
        }
      } catch {
        setStatus(t('settings.mdHandler.unsupported'), false);
        btn.disabled = false;
      }
    })();
  });
}

