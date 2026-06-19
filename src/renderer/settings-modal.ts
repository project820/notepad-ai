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
import type { AiProviderId, ProviderAuthStatus } from '../main/ai/types';

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

function toView(s: ProviderAuthStatus): ProviderStatusView {
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
      </div>
    </div>
  `;
  document.body.appendChild(root);

  const provHost = root.querySelector('#settings-providers') as HTMLElement;
  const styleHost = root.querySelector('#settings-style') as HTMLElement;
  const typoHost = root.querySelector('#settings-typography') as HTMLElement;
  let provHandle: ProviderSettingsHandle | null = null;
  let styleHandle: StyleSettingHandle | null = null;

  const close = () => {
    provHandle?.destroy();
    styleHandle?.destroy();
    root.remove();
  };
  root.querySelector('#settings-close')!.addEventListener('click', close);
  root.addEventListener('mousedown', (e) => {
    if (e.target === root) close();
  });

  async function renderProviders() {
    provHandle?.destroy();
    let statuses: ProviderAuthStatus[] = [];
    try {
      statuses = await window.api.aiProvidersStatus();
    } catch {
      /* leave empty → panel shows zero-auth notice */
    }
    provHandle = mountProviderSettingsPanel(provHost, {
      statuses: statuses.map(toView),
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
    });
  }

  styleHandle = mountStyleSettingPanel(styleHost, {
    setting: deps.getStyle(),
    onChange: (next) => deps.onStyleChange(next),
  });

  mountTypographySection(typoHost, deps.getTypography, deps.onTypographyChange);

  void renderProviders();
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
