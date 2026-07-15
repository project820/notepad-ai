import { describe, expect, it } from 'vitest';

import { resolveHtmlCapableProviderIds } from '../unified-chat-wiring';
import type { AiProviderId, ProviderAuthStatus } from '../../main/ai/types';

function status(
  partial: Partial<ProviderAuthStatus> & Pick<ProviderAuthStatus, 'provider'>,
): ProviderAuthStatus {
  return {
    authKind: 'api_key',
    connected: false,
    label: 'test',
    ...partial,
  };
}

describe('resolveHtmlCapableProviderIds (last-known-safe continuity)', () => {
  it('on success returns the live capable set and proposes it as the next cache', () => {
    const statuses = [
      status({ provider: 'chatgpt', connected: true, authKind: 'oauth' }),
      status({
        provider: 'claude',
        connected: true,
        connectionSource: 'api_key',
        cliStatus: { installed: false, authState: 'unknown', errorCode: 'claude_cli_setup_required' },
        errorCode: 'claude_cli_setup_required',
      }),
      status({ provider: 'openrouter', connected: true }),
    ];
    const { capable, nextCache } = resolveHtmlCapableProviderIds(statuses, null);
    expect(capable).not.toBeNull();
    expect([...capable!]).toEqual(['chatgpt']);
    expect(nextCache).toBe(capable);
  });

  it('on fetch failure reuses a non-null cache (does not admit unknown providers)', () => {
    const cached = new Set<AiProviderId>(['chatgpt']);
    const { capable, nextCache } = resolveHtmlCapableProviderIds(null, cached);
    expect(capable).toBe(cached);
    expect(nextCache).toBe(cached);
    expect(capable!.has('chatgpt')).toBe(true);
    expect(capable!.has('claude')).toBe(false);
  });

  it('on cold fetch failure (null cache) returns null so pre-gate fallback applies', () => {
    const { capable, nextCache } = resolveHtmlCapableProviderIds(null, null);
    expect(capable).toBeNull();
    expect(nextCache).toBeNull();
  });

  it('after a successful fetch, a subsequent failure still filters to the cached set', () => {
    const first = resolveHtmlCapableProviderIds(
      [status({ provider: 'chatgpt', connected: true, authKind: 'oauth' })],
      null,
    );
    expect([...first.capable!]).toEqual(['chatgpt']);

    // Simulate the wiring loop: store nextCache, then fail the next status probe.
    const second = resolveHtmlCapableProviderIds(null, first.nextCache);
    expect(second.capable).toBe(first.nextCache);
    expect([...second.capable!]).toEqual(['chatgpt']);
    // Full allowlist would include claude/grok/… — cached set must stay narrow.
    expect(second.capable!.has('claude')).toBe(false);
    expect(second.capable!.has('openrouter')).toBe(false);
  });

  it('successful empty set is cached so a later failure still blocks entry/picker', () => {
    const empty = resolveHtmlCapableProviderIds(
      [status({ provider: 'openrouter', connected: true })],
      null,
    );
    expect(empty.capable!.size).toBe(0);
    const later = resolveHtmlCapableProviderIds(null, empty.nextCache);
    expect(later.capable).not.toBeNull();
    expect(later.capable!.size).toBe(0);
  });
});
