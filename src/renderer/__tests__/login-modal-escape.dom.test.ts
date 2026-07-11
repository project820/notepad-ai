// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openLoginModal } from '../login-modal';
import { setLocale, type Locale } from '../i18n';
const apiWindow = window as unknown as { api?: unknown };
let priorApi: unknown;
let hadPriorApi = false;

function setupApi() {
  let cb: ((u: unknown) => void) | undefined;
  apiWindow.api = {
    authLogin: vi.fn(),
    authCancelLogin: vi.fn(),
    authStatus: vi.fn(),
    onAuthLoginUpdate: (fn: (u: unknown) => void) => {
      cb = fn;
    },
  };
  return { emit: (u: unknown) => cb?.(u) };
}

beforeEach(() => {
  hadPriorApi = Object.prototype.hasOwnProperty.call(apiWindow, 'api');
  priorApi = apiWindow.api;
  document.body.innerHTML = '';
  setLocale('en');
});
afterEach(() => {
  document.querySelector<HTMLButtonElement>('#login-close')?.click();
  document.body.innerHTML = '';
  setLocale('en');
  if (hadPriorApi) apiWindow.api = priorApi;
  else delete apiWindow.api;
});

const LOGIN_ERROR_EXPECTATIONS: ReadonlyArray<{ locale: Locale; copy: string }> = [
  { locale: 'en', copy: "Couldn't request a device code. Check your connection and try again." },
  { locale: 'ko', copy: '디바이스 코드를 요청하지 못했습니다. 연결을 확인한 후 다시 시도하세요.' },
  { locale: 'zh-Hans', copy: '无法请求设备代码。请检查网络连接后重试。' },
  { locale: 'zh-Hant', copy: '無法請求裝置代碼。請檢查網路連線後再試一次。' },
  { locale: 'ja', copy: 'デバイスコードを要求できませんでした。接続を確認して、もう一度お試しください。' },
];
const PERSIST_FAILURE_ERROR_EXPECTATIONS: ReadonlyArray<{ locale: Locale; copy: string }> = [
  { locale: 'en', copy: 'Signed in, but saving your session failed. Try again.' },
  { locale: 'ko', copy: '로그인했지만 세션을 저장하지 못했습니다. 다시 시도하세요.' },
];

const EN_LOGIN_ERROR = LOGIN_ERROR_EXPECTATIONS[0].copy;
const HTML_LIKE_DETAIL = '<script>alert(1)</script>';

describe('login-modal dynamic-value escaping (S4)', () => {
  it('renders an HTML-like email as text, not markup', () => {
    const { emit } = setupApi();
    openLoginModal({ onAfterLogin: vi.fn() });
    emit({ kind: 'success', auth: { signedIn: true, email: '<img src=x onerror=alert(1)>', plan: 'pro', persisted: true } });
    const body = document.querySelector('#login-body')!;
    expect(body.querySelector('img')).toBeNull();
    expect(body.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('escapes diagnostics and localizes device-code errors across all five locales', () => {
    try {
      for (const { locale, copy } of LOGIN_ERROR_EXPECTATIONS) {
        setLocale(locale);
        const { emit } = setupApi();
        openLoginModal({ onAfterLogin: vi.fn() });
        emit({ kind: 'error', code: 'device_code_request_failed', detail: HTML_LIKE_DETAIL });

        const body = document.querySelector('#login-body')!;
        const primaryError = body.querySelector('.login-sub')!;
        expect(primaryError.textContent, `primary error @ ${locale}`).toBe(copy);
        expect(body.textContent).not.toContain('login.error.device_code_request_failed');
        expect(body.querySelector('script')).toBeNull();
        expect(body.textContent).toContain(HTML_LIKE_DETAIL);
        if (locale !== 'en') expect(body.textContent).not.toContain(EN_LOGIN_ERROR);

        document.querySelector<HTMLButtonElement>('#login-close')!.click();
        expect(document.querySelector('.login-modal-root')).toBeNull();
      }
    } finally {
      document.querySelector<HTMLButtonElement>('#login-close')?.click();
      setLocale('en');
    }
  });
  it('localizes persistence failures in English and Korean', () => {
    for (const { locale, copy } of PERSIST_FAILURE_ERROR_EXPECTATIONS) {
      setLocale(locale);
      const { emit } = setupApi();
      openLoginModal({ onAfterLogin: vi.fn() });
      emit({ kind: 'error', code: 'persist_failed' });

      const primaryError = document.querySelector('.login-sub')!;
      expect(primaryError.textContent, `primary error @ ${locale}`).toBe(copy);

      document.querySelector<HTMLButtonElement>('#login-close')!.click();
    }
  });

  it('escapes the device usercode + verification URI', () => {
    const { emit } = setupApi();
    openLoginModal({ onAfterLogin: vi.fn() });
    emit({ kind: 'usercode', userCode: 'ABCD1234', verificationUri: 'https://auth.openai.com/codex/device?x="><img src=x>' });
    const body = document.querySelector('#login-body')!;
    expect(body.querySelector('img')).toBeNull();
  });

  it('surfaces the localized memory-only warning when persisted is false', () => {
    const { emit } = setupApi();
    openLoginModal({ onAfterLogin: vi.fn() });
    emit({ kind: 'success', auth: { signedIn: true, email: 'a@b.com', persisted: false, warning: 'secure_storage_unavailable' } });
    expect(document.querySelector('.login-warn')?.textContent).toContain('Secure storage is unavailable');
  });
});
