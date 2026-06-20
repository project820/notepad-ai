/**
 * settings-modal.ts — the AI settings overlay (G001/G004 renderer).
 *
 * Hosts the multi-provider settings panel (sign-in / API keys / custom model
 * ID / zero-auth notice / actionable errors — AC22/23/24) and the unified
 * Style panel (difficulty + always-on humanize naturalness — AC16). All IPC and
 * prefs side effects are injected so the panels stay DOM-testable in isolation.
 */

import { mountProviderSettingsPanel, type ProviderSettingsHandle, type ProviderStatusView } from './provider-settings-panel';
import { mountStyleSettingPanel, type StyleSettingHandle } from './style-setting-panel';
import { openLoginModal } from './login-modal';
import type { StyleSetting } from './humanize-engine';
import { stepTypography, type TypographyPref } from './typography';
import { t } from './i18n';
import type { AiProviderId, ModelRef, ProviderAuthStatus } from '../main/ai/types';
import { trapModalFocus } from './modal-a11y';

// Default local server URLs. Mirrors src/main/ai/local-config.ts but defined
// here so the renderer never imports the Electron-bound local-config module
// (which uses `require('electron')`). Ollama / LM Studio use fixed default ports.
const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_LMSTUDIO_BASE_URL = 'http://127.0.0.1:1234';

export type SettingsModalDeps = {
  getStyle: () => StyleSetting;
  onStyleChange: (next: StyleSetting) => void;
  /** Fired after any auth change (sign-in/out, key save/delete) so callers can refresh model caches. */
  onAfterAuthChange?: () => void;
  /** Persist a chosen provider+model selection. */
  onSetCustomModel: (provider: AiProviderId, modelId: string) => void;
  /** Typography (display) view-settings. */
  getTypography: () => TypographyPref;
  onTypographyChange: (next: TypographyPref) => void;
};

type LocalViewContext = {
  config: { ollama: string; lmstudio: string };
  modelCount: (provider: AiProviderId) => number;
};

function toView(s: ProviderAuthStatus, local: LocalViewContext): ProviderStatusView | null {
  if (s.authKind === 'local' && (s.provider === 'ollama' || s.provider === 'lmstudio')) {
    // Local servers are discovery, not auth: render a URL row + run-server hint.
    return {
      provider: s.provider,
      label: s.label,
      authKind: 'local',
      connected: s.connected,
      error: s.error,
      localUrl: s.provider === 'ollama' ? local.config.ollama : local.config.lmstudio,
      localUrlDefault: s.provider === 'ollama' ? DEFAULT_OLLAMA_BASE_URL : DEFAULT_LMSTUDIO_BASE_URL,
      localModelCount: local.modelCount(s.provider),
    };
  }
  if (s.provider !== 'chatgpt' && s.provider !== 'claude' && s.provider !== 'openrouter') return null;
  if (s.authKind !== 'oauth' && s.authKind !== 'api_key') return null;
  return {
    provider: s.provider,
    label: s.label,
    authKind: s.authKind,
    connected: s.connected,
    accountLabel: s.accountLabel,
    keyLast4: s.keyLast4,
    error: s.error,
  };
}

export function openSettingsModal(deps: SettingsModalDeps): void {
  if (document.querySelector('.settings-modal-root')) return;

  const root = document.createElement('div');
  root.className = 'settings-modal-root';
  root.innerHTML = `
    <div class="settings-modal" role="dialog" aria-label="Settings">
      <div class="settings-modal-header">
        <div class="settings-modal-title">${t('settings.title')}</div>
        <button class="settings-modal-close" id="settings-close" aria-label="Close">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><line x1="2.5" y1="2.5" x2="9.5" y2="9.5"/><line x1="9.5" y1="2.5" x2="2.5" y2="9.5"/></svg>
        </button>
      </div>
      <div class="settings-modal-body">
        <div class="settings-section" id="settings-providers"></div>
        <div class="settings-section" id="settings-style"></div>
        <div class="settings-section" id="settings-typography"></div>
        <div class="settings-section" id="settings-md-handler"></div>
      </div>
    </div>
  `;
  document.body.appendChild(root);

  const provHost = root.querySelector('#settings-providers') as HTMLElement;
  const styleHost = root.querySelector('#settings-style') as HTMLElement;
  const typoHost = root.querySelector('#settings-typography') as HTMLElement;
  const mdHandlerHost = root.querySelector('#settings-md-handler') as HTMLElement;
  let provHandle: ProviderSettingsHandle | null = null;
  let styleHandle: StyleSettingHandle | null = null;

  let releaseFocusTrap: (() => void) | null = null;
  const close = () => {
    releaseFocusTrap?.();
    releaseFocusTrap = null;
    provHandle?.destroy();
    styleHandle?.destroy();
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

  async function renderProviders() {
    provHandle?.destroy();
    let statuses: ProviderAuthStatus[] = [];
    let localConfig: { ollama: string; lmstudio: string } = {
      ollama: DEFAULT_OLLAMA_BASE_URL,
      lmstudio: DEFAULT_LMSTUDIO_BASE_URL,
    };
    let models: ModelRef[] = [];
    try {
      statuses = await window.api.aiProvidersStatus();
    } catch {
      /* leave empty → panel shows zero-auth notice */
    }
    try {
      localConfig = await window.api.localAiGetConfig();
    } catch {
      /* keep default localhost URLs */
    }
    try {
      // Snapshot for per-provider model counts + a background refresh kick so a
      // freshly started local server appears on the next settings open. Never
      // blocks: the registry returns the current cache snapshot immediately.
      models = await window.api.aiModels(true);
    } catch {
      /* no counts → local rows show the run-server hint */
    }
    const local: LocalViewContext = {
      config: localConfig,
      modelCount: (provider) => models.filter((m) => m.provider === provider).length,
    };
    provHandle = mountProviderSettingsPanel(provHost, {
      statuses: statuses.map((s) => toView(s, local)).filter((v): v is ProviderStatusView => v !== null),
      onChatgptSignIn: () =>
        openLoginModal({
          onAfterLogin: () => {
            deps.onAfterAuthChange?.();
            void renderProviders();
          },
        }),
      onChatgptSignOut: async () => {
        await window.api.authLogout();
        deps.onAfterAuthChange?.();
        void renderProviders();
      },
      onSaveKey: async (provider, key) => {
        try {
          await window.api.aiSetApiKey(provider, key);
        } catch {
          /* error surfaces via providers-status on next render */
        }
        deps.onAfterAuthChange?.();
        void renderProviders();
      },
      onDeleteKey: async (provider) => {
        await window.api.aiDeleteProviderKey(provider);
        deps.onAfterAuthChange?.();
        void renderProviders();
      },
      onSetCustomModel: (provider, modelId) => {
        deps.onSetCustomModel(provider, modelId);
        close();
      },
      onSaveLocalUrl: async (provider, url) => {
        try {
          await window.api.localAiSetConfig({ [provider]: url });
        } catch {
          /* invalid URL rejected in main; re-render keeps the prior value */
        }
        deps.onAfterAuthChange?.();
        void renderProviders();
      },
      onResetLocalUrl: async (provider) => {
        const def = provider === 'ollama' ? DEFAULT_OLLAMA_BASE_URL : DEFAULT_LMSTUDIO_BASE_URL;
        try {
          await window.api.localAiSetConfig({ [provider]: def });
        } catch {
          /* ignore */
        }
        deps.onAfterAuthChange?.();
        void renderProviders();
      },
    });
  }

  styleHandle = mountStyleSettingPanel(styleHost, {
    setting: deps.getStyle(),
    onChange: (next) => deps.onStyleChange(next),
  });

  mountTypographySection(typoHost, deps.getTypography, deps.onTypographyChange);
  mountMdHandlerSection(mdHandlerHost);

  void renderProviders();
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
          showRegistered();
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

function mountTypographySection(
  host: HTMLElement,
  getTypography: () => TypographyPref,
  onChange: (next: TypographyPref) => void,
) {
  const rows: { key: keyof TypographyPref; label: string; fmt: (v: number) => string }[] = [
    { key: 'letterSpacing', label: t('type.letterSpacing'), fmt: (v) => `${v}px` },
    { key: 'charScaleX', label: t('type.charWidth'), fmt: (v) => `${Math.round(v * 100)}%` },
    { key: 'lineHeight', label: t('type.lineHeight'), fmt: (v) => `${v.toFixed(1)}×` },
  ];

  host.innerHTML =
    `<h2 class="prov-title">${t('type.title')}</h2>` +
    rows
      .map(
        (r) => `<div class="typo-row" data-axis="${r.key}">
      <span class="typo-label">${r.label}</span>
      <div class="typo-stepper">
        <button class="typo-btn" data-dir="-1" type="button" aria-label="−">−</button>
        <span class="typo-value" data-axis-value="${r.key}"></span>
        <button class="typo-btn" data-dir="1" type="button" aria-label="+">+</button>
      </div>
    </div>`,
      )
      .join('');

  const paint = () => {
    const cur = getTypography();
    for (const r of rows) {
      const el = host.querySelector<HTMLElement>(`[data-axis-value="${r.key}"]`);
      if (el) el.textContent = r.fmt(cur[r.key]);
    }
  };
  paint();

  host.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.typo-btn');
    if (!btn) return;
    const row = btn.closest<HTMLElement>('.typo-row');
    const axis = row?.dataset.axis as keyof TypographyPref | undefined;
    if (!axis) return;
    const dir = Number(btn.dataset.dir) === 1 ? 1 : -1;
    const next = stepTypography(getTypography(), axis, dir);
    onChange(next);
    paint();
  });
}
