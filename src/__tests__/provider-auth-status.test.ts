import { describe, expect, it } from 'vitest';
import { isProviderAuthAttemptable } from '../shared/provider-auth-status';

describe('isProviderAuthAttemptable', () => {
  it.each([
    ['connected provider', { connected: true, authKind: 'api_key' }, true],
    ['Grok installed with unverified auth', { connected: false, authKind: 'cli', installed: true, authUnverified: true }, true],
    ['Grok contradictory uninstalled status', { connected: false, authKind: 'cli', installed: false, authUnverified: true }, false],
    ['Claude installed with unknown CLI auth', { connected: false, authKind: 'api_key', cliStatus: { installed: true, authState: 'unknown' as const } }, true],
    ['Claude installed with succeeded CLI auth', { connected: false, authKind: 'api_key', cliStatus: { installed: true, authState: 'succeeded' as const } }, true],
    ['Claude auth failure', { connected: false, authKind: 'api_key', cliStatus: { installed: true, authState: 'auth_failed' as const } }, false],
    ['Claude contradictory nested uninstalled status', { connected: false, authKind: 'api_key', cliStatus: { installed: false, authState: 'unknown' as const } }, false],
  ] as const)('%s', (_name, status, expected) => {
    expect(isProviderAuthAttemptable(status)).toBe(expected);
  });
});
