// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openLoginModal } from '../login-modal';
import { setLocale } from '../i18n';

function setupApi() {
  let cb: ((u: unknown) => void) | undefined;
  (window as unknown as { api: unknown }).api = {
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
  document.body.innerHTML = '';
  setLocale('en');
});

describe('login-modal dynamic-value escaping (S4)', () => {
  it('renders an HTML-like email as text, not markup', () => {
    const { emit } = setupApi();
    openLoginModal({ onAfterLogin: vi.fn() });
    emit({ kind: 'success', auth: { signedIn: true, email: '<img src=x onerror=alert(1)>', plan: 'pro', persisted: true } });
    const body = document.querySelector('#login-body')!;
    expect(body.querySelector('img')).toBeNull();
    expect(body.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('escapes diagnostic detail while localizing the primary error', () => {
    const { emit } = setupApi();
    openLoginModal({ onAfterLogin: vi.fn() });
    emit({ kind: 'error', code: 'device_code_request_failed', detail: '<script>alert(1)</script>' });
    const body = document.querySelector('#login-body')!;
    expect(body.querySelector('script')).toBeNull();
    expect(body.textContent).toContain("Couldn't request a device code.");
    expect(body.textContent).toContain('<script>alert(1)</script>');
  });

  it('renders the error code through the active non-English locale', () => {
    const { emit } = setupApi();
    setLocale('ko');
    openLoginModal({ onAfterLogin: vi.fn() });
    emit({ kind: 'error', code: 'timeout_or_incomplete_response' });
    const body = document.querySelector('#login-body')!;
    expect(body.textContent).toContain('로그인 시간이 초과되었거나 완료되지 않았습니다.');
    expect(body.textContent).not.toContain('login.error.');
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
