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
import type { AiProviderId, AuthKind, ProviderAuthStatus, ProviderAuthStatusCode } from '../main/ai/types';
import { isProviderAuthAttemptable } from '../shared/provider-auth-status';

export type ProviderStatusView = {
  provider: AiProviderId;
  label: string;
  authKind: AuthKind;
  connected: boolean;
  /** True while this stable provider row is awaiting its status resource. */
  loading?: boolean;
  /** True while a provider-scoped action is in progress. */
  busy?: boolean;
  /** True when authentication cannot be verified but the provider may be usable. */
  authUnverified?: boolean;
  /** CLI providers: whether the executable was found (installation, not auth). */
  installed?: boolean;
  connectionSource?: ProviderAuthStatus['connectionSource'];
  accountLabel?: string;
  keyLast4?: string;
  error?: string;
  /** Stable provider status code retained alongside localized display copy. */
  errorCode?: ProviderAuthStatusCode;
  /** Escaped secondary diagnostic; never replaces localized primary status copy. */
  errorDetail?: string;
  /** Local providers only: current configured base URL. */
  localUrl?: string;
  /** Local providers only: default base URL (drives the reset button). */
  localUrlDefault?: string;
  /** Local providers only: count of discovered models (drives the offline hint). */
  localModelCount?: number;
  /** Optional persistent guidance note shown under the row (e.g. CLI-first usage). */
  hint?: string;
  /** Claude's CLI transport state, distinct from this row's API-key status. */
  cliStatus?: ProviderAuthStatus['cliStatus'];
};

export type ProviderSettingsRenderOptions = {
  statuses: ProviderStatusView[];
  /** The provider-status IPC request failed; distinct from a successful empty response. */
  loadError?: string;
};

export type ProviderSettingsOptions = ProviderSettingsRenderOptions & {
  onChatgptSignIn: () => void;
  onChatgptSignOut: () => Promise<void> | void;
  onSaveKey: (provider: 'claude' | 'openrouter', key: string) => Promise<void> | void;
  onDeleteKey: (provider: 'claude' | 'openrouter') => Promise<void> | void;
  onSetCustomModel: (provider: AiProviderId, modelId: string) => void;
  /** Persist a local provider's server URL (validated localhost in main). */
  onSaveLocalUrl?: (provider: 'ollama' | 'lmstudio', url: string) => Promise<void> | void;
  /** Reset a local provider's server URL to its default. */
  onResetLocalUrl?: (provider: 'ollama' | 'lmstudio') => Promise<void> | void;
  onRetryStatus?: () => void;
};

export type ProviderSettingsHandle = {
  /** Reconciles changed provider slots without replacing the panel root or row elements. */
  patch: (opts: ProviderSettingsRenderOptions) => void;
  /** Marks one row busy while retaining every other row's DOM identity. */
  setRowBusy: (provider: AiProviderId, busy: boolean) => void;
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

function isAttemptableView(s: ProviderStatusView): boolean {
  return isProviderAuthAttemptable(s);
}

function statusLine(s: ProviderStatusView): string {
  if (s.loading) return `<span class="prov-status-skeleton" aria-hidden="true">…</span>`;
  if (s.authKind === 'local') {
    // Local servers are discovery, not auth: only surface a positive "models
    // available" pill. The empty/offline case is handled by the hint line so it
    // never reads as an auth failure.
    if ((s.localModelCount ?? 0) > 0) {
      return `<span class="prov-status prov-status-on">${escapeHTML(t('settings.local.modelsFound'))}</span>`;
    }
    return '';
  }
  if (s.authKind === 'cli' && s.installed === true && s.authUnverified) {
    return `<span class="prov-status prov-status-unknown">${escapeHTML(t('settings.prov.unverified'))}</span>`;
  }
  if (!s.connected) {
    return `<span class="prov-status prov-status-off">${escapeHTML(t('settings.prov.notConnected'))}</span>`;
  }
  const detail =
    s.authKind === 'cli' || s.connectionSource === 'cli'
      ? escapeHTML(t('settings.prov.cliConnected'))
      : s.authKind === 'oauth'
        ? s.accountLabel
          ? escapeHTML(s.accountLabel)
          : escapeHTML(t('settings.prov.signedIn'))
        : s.keyLast4
          ? `${escapeHTML(t('settings.prov.apiKeyLabel'))} ••••${escapeHTML(s.keyLast4)}`
          : escapeHTML(t('settings.prov.keySet'));
  return `<span class="prov-status prov-status-on">${t('settings.prov.connected').replace('{detail}', detail)}</span>`;
}
function cliStatusBadge(s: ProviderStatusView): string {
  const cli = s.cliStatus;
  if (!cli) return '';
  if (!cli.installed) {
    return `<span class="prov-status prov-status-off">${escapeHTML(t('settings.prov.error.claudeCliSetupRequired'))}</span>`;
  }
  const key = cli.authState === 'succeeded'
    ? 'settings.prov.cliBadge.connected'
    : cli.authState === 'auth_failed'
      ? 'settings.prov.cliBadge.loginRequired'
      : 'settings.prov.cliBadge.unknown';
  const tone = cli.authState === 'succeeded' ? 'prov-status-on' : cli.authState === 'auth_failed' ? 'prov-status-off' : 'prov-status-unknown';
  return `<span class="prov-status ${tone}" data-prov-cli-status="${s.provider}">${escapeHTML(t(key))}</span>`;
}

const CLI_ONBOARDING_DISMISSED_KEY = 'notepad-ai:cli-onboarding-dismissed:v1';
const CLI_ONBOARDING_GUIDE_VERSION = 1;

function isCliOnboardingDismissed(provider: AiProviderId): boolean {
  try {
    const raw = localStorage.getItem(CLI_ONBOARDING_DISMISSED_KEY);
    const value = raw ? JSON.parse(raw) : {};
    return value?.[provider] === CLI_ONBOARDING_GUIDE_VERSION;
  } catch {
    return false;
  }
}

function cliOnboardingCard(s: ProviderStatusView): string {
  const needsGuide = s.provider === 'grok'
    ? s.authKind === 'cli' && !isAttemptableView(s)
    : s.provider === 'claude' && !s.connected && s.cliStatus?.authState !== 'succeeded';
  if (!needsGuide || isCliOnboardingDismissed(s.provider)) return '';
  const guide = s.provider === 'grok' ? 'grok' : 'claude';
  return `<div class="prov-onboarding" role="status" aria-live="polite">
    <strong>${escapeHTML(t(`settings.onboarding.${guide}.title`))}</strong>
    <p>${escapeHTML(t(`settings.onboarding.${guide}.steps`))}</p>
    <p>${escapeHTML(t('settings.onboarding.commonNote'))}</p>
    <button class="prov-btn" data-prov-action="dismiss-cli-onboarding" data-prov="${s.provider}" type="button" aria-label="${escapeHTML(t('settings.onboarding.a11y.dismissLabel'))}">${escapeHTML(t(`settings.onboarding.${guide}.dismiss`))}</button>
  </div>`;
}
function dismissCliOnboarding(provider: AiProviderId): void {
  try {
    const raw = localStorage.getItem(CLI_ONBOARDING_DISMISSED_KEY);
    const value = raw ? JSON.parse(raw) : {};
    localStorage.setItem(CLI_ONBOARDING_DISMISSED_KEY, JSON.stringify({
      ...(value && typeof value === 'object' ? value : {}),
      [provider]: CLI_ONBOARDING_GUIDE_VERSION,
    }));
  } catch {
    // Storage may be unavailable; keep the card visible rather than dismissing silently.
  }
}
function providerControls(s: ProviderStatusView): string {
  if (s.loading) return '';
  const disabled = s.busy ? ' disabled' : '';
  if (s.authKind === 'local') {
    const url = s.localUrl ?? s.localUrlDefault ?? '';
    return `
    <input class="prov-url-input" data-prov-url="${s.provider}" type="text"${disabled}
      value="${escapeHTML(url)}" placeholder="${escapeHTML(s.localUrlDefault ?? '')}"
      aria-label="${escapeHTML(s.label)} ${escapeHTML(t('settings.local.urlLabel'))}" />
    <button class="prov-btn prov-btn-primary" data-prov-action="save-url" data-prov="${s.provider}" type="button"${disabled}>${escapeHTML(t('settings.local.save'))}</button>
    <button class="prov-btn" data-prov-action="reset-url" data-prov="${s.provider}" type="button"${disabled}>${escapeHTML(t('settings.local.reset'))}</button>`;
  }
  if (s.authKind === 'oauth') {
    return s.connected
      ? `<button class="prov-btn" data-prov-action="signout" type="button"${disabled}>${escapeHTML(t('settings.prov.signOut'))}</button>`
      : `<button class="prov-btn prov-btn-primary" data-prov-action="signin" type="button"${disabled}>${escapeHTML(t('settings.prov.signIn'))}</button>`;
  }
  if (s.authKind === 'cli') {
    // CLI providers (grok) have no key/URL to configure — they use the local
    // subscription CLI. Guidance is shown via the error line + cliHint footer.
    return '';
  }
  // API-key providers (claude, openrouter)
  return `
    <input class="prov-key-input" data-prov-key="${s.provider}" type="password"${disabled}
      placeholder="${escapeHTML(t('settings.prov.apiKeyPlaceholder'))}" aria-label="${escapeHTML(`${s.label} ${t('settings.prov.apiKeyLabel')}`)}" />
    <button class="prov-btn prov-btn-primary" data-prov-action="save-key" data-prov="${s.provider}" type="button"${disabled}>${escapeHTML(t('settings.prov.saveKey'))}</button>
    <button class="prov-btn" data-prov-action="delete-key" data-prov="${s.provider}" type="button"${s.connected && !s.busy ? '' : ' disabled'}>${escapeHTML(t('settings.prov.removeKey'))}</button>`;
}
/** Local provider footer: a friendly, non-auth hint (offline → run-server guidance). */
function localHint(s: ProviderStatusView): string {
  const msg = (s.localModelCount ?? 0) > 0 ? t('settings.local.hint') : t('settings.local.noModels');
  return `<div class="prov-local-note">${escapeHTML(msg)}</div>`;
}

/** CLI provider footer: a no-key/no-URL hint pointing at the local subscription CLI. */
function cliHint(s: ProviderStatusView): string {
  if (!s.connected && s.error) return '';
  const msg = s.connected
    ? t('settings.prov.cliConnectedHint')
    : t('settings.prov.cliDisconnectedHint');
  return `<div class="prov-local-note">${escapeHTML(msg)}</div>`;
}

/** Cloud provider footer: a custom model-ID input (mitigates catalog staleness). */
function customModelControl(s: ProviderStatusView): string {
  if (s.loading) return '';
  const disabled = s.busy ? ' disabled' : '';
  return `<div class="prov-custom">
      <input class="prov-custom-input" data-prov-custom="${s.provider}" type="text"${disabled}
        placeholder="${escapeHTML(t('settings.prov.customModelPlaceholder'))}" aria-label="${escapeHTML(`${s.label} ${t('settings.prov.customModelLabel')}`)}" />
      <button class="prov-btn" data-prov-action="set-custom" data-prov="${s.provider}" type="button"${disabled}>${escapeHTML(t('settings.prov.useModel'))}</button>
    </div>`;
}
function renderPanelNotice(opts: ProviderSettingsRenderOptions): string {
  const statuses = opts.statuses ?? [];
  if (opts.loadError) {
    return `<div class="prov-load-error" role="alert">${escapeHTML(opts.loadError)} <button class="prov-btn" data-prov-action="retry-status" type="button">${escapeHTML(t('settings.prov.retry'))}</button></div>`;
  }
  const loadedStatuses = statuses.filter((status) => !status.loading);
  // While skeleton rows are still loading, suppress the notice to avoid a
  // zero-auth flash; an entirely empty status list keeps the legacy warning.
  if (statuses.length > 0 && loadedStatuses.length === 0) return '';
  // The onboarding notice tracks usable cloud auth and discovered local models —
  // local providers report a static `connected: true`, so they alone must not
  // silence the cloud sign-in nudge, but a working local server (models found)
  // should.
  const anyCloudUsable = loadedStatuses.some((s) => s.authKind !== 'local' && isAttemptableView(s));
  const anyLocalModels = loadedStatuses.some((s) => s.authKind === 'local' && (s.localModelCount ?? 0) > 0);
  return anyCloudUsable || anyLocalModels
    ? ''
    : `<div class="prov-zero-auth" role="alert">${escapeHTML(t('settings.prov.zeroAuth'))}</div>`;
}
function renderProviderRowContent(s: ProviderStatusView): string {
  if (s.loading) {
    return `<div class="prov-row-head">
      <span class="prov-label">${escapeHTML(s.label)}</span>
      ${statusLine(s)}
    </div>`;
  }
  const isLocal = s.authKind === 'local';
  const footer = isLocal ? localHint(s) : s.authKind === 'cli' ? cliHint(s) : customModelControl(s);
  return `<div class="prov-row-head">
      <span class="prov-label">${escapeHTML(s.label)}</span>
      ${statusLine(s)}
      ${cliStatusBadge(s)}
      ${s.busy ? '<span class="prov-row-spinner" role="status" aria-live="polite">…</span>' : ''}
    </div>
    ${s.error ? `<div class="prov-error" role="alert">${escapeHTML(s.error)}</div>` : ''}
    ${s.errorDetail ? `<div class="prov-error-detail">${escapeHTML(s.errorDetail)}</div>` : ''}
    <div class="prov-controls">${providerControls(s)}</div>
    ${s.hint ? `<div class="prov-local-note">${escapeHTML(s.hint)}</div>` : ''}
    ${footer}
    ${cliOnboardingCard(s)}`;
}
function renderProviderRow(s: ProviderStatusView): string {
  return `<section class="prov-row" data-prov-row="${s.provider}" aria-busy="${s.loading || s.busy ? 'true' : 'false'}">
    ${renderProviderRowContent(s)}
  </section>`;
}
export function renderProviderSettingsPanel(opts: ProviderSettingsRenderOptions): string {
  const rows = (opts.statuses ?? []).map(renderProviderRow).join('\n');
  return `<div class="prov-root">
  <h2 class="prov-title">${escapeHTML(t('settings.prov.title'))}</h2>
  ${renderPanelNotice(opts)}
  ${rows}
</div>`;
}
type FocusSnapshot = {
  selector: string;
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
};
function captureFocus(parent: HTMLElement): FocusSnapshot | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLInputElement) || !parent.contains(active)) return null;
  for (const attr of ['data-prov-key', 'data-prov-url', 'data-prov-custom']) {
    const value = active.getAttribute(attr);
    if (value !== null) {
      return {
        selector: `input[${attr}="${value}"]`,
        value: active.value,
        selectionStart: active.selectionStart,
        selectionEnd: active.selectionEnd,
      };
    }
  }
  return null;
}
function restoreFocus(parent: HTMLElement, saved: FocusSnapshot | null) {
  if (!saved) return;
  const input = parent.querySelector<HTMLInputElement>(saved.selector);
  if (!input || input.disabled) return;
  input.value = saved.value;
  input.focus();
  if (saved.selectionStart !== null && saved.selectionEnd !== null) {
    input.setSelectionRange(saved.selectionStart, saved.selectionEnd);
  }
}
export function mountProviderSettingsPanel(
  parent: HTMLElement,
  opts: ProviderSettingsOptions,
): ProviderSettingsHandle {
  let current: ProviderSettingsRenderOptions = { statuses: opts.statuses ?? [], loadError: opts.loadError };
  const busyProviders = new Set<AiProviderId>();
  parent.innerHTML = renderProviderSettingsPanel(current);
  let renderedNotice = renderPanelNotice(current);
  const effective = (view: ProviderStatusView): ProviderStatusView => ({
    ...view,
    busy: busyProviders.has(view.provider),
  });
  const patchRows = (providers?: ReadonlySet<AiProviderId>) => {
    const saved = captureFocus(parent);
    const root = parent.querySelector<HTMLElement>('.prov-root');
    if (!root) return;
    for (const view of current.statuses) {
      if (providers && !providers.has(view.provider)) continue;
      const next = effective(view);
      const row = root.querySelector<HTMLElement>(`[data-prov-row="${view.provider}"]`);
      if (!row) {
        root.insertAdjacentHTML('beforeend', renderProviderRow(next));
        continue;
      }
      const content = renderProviderRowContent(next);
      const busy = next.loading || next.busy ? 'true' : 'false';
      if (row.innerHTML.trim() !== content.trim()) row.innerHTML = content;
      if (row.getAttribute('aria-busy') !== busy) row.setAttribute('aria-busy', busy);
    }
    restoreFocus(parent, saved);
  };
  const patch = (next: ProviderSettingsRenderOptions) => {
    current = { statuses: next.statuses ?? [], loadError: next.loadError };
    const saved = captureFocus(parent);
    const root = parent.querySelector<HTMLElement>('.prov-root');
    if (!root) return;
    const notice = renderPanelNotice(current);
    if (notice !== renderedNotice) {
      root.querySelector('.prov-load-error, .prov-zero-auth')?.remove();
      if (notice) root.querySelector('.prov-title')?.insertAdjacentHTML('afterend', notice);
      renderedNotice = notice;
    }
    patchRows();
    restoreFocus(parent, saved);
  };
  const setRowBusy = (provider: AiProviderId, busy: boolean) => {
    if (busy) busyProviders.add(provider);
    else busyProviders.delete(provider);
    patchRows(new Set([provider]));
  };
  const runRowAction = (provider: AiProviderId, action: () => Promise<void> | void) => {
    setRowBusy(provider, true);
    let result: Promise<void> | void;
    try {
      result = action();
    } catch {
      setRowBusy(provider, false);
      return;
    }
    void Promise.resolve(result)
      .catch(() => undefined)
      .finally(() => setRowBusy(provider, false));
  };
  const onClick = (e: Event) => {
    const btn = (e.target as HTMLElement).closest('button[data-prov-action]') as HTMLButtonElement | null;
    if (!btn || btn.disabled) return;
    const action = btn.dataset.provAction;
    const prov = (btn.dataset.prov ?? btn.closest<HTMLElement>('[data-prov-row]')?.dataset.provRow) as AiProviderId | undefined;
    if (action === 'retry-status') return opts.onRetryStatus?.();
    if (action === 'dismiss-cli-onboarding' && prov) {
      dismissCliOnboarding(prov);
      patchRows(new Set([prov]));
      return;
    }
    if (action === 'signin') return opts.onChatgptSignIn();
    if (action === 'signout' && prov === 'chatgpt') return runRowAction(prov, opts.onChatgptSignOut);
    if (action === 'save-key' && (prov === 'claude' || prov === 'openrouter')) {
      const input = parent.querySelector<HTMLInputElement>(`input[data-prov-key="${prov}"]`);
      const key = input?.value.trim() ?? '';
      if (!key || !input) return;
      setRowBusy(prov, true);
      void Promise.resolve(opts.onSaveKey(prov, key))
        .then(() => {
          input.value = '';
        })
        .catch(() => {
          const row = parent.querySelector<HTMLElement>(`[data-prov-row="${prov}"]`);
          row?.querySelector('.prov-error[data-prov-save-error]')?.remove();
          const error = document.createElement('div');
          error.className = 'prov-error';
          error.dataset.provSaveError = '';
          error.setAttribute('role', 'alert');
          error.textContent = t('settings.prov.saveKeyFailed');
          row?.querySelector('.prov-row-head')?.insertAdjacentElement('afterend', error);
        })
        .finally(() => setRowBusy(prov, false));
      return;
    }
    if (action === 'delete-key' && (prov === 'claude' || prov === 'openrouter')) {
      return runRowAction(prov, () => opts.onDeleteKey(prov));
    }
    if (action === 'save-url' && (prov === 'ollama' || prov === 'lmstudio')) {
      const input = parent.querySelector<HTMLInputElement>(`input[data-prov-url="${prov}"]`);
      const url = input?.value.trim() ?? '';
      if (url) return runRowAction(prov, () => opts.onSaveLocalUrl?.(prov, url));
      return;
    }
    if (action === 'reset-url' && (prov === 'ollama' || prov === 'lmstudio')) {
      return runRowAction(prov, () => opts.onResetLocalUrl?.(prov));
    }
    if (action === 'set-custom' && prov) {
      const input = parent.querySelector<HTMLInputElement>(`input[data-prov-custom="${prov}"]`);
      const id = input?.value.trim() ?? '';
      if (id) opts.onSetCustomModel(prov, id);
    }
  };
  parent.addEventListener('click', onClick);
  return {
    patch,
    setRowBusy,
    destroy: () => {
      parent.removeEventListener('click', onClick);
      parent.innerHTML = '';
    },
  };
}
