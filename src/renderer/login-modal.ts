import { trapModalFocus } from './modal-a11y';

type AuthSnapshot = {
  signedIn: boolean;
  email?: string;
  plan?: string;
  persisted?: boolean;
  warning?: string;
};

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

type ModalCallbacks = {
  onAfterLogin: (auth: AuthSnapshot) => void;
};

export function openLoginModal(cb: ModalCallbacks) {
  if (document.querySelector('.login-modal-root')) return;

  const root = document.createElement('div');
  root.className = 'login-modal-root';
  root.innerHTML = `
    <div class="login-modal" role="dialog" aria-label="Sign in">
      <div class="login-modal-header">
        <div class="brand">
          <div class="brand-mark">md</div>
          <div>
            <div class="brand-title">notepad-ai</div>
            <div class="brand-sub">Sign in to enable AI features</div>
          </div>
        </div>
        <button class="login-modal-close" id="login-close" title="Skip for now" aria-label="Close">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><line x1="2.5" y1="2.5" x2="9.5" y2="9.5"/><line x1="9.5" y1="2.5" x2="2.5" y2="9.5"/></svg>
        </button>
      </div>
      <div class="login-modal-body" id="login-body">
        <p class="lead">Sign in with your <strong>ChatGPT</strong> account to enable AI features. An individual ChatGPT Plus subscription is required.</p>
        <button class="login-cta" id="login-cta">
          <span>Sign in with ChatGPT</span>
        </button>
        <div class="login-hint">Your browser will open. Enter the code shown next.</div>
      </div>
    </div>
  `;
  document.body.appendChild(root);

  const body = root.querySelector('#login-body') as HTMLDivElement;
  const cta = root.querySelector('#login-cta') as HTMLButtonElement;
  const closeBtn = root.querySelector('#login-close') as HTMLButtonElement;

  const releaseFocusTrap = trapModalFocus({
    dialog: root.querySelector('.login-modal') as HTMLElement,
    onEscape: () => {
      void window.api.authCancelLogin();
      dismiss();
    },
  });
  // Remove the modal AND release the focus trap / restore focus to the opener.
  function dismiss(): void {
    releaseFocusTrap();
    root.remove();
  }

  closeBtn.addEventListener('click', () => {
    void window.api.authCancelLogin();
    dismiss();
  });

  cta.addEventListener('click', () => {
    cta.disabled = true;
    cta.textContent = 'Requesting device code…';
    void window.api.authLogin();
  });

  window.api.onAuthLoginUpdate((update) => {
    if (update.kind === 'usercode') {
      body.innerHTML = `
        <p class="lead">Enter this code in your browser.</p>
        <div class="login-code">${esc(update.userCode.replace(/(.{4})/g, '$1 ').trim())}</div>
        <p class="login-sub">
          Browser didn't open?<br/>
          <a href="${esc(update.verificationUri)}" target="_blank">${esc(update.verificationUri)}</a>
        </p>
        <div class="login-spinner"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>
        <div class="login-hint">Waiting for sign-in…</div>
        <button class="login-cancel" id="login-cancel">Cancel</button>
      `;
      body.querySelector('#login-cancel')?.addEventListener('click', () => {
        void window.api.authCancelLogin();
        dismiss();
      });
    } else if (update.kind === 'success') {
      body.innerHTML = `
        <div class="login-ok"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="4,10.5 8.5,15 16,6"/></svg></div>
        <p class="lead">Signed in</p>
        <p class="login-sub">${esc(update.auth.email ?? '')}${update.auth.plan ? ` · ${esc(update.auth.plan)}` : ''}</p>
        ${update.auth.persisted === false && update.auth.warning ? `<p class="login-sub login-warn">${esc(update.auth.warning)}</p>` : ''}
        <button class="login-cta" id="login-done">Continue</button>
      `;
      body.querySelector('#login-done')?.addEventListener('click', () => {
        dismiss();
        cb.onAfterLogin(update.auth);
      });
      // also auto-close after 2.5s
      setTimeout(() => {
        if (document.body.contains(root)) {
          dismiss();
          cb.onAfterLogin(update.auth);
        }
      }, 2500);
    } else if (update.kind === 'error') {
      body.innerHTML = `
        <div class="login-err">!</div>
        <p class="lead">Sign-in failed</p>
        <p class="login-sub">${esc(update.message)}</p>
        <button class="login-cta" id="login-retry">Try again</button>
      `;
      body.querySelector('#login-retry')?.addEventListener('click', () => {
        dismiss();
        openLoginModal(cb);
      });
    }
  });
}

