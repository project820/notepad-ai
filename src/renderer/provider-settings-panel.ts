/**
 * provider-settings-panel.ts — multi-provider AI settings UI (G001 renderer).
 *
 * Follows the settings-editor-panel pattern:
 *   - `renderProviderSettingsPanel(opts)` — pure, no DOM, returns HTML string
 *     (testable in Node).
 *   - `mountProviderSettingsPanel(parent, opts)` — DOM-dependent, wires actions.
 *
 * Surfaces the three v1 providers (ChatGPT sign-in, Claude API key, OpenRouter
 * API key), a per-provider connected/last-4 status, a custom model-ID input
 * (mitigates catalog staleness), and a zero-auth notice that prompts onboarding
 * when no provider is connected (AC23). Secrets are never rendered — only the
 * last 4 chars of a saved key are shown.
 */

export type ProviderStatusView = {
  provider: 'chatgpt' | 'claude' | 'openrouter';
  label: string;
  authKind: 'oauth' | 'api_key';
  connected: boolean;
  accountLabel?: string;
  keyLast4?: string;
  error?: string;
};

export type ProviderSettingsRenderOptions = {
  statuses: ProviderStatusView[];
};

export type ProviderSettingsOptions = ProviderSettingsRenderOptions & {
  onChatgptSignIn: () => void;
  onChatgptSignOut: () => void;
  onSaveKey: (provider: 'claude' | 'openrouter', key: string) => void;
  onDeleteKey: (provider: 'claude' | 'openrouter') => void;
  onSetCustomModel: (provider: 'chatgpt' | 'claude' | 'openrouter', modelId: string) => void;
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
  if (!s.connected) return '<span class="prov-status prov-status-off">Not connected</span>';
  const detail =
    s.authKind === 'oauth'
      ? s.accountLabel
        ? escapeHTML(s.accountLabel)
        : 'Signed in'
      : s.keyLast4
        ? `Key ••••${escapeHTML(s.keyLast4)}`
        : 'Key set';
  return `<span class="prov-status prov-status-on">Connected · ${detail}</span>`;
}

function providerControls(s: ProviderStatusView): string {
  if (s.provider === 'chatgpt') {
    return s.connected
      ? `<button class="prov-btn" data-prov-action="signout" type="button">Sign out</button>`
      : `<button class="prov-btn prov-btn-primary" data-prov-action="signin" type="button">Sign in</button>`;
  }
  // API-key providers (claude, openrouter)
  return `
    <input class="prov-key-input" data-prov-key="${s.provider}" type="password"
      placeholder="Paste API key" aria-label="${escapeHTML(s.label)} API key" />
    <button class="prov-btn prov-btn-primary" data-prov-action="save-key" data-prov="${s.provider}" type="button">Save key</button>
    <button class="prov-btn" data-prov-action="delete-key" data-prov="${s.provider}" type="button"${s.connected ? '' : ' disabled'}>Remove</button>`;
}

export function renderProviderSettingsPanel(opts: ProviderSettingsRenderOptions): string {
  const statuses = opts.statuses ?? [];
  const anyConnected = statuses.some((s) => s.connected);

  const zeroAuthNotice = anyConnected
    ? ''
    : `<div class="prov-zero-auth" role="alert">No AI provider connected. Connect at least one below to use AI features.</div>`;

  const rows = statuses
    .map(
      (s) => `<section class="prov-row" data-prov-row="${s.provider}">
    <div class="prov-row-head">
      <span class="prov-label">${escapeHTML(s.label)}</span>
      ${statusLine(s)}
    </div>
    ${s.error ? `<div class="prov-error" role="alert">${escapeHTML(s.error)}</div>` : ''}
    <div class="prov-controls">${providerControls(s)}</div>
    <div class="prov-custom">
      <input class="prov-custom-input" data-prov-custom="${s.provider}" type="text"
        placeholder="Custom model ID (optional)" aria-label="${escapeHTML(s.label)} custom model id" />
      <button class="prov-btn" data-prov-action="set-custom" data-prov="${s.provider}" type="button">Use model</button>
    </div>
  </section>`,
    )
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
    const prov = btn.dataset.prov as 'claude' | 'openrouter' | 'chatgpt' | undefined;
    if (action === 'signin') return opts.onChatgptSignIn();
    if (action === 'signout') return opts.onChatgptSignOut();
    if (action === 'save-key' && (prov === 'claude' || prov === 'openrouter')) {
      const input = parent.querySelector<HTMLInputElement>(`input[data-prov-key="${prov}"]`);
      const key = input?.value.trim() ?? '';
      if (key) opts.onSaveKey(prov, key);
      if (input) input.value = '';
      return;
    }
    if (action === 'delete-key' && (prov === 'claude' || prov === 'openrouter')) {
      return opts.onDeleteKey(prov);
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
