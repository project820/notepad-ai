/**
 * provider-settings-panel.ts — multi-provider AI settings UI (G001 renderer,
 * extended for G003 local providers).
 *
 * Follows a pure-render / DOM-mount split:
 *   - `renderProviderSettingsPanel(opts)` — pure, no DOM, returns HTML string
 *     (testable in Node).
 *   - `mountProviderSettingsPanel(parent, opts)` — DOM-dependent, wires actions.
 *
 * Surfaces:
 *   - Cloud providers (ChatGPT sign-in, Claude / OpenRouter API key) with a
 *     per-provider connected/last-4 status and a custom model-ID input.
 *   - Local providers (Ollama / LM Studio, `authKind: 'local'`) with a server
 *     URL input + save/reset instead of an API key. Local servers are discovery,
 *     not auth: an offline server is shown as a friendly "no models found" hint,
 *     never an auth error.
 *   - A zero-auth onboarding notice when no cloud provider is connected and no
 *     local models are discovered (AC23).
 *
 * Secrets are never rendered — only the last 4 chars of a saved key are shown.
 */

import { t } from './i18n';
import type { AiProviderId, AuthKind } from '../main/ai/types';

export type ProviderStatusView = {
  provider: AiProviderId;
  label: string;
  authKind: AuthKind;
  connected: boolean;
  accountLabel?: string;
  keyLast4?: string;
  error?: string;
  /** Local providers only: current configured base URL. */
  localUrl?: string;
  /** Local providers only: default base URL (drives the reset button). */
  localUrlDefault?: string;
  /** Local providers only: count of discovered models (drives the offline hint). */
  localModelCount?: number;
  /** Optional persistent guidance note shown under the row (e.g. CLI-first usage). */
  hint?: string;
};

export type ProviderSettingsRenderOptions = {
  statuses: ProviderStatusView[];
};

export type ProviderSettingsOptions = ProviderSettingsRenderOptions & {
  onChatgptSignIn: () => void;
  onChatgptSignOut: () => void;
  onSaveKey: (provider: 'claude' | 'openrouter', key: string) => Promise<void> | void;
  onDeleteKey: (provider: 'claude' | 'openrouter') => void;
  onSetCustomModel: (provider: AiProviderId, modelId: string) => void;
  /** Persist a local provider's server URL (validated localhost in main). */
  onSaveLocalUrl?: (provider: 'ollama' | 'lmstudio', url: string) => void;
  /** Reset a local provider's server URL to its default. */
  onResetLocalUrl?: (provider: 'ollama' | 'lmstudio') => void;
};

export type ProviderSettingsHandle = {
  destroy: () => void;
};

function escapeHTML(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function statusLine(s: ProviderStatusView): string {
  if (s.authKind === 'local') {
    // Local servers are discovery, not auth: only surface a positive "models
    // available" pill. The empty/offline case is handled by the hint line so it
    // never reads as an auth failure.
    if ((s.localModelCount ?? 0) > 0) {
      return `<span class="prov-status prov-status-on">${escapeHTML(t('settings.local.modelsFound'))}</span>`;
    }
    return '';
  }
  if (!s.connected) return '<span class="prov-status prov-status-off">Not connected</span>';
  const detail =
    s.authKind === 'cli'
      ? 'CLI'
      : s.authKind === 'oauth'
      ? s.accountLabel
        ? escapeHTML(s.accountLabel)
        : 'Signed in'
      : s.keyLast4
        ? `Key ••••${escapeHTML(s.keyLast4)}`
        : 'Key set';
  return `<span class="prov-status prov-status-on">Connected · ${detail}</span>`;
}

function providerControls(s: ProviderStatusView): string {
  if (s.authKind === 'local') {
    const url = s.localUrl ?? s.localUrlDefault ?? '';
    return `
    <input class="prov-url-input" data-prov-url="${s.provider}" type="text"
      value="${escapeHTML(url)}" placeholder="${escapeHTML(s.localUrlDefault ?? '')}"
      aria-label="${escapeHTML(s.label)} ${escapeHTML(t('settings.local.urlLabel'))}" />
    <button class="prov-btn prov-btn-primary" data-prov-action="save-url" data-prov="${s.provider}" type="button">${escapeHTML(t('settings.local.save'))}</button>
    <button class="prov-btn" data-prov-action="reset-url" data-prov="${s.provider}" type="button">${escapeHTML(t('settings.local.reset'))}</button>`;
  }
  if (s.authKind === 'oauth') {
    return s.connected
      ? `<button class="prov-btn" data-prov-action="signout" type="button">Sign out</button>`
      : `<button class="prov-btn prov-btn-primary" data-prov-action="signin" type="button">Sign in</button>`;
  }
  if (s.authKind === 'cli') {
    // CLI providers (grok) have no key/URL to configure — they use the local
    // subscription CLI. Guidance is shown via the error line + cliHint footer.
    return '';
  }
  // API-key providers (claude, openrouter)
  return `
    <input class="prov-key-input" data-prov-key="${s.provider}" type="password"
      placeholder="Paste API key" aria-label="${escapeHTML(s.label)} API key" />
    <button class="prov-btn prov-btn-primary" data-prov-action="save-key" data-prov="${s.provider}" type="button">Save key</button>
    <button class="prov-btn" data-prov-action="delete-key" data-prov="${s.provider}" type="button"${s.connected ? '' : ' disabled'}>Remove</button>`;
}

/** Local provider footer: a friendly, non-auth hint (offline → run-server guidance). */
function localHint(s: ProviderStatusView): string {
  const msg = (s.localModelCount ?? 0) > 0 ? t('settings.local.hint') : t('settings.local.noModels');
  return `<div class="prov-local-note">${escapeHTML(msg)}</div>`;
}

/** CLI provider footer: a no-key/no-URL hint pointing at the local subscription CLI. */
function cliHint(s: ProviderStatusView): string {
  const msg = s.connected
    ? 'Using your local CLI — no API key, no per-request billing.'
    : 'Install the CLI and sign in (e.g. `grok login`) to use this provider — no API key needed.';
  return `<div class="prov-local-note">${escapeHTML(msg)}</div>`;
}

/** Cloud provider footer: a custom model-ID input (mitigates catalog staleness). */
function customModelControl(s: ProviderStatusView): string {
  return `<div class="prov-custom">
      <input class="prov-custom-input" data-prov-custom="${s.provider}" type="text"
        placeholder="Custom model ID (optional)" aria-label="${escapeHTML(s.label)} custom model id" />
      <button class="prov-btn" data-prov-action="set-custom" data-prov="${s.provider}" type="button">Use model</button>
    </div>`;
}

export function renderProviderSettingsPanel(opts: ProviderSettingsRenderOptions): string {
  const statuses = opts.statuses ?? [];
  // The onboarding notice tracks cloud auth and discovered local models — local
  // providers report a static `connected: true`, so they alone must not silence
  // the cloud sign-in nudge, but a working local server (models found) should.
  const anyCloudConnected = statuses.some((s) => s.authKind !== 'local' && s.connected);
  const anyLocalModels = statuses.some((s) => s.authKind === 'local' && (s.localModelCount ?? 0) > 0);
  const anyUsable = anyCloudConnected || anyLocalModels;

  const zeroAuthNotice = anyUsable
    ? ''
    : `<div class="prov-zero-auth" role="alert">No AI provider connected. Connect at least one below to use AI features.</div>`;

  const rows = statuses
    .map((s) => {
      const isLocal = s.authKind === 'local';
      const footer = isLocal ? localHint(s) : s.authKind === 'cli' ? cliHint(s) : customModelControl(s);
      return `<section class="prov-row" data-prov-row="${s.provider}">
    <div class="prov-row-head">
      <span class="prov-label">${escapeHTML(s.label)}</span>
      ${statusLine(s)}
    </div>
    ${s.error ? `<div class="prov-error" role="alert">${escapeHTML(s.error)}</div>` : ''}
    <div class="prov-controls">${providerControls(s)}</div>
    ${s.hint ? `<div class="prov-local-note">${escapeHTML(s.hint)}</div>` : ''}
    ${footer}
  </section>`;
    })
    .join('\n');

  return `<div class="prov-root">
  <h2 class="prov-title">AI providers</h2>
  ${zeroAuthNotice}
  ${rows}
</div>`;
}

export function mountProviderSettingsPanel(
  parent: HTMLElement,
  opts: ProviderSettingsOptions,
): ProviderSettingsHandle {
  parent.innerHTML = renderProviderSettingsPanel(opts);

  const onClick = (e: Event) => {
    const btn = (e.target as HTMLElement).closest('button[data-prov-action]') as HTMLButtonElement | null;
    if (!btn) return;
    const action = btn.dataset.provAction;
    const prov = btn.dataset.prov as AiProviderId | undefined;
    if (action === 'signin') return opts.onChatgptSignIn();
    if (action === 'signout') return opts.onChatgptSignOut();
    if (action === 'save-key' && (prov === 'claude' || prov === 'openrouter')) {
      const input = parent.querySelector<HTMLInputElement>(`input[data-prov-key="${prov}"]`);
      const key = input?.value.trim() ?? '';
      if (!key || !input) return;
      void Promise.resolve(opts.onSaveKey(prov, key))
        .then(() => {
          input.value = '';
        })
        .catch(() => {
          const row = input.closest<HTMLElement>('[data-prov-row]');
          row?.querySelector('.prov-error[data-prov-save-error]')?.remove();
          const error = document.createElement('div');
          error.className = 'prov-error';
          error.dataset.provSaveError = '';
          error.setAttribute('role', 'alert');
          error.textContent = 'Unable to save API key. Try again.';
          row?.querySelector('.prov-row-head')?.insertAdjacentElement('afterend', error);
        });
      return;
    }
    if (action === 'delete-key' && (prov === 'claude' || prov === 'openrouter')) {
      return opts.onDeleteKey(prov);
    }
    if (action === 'save-url' && (prov === 'ollama' || prov === 'lmstudio')) {
      const input = parent.querySelector<HTMLInputElement>(`input[data-prov-url="${prov}"]`);
      const url = input?.value.trim() ?? '';
      if (url) opts.onSaveLocalUrl?.(prov, url);
      return;
    }
    if (action === 'reset-url' && (prov === 'ollama' || prov === 'lmstudio')) {
      return opts.onResetLocalUrl?.(prov);
    }
    if (action === 'set-custom' && prov) {
      const input = parent.querySelector<HTMLInputElement>(`input[data-prov-custom="${prov}"]`);
      const id = input?.value.trim() ?? '';
      if (id) opts.onSetCustomModel(prov, id);
      return;
    }
  };

  parent.addEventListener('click', onClick);

  return {
    destroy: () => {
      parent.removeEventListener('click', onClick);
      parent.innerHTML = '';
    },
  };
}
