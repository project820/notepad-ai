// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openLoginModal } from '../login-modal';

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

  it('escapes an HTML-like error message', () => {
    const { emit } = setupApi();
    openLoginModal({ onAfterLogin: vi.fn() });
    emit({ kind: 'error', message: '<script>alert(1)</script>' });
    const body = document.querySelector('#login-body')!;
    expect(body.querySelector('script')).toBeNull();
    expect(body.textContent).toContain('<script>alert(1)</script>');
  });

  it('escapes the device usercode + verification URI', () => {
    const { emit } = setupApi();
    openLoginModal({ onAfterLogin: vi.fn() });
    emit({ kind: 'usercode', userCode: 'ABCD1234', verificationUri: 'https://auth.openai.com/codex/device?x="><img src=x>' });
    const body = document.querySelector('#login-body')!;
    expect(body.querySelector('img')).toBeNull();
  });

  it('surfaces the memory-only warning when persisted is false', () => {
    const { emit } = setupApi();
    openLoginModal({ onAfterLogin: vi.fn() });
    emit({ kind: 'success', auth: { signedIn: true, email: 'a@b.com', persisted: false, warning: 'Secure storage is unavailable. Sign-in will last only until the app quits.' } });
    expect(document.querySelector('.login-warn')?.textContent).toContain('Secure storage is unavailable');
  });
});
