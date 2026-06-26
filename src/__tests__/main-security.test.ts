import { describe, expect, it } from 'vitest';

import {
  isTrustedAppUrl,
  assertTrustedSenderShape,
  SECURITY_REASON,
  type TrustedSenderShape,
} from '../main/security';

const DEV = { isDev: true };
const PROD = { isDev: false };

describe('isTrustedAppUrl — dev origin allowlist', () => {
  it('allows exactly http/ws on localhost:5173', () => {
    expect(isTrustedAppUrl('http://localhost:5173', DEV)).toBe(true);
    expect(isTrustedAppUrl('http://localhost:5173/', DEV)).toBe(true);
    expect(isTrustedAppUrl('http://localhost:5173/index.html', DEV)).toBe(true);
    expect(isTrustedAppUrl('ws://localhost:5173', DEV)).toBe(true);
  });

  it('rejects wrong ports, hosts, and schemes in dev', () => {
    expect(isTrustedAppUrl('http://localhost:5174', DEV)).toBe(false); // wrong port
    expect(isTrustedAppUrl('http://localhost', DEV)).toBe(false); // no port
    expect(isTrustedAppUrl('http://127.0.0.1:5173', DEV)).toBe(false); // wrong host
    expect(isTrustedAppUrl('http://localhost.evil.com:5173', DEV)).toBe(false); // suffix host
    expect(isTrustedAppUrl('http://localhost:5173@evil.com', DEV)).toBe(false); // userinfo trick
    expect(isTrustedAppUrl('https://localhost:5173', DEV)).toBe(false); // wrong scheme
    expect(isTrustedAppUrl('wss://localhost:5173', DEV)).toBe(false); // wrong scheme
    expect(isTrustedAppUrl('file:///app/index.html', DEV)).toBe(false); // file not trusted in dev
  });
});

describe('isTrustedAppUrl — prod origin allowlist', () => {
  it('allows only local file: URLs', () => {
    expect(isTrustedAppUrl('file:///Users/me/app/index.html', PROD)).toBe(true);
    // host "localhost" normalizes to empty host for file: URLs.
    expect(isTrustedAppUrl('file://localhost/Users/me/app/index.html', PROD)).toBe(true);
  });

  it('rejects remote and dev origins in prod', () => {
    expect(isTrustedAppUrl('https://attacker.example', PROD)).toBe(false); // remote https
    expect(isTrustedAppUrl('http://localhost:5173', PROD)).toBe(false); // dev origin not trusted in prod
    expect(isTrustedAppUrl('file://attacker/share/index.html', PROD)).toBe(false); // remote UNC host
  });
});

describe('isTrustedAppUrl — malformed and hostile inputs', () => {
  it('rejects dangerous schemes, whitespace, malformed, and non-strings', () => {
    expect(isTrustedAppUrl('data:text/html,<script>1</script>', DEV)).toBe(false);
    expect(isTrustedAppUrl('about:blank', DEV)).toBe(false);
    expect(isTrustedAppUrl('javascript:alert(1)', DEV)).toBe(false);
    expect(isTrustedAppUrl(' http://localhost:5173', DEV)).toBe(false); // leading whitespace
    expect(isTrustedAppUrl('http://localhost:51\t73', DEV)).toBe(false); // embedded control char
    expect(isTrustedAppUrl('not a url', DEV)).toBe(false); // malformed
    expect(isTrustedAppUrl('', DEV)).toBe(false); // empty
    expect(isTrustedAppUrl(null, DEV)).toBe(false); // non-string
    expect(isTrustedAppUrl(undefined, PROD)).toBe(false); // non-string
    expect(isTrustedAppUrl(12345, DEV)).toBe(false); // non-string
    expect(isTrustedAppUrl({ href: 'http://localhost:5173' }, DEV)).toBe(false); // object
  });
});

const frame = (over: Partial<TrustedSenderShape> = {}): TrustedSenderShape => ({
  hasSenderFrame: true,
  isMainFrame: true,
  frameUrl: 'http://localhost:5173/index.html',
  ...over,
});

describe('assertTrustedSenderShape', () => {
  it('accepts the app main frame on a trusted dev origin', () => {
    expect(assertTrustedSenderShape(frame(), DEV)).toEqual({ ok: true });
  });

  it('accepts the app main frame on a trusted prod (file:) origin', () => {
    expect(assertTrustedSenderShape(frame({ frameUrl: 'file:///app/index.html' }), PROD)).toEqual({
      ok: true,
    });
  });

  it('rejects a missing sender frame as IPC_UNTRUSTED_SENDER', () => {
    const res = assertTrustedSenderShape(frame({ hasSenderFrame: false }), DEV);
    expect(res.ok).toBe(false);
    expect(res).toEqual({ ok: false, reason: SECURITY_REASON.IPC_UNTRUSTED_SENDER });
  });

  it('rejects a subframe as IPC_UNTRUSTED_FRAME', () => {
    const res = assertTrustedSenderShape(frame({ isMainFrame: false }), DEV);
    expect(res).toEqual({ ok: false, reason: SECURITY_REASON.IPC_UNTRUSTED_FRAME });
  });

  it('rejects a main frame on an untrusted origin as IPC_UNTRUSTED_FRAME', () => {
    const remote = assertTrustedSenderShape(frame({ frameUrl: 'https://attacker.example' }), DEV);
    expect(remote).toEqual({ ok: false, reason: SECURITY_REASON.IPC_UNTRUSTED_FRAME });
    const missingUrl = assertTrustedSenderShape(frame({ frameUrl: null }), DEV);
    expect(missingUrl).toEqual({ ok: false, reason: SECURITY_REASON.IPC_UNTRUSTED_FRAME });
  });
});
