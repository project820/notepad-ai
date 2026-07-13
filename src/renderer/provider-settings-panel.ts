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
 *   - Cloud providers (ChatGPT, Claude, Grok) with account sign-in controls.
 *   - The Ollama local provider with a server URL input + save/reset controls.
 *   - A zero-auth notice when no cloud provider is connected and no local
 *     models are discovered.
 */

import { t } from './i18n';
import type { AiProviderId, AuthKind, ProviderAuthStatus, ProviderAuthStatusCode } from '../main/ai/types';
import { isProviderAuthAttemptable } from '../shared/provider-auth-status';
import type { SubscriptionLoginUpdate } from '../shared/auth-protocol';

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
  /** CLI transport state used to reflect subscription sign-in status. */
  cliStatus?: ProviderAuthStatus['cliStatus'];
  /** Local providers only: count of discovered models (drives the offline hint). */
  localModelCount?: number;
  /** Ephemeral progress for an in-app subscription CLI login. */
  loginUpdate?: SubscriptionLoginUpdate;
};

export type ProviderSettingsRenderOptions = {
  statuses: ProviderStatusView[];
  /** The provider-status IPC request failed; distinct from a successful empty response. */
  loadError?: string;
};

export type ProviderSettingsOptions = ProviderSettingsRenderOptions & {
  onChatgptSignIn: () => void;
  onChatgptSignOut: () => Promise<void> | void;
  /** Persist Ollama's server URL (validated localhost in main). */
  onSaveLocalUrl?: (provider: 'ollama', url: string) => Promise<void> | void;
  /** Reset Ollama's server URL to its default. */
  onResetLocalUrl?: (provider: 'ollama') => Promise<void> | void;
  onRetryStatus?: () => void;
  onSubscriptionLogin?: (provider: 'claude' | 'grok') => Promise<void> | void;
  onSubscriptionLogout?: (provider: 'claude' | 'grok') => Promise<void> | void;
  onSubscriptionCode?: (provider: 'claude', code: string) => Promise<void> | void;
  onSubscriptionCancel?: (provider: 'claude' | 'grok') => Promise<void> | void;
};

export type ProviderSettingsHandle = {
  /** Reconciles changed provider slots without replacing the panel root or row elements. */
  patch: (opts: ProviderSettingsRenderOptions) => void;
  /** Marks one row busy while retaining every other row's DOM identity. */
  setRowBusy: (provider: AiProviderId, busy: boolean) => void;
  setSubscriptionProgress: (update: SubscriptionLoginUpdate) => void;
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
  const subscriptionConnected = s.cliStatus?.authState === 'succeeded';
  if (!s.connected && !subscriptionConnected) {
    return `<span class="prov-status prov-status-off">${escapeHTML(t('settings.prov.notConnected'))}</span>`;
  }
  const detail =
    s.connectionSource === 'cli' || subscriptionConnected
      ? escapeHTML(t('settings.prov.cliConnected'))
      : s.authKind === 'oauth'
        ? s.accountLabel
          ? escapeHTML(s.accountLabel)
          : escapeHTML(t('settings.prov.signedIn'))
        : s.provider === 'claude' || s.provider === 'grok'
          ? escapeHTML(t('settings.prov.signedIn'))
        : s.keyLast4
          ? `${escapeHTML(t('settings.prov.apiKeyLabel'))} ••••${escapeHTML(s.keyLast4)}`
          : escapeHTML(t('settings.prov.keySet'));
  return `<span class="prov-status prov-status-on">${t('settings.prov.connected').replace('{detail}', detail)}</span>`;
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
  if (s.provider === 'claude' || s.provider === 'grok') {
    const cliConnected = s.cliStatus?.authState === 'succeeded';
    return cliConnected
      ? `<button class="prov-btn" data-prov-action="subscription-logout" data-prov="${s.provider}" type="button"${disabled}>${escapeHTML(t('settings.prov.signOut'))}</button>`
      : `${s.provider === 'claude' && s.loginUpdate?.kind === 'awaiting-code'
        ? `<input class="prov-key-input" data-prov-login-code="claude" type="text" placeholder="${escapeHTML(t('settings.prov.pasteClaudeCode'))}" />
           <button class="prov-btn prov-btn-primary" data-prov-action="subscription-code" data-prov="claude" type="button">${escapeHTML(t('settings.prov.submitCode'))}</button>`
        : `<button class="prov-btn prov-btn-primary" data-prov-action="subscription-login" data-prov="${s.provider}" type="button"${disabled}>${escapeHTML(t('settings.prov.subscriptionLogin'))}</button>`}
         ${s.loginUpdate && s.loginUpdate.kind !== 'success' && s.loginUpdate.kind !== 'error' ? `<button class="prov-btn" data-prov-action="subscription-cancel" data-prov="${s.provider}" type="button">${escapeHTML(t('settings.prov.cancelLogin'))}</button>` : ''}`;
  }
  return '';
}
/** Local provider footer: a friendly, non-auth hint (offline → run-server guidance). */
function localHint(s: ProviderStatusView): string {
  const msg = (s.localModelCount ?? 0) > 0 ? t('settings.local.hint') : t('settings.local.noModels');
  return `<div class="prov-local-note">${escapeHTML(msg)}</div>`;
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
  const footer = isLocal ? localHint(s) : '';
  return `<div class="prov-row-head">
      <span class="prov-label">${escapeHTML(s.label)}</span>
      ${statusLine(s)}
      ${s.busy ? '<span class="prov-row-spinner" role="status" aria-live="polite">…</span>' : ''}
    </div>
    ${s.error ? `<div class="prov-error" role="alert">${escapeHTML(s.error)}</div>` : ''}
    ${s.errorDetail ? `<div class="prov-error-detail">${escapeHTML(s.errorDetail)}</div>` : ''}
    <div class="prov-controls">${providerControls(s)}</div>
    ${footer}`;
}
function renderProviderRow(s: ProviderStatusView): string {
  return `<section class="prov-row" data-prov-row="${s.provider}" aria-busy="${s.loading || s.busy ? 'true' : 'false'}">
    ${renderProviderRowContent(s)}
  </section>`;
}
export function renderProviderSettingsPanel(opts: ProviderSettingsRenderOptions): string {
  let localSectionRendered = false;
  const rows = (opts.statuses ?? []).map((status) => {
    const divider = !localSectionRendered && status.authKind === 'local'
      ? (() => {
        localSectionRendered = true;
        return `<h3 class="prov-local-section">${escapeHTML(t('settings.prov.localModels'))}</h3>`;
      })()
      : '';
    return `${divider}${renderProviderRow(status)}`;
  }).join('\n');
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
  for (const attr of ['data-prov-url']) {
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
  const loginUpdates = new Map<'claude' | 'grok', SubscriptionLoginUpdate>();
  parent.innerHTML = renderProviderSettingsPanel(current);
  let renderedNotice = renderPanelNotice(current);
  const effective = (view: ProviderStatusView): ProviderStatusView => ({
    ...view,
    busy: busyProviders.has(view.provider),
    ...(view.provider === 'claude' || view.provider === 'grok'
      ? { loginUpdate: loginUpdates.get(view.provider) }
      : {}),
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
        const divider = next.authKind === 'local' && !root.querySelector('.prov-local-section')
          ? `<h3 class="prov-local-section">${escapeHTML(t('settings.prov.localModels'))}</h3>`
          : '';
        root.insertAdjacentHTML('beforeend', `${divider}${renderProviderRow(next)}`);
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
    const desiredProviders = new Set(current.statuses.map((view) => view.provider));
    root.querySelectorAll<HTMLElement>('[data-prov-row]').forEach((row) => {
      if (!desiredProviders.has(row.dataset.provRow as AiProviderId)) row.remove();
    });
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
    if (action === 'signin') return opts.onChatgptSignIn();
    if (action === 'signout' && prov === 'chatgpt') return runRowAction(prov, opts.onChatgptSignOut);
    if (action === 'subscription-login' && (prov === 'claude' || prov === 'grok')) {
      return runRowAction(prov, () => opts.onSubscriptionLogin?.(prov));
    }
    if (action === 'subscription-logout' && (prov === 'claude' || prov === 'grok')) {
      return runRowAction(prov, () => opts.onSubscriptionLogout?.(prov));
    }
    if (action === 'subscription-cancel' && (prov === 'claude' || prov === 'grok')) {
      return runRowAction(prov, () => opts.onSubscriptionCancel?.(prov));
    }
    if (action === 'subscription-code' && prov === 'claude') {
      const input = parent.querySelector<HTMLInputElement>('input[data-prov-login-code="claude"]');
      if (input?.value.trim()) return runRowAction(prov, () => opts.onSubscriptionCode?.(prov, input.value));
      return;
    }
    if (action === 'save-url' && prov === 'ollama') {
      const input = parent.querySelector<HTMLInputElement>(`input[data-prov-url="${prov}"]`);
      const url = input?.value.trim() ?? '';
      if (url) return runRowAction(prov, () => opts.onSaveLocalUrl?.(prov, url));
      return;
    }
    if (action === 'reset-url' && prov === 'ollama') {
      return runRowAction(prov, () => opts.onResetLocalUrl?.(prov));
    }
  };
  parent.addEventListener('click', onClick);
  return {
    patch,
    setRowBusy,
    setSubscriptionProgress: (update) => {
      loginUpdates.set(update.provider, update);
      patchRows(new Set([update.provider]));
    },
    destroy: () => {
      parent.removeEventListener('click', onClick);
      parent.innerHTML = '';
    },
  };
}
