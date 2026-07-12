import { describe, expect, it } from 'vitest';
import type { ProviderAuthStatus } from '../../main/ai/types';
import { isProviderAuthAttemptable } from '../../shared/provider-auth-status';
import { renderProviderSettingsPanel } from '../provider-settings-panel';
import { toView, type LocalViewContext } from '../settings-modal';

const local: LocalViewContext = {
  config: { ollama: '', lmstudio: '' },
  modelCount: () => 0,
};

const cases: ReadonlyArray<{ name: string; raw: ProviderAuthStatus; display: string; attemptable: boolean }> = [
  { name: 'API key + unknown CLI', raw: { provider: 'claude', authKind: 'api_key', label: 'Claude', connected: true, connectionSource: 'api_key', keyLast4: '1234', cliStatus: { installed: true, authState: 'unknown', errorCode: 'claude_cli_auth_unknown' } }, display: 'CLI status unverified', attemptable: true },
  { name: 'API key + failed CLI', raw: { provider: 'claude', authKind: 'api_key', label: 'Claude', connected: true, connectionSource: 'api_key', keyLast4: '1234', cliStatus: { installed: true, authState: 'auth_failed', errorCode: 'claude_cli_login_required' } }, display: 'CLI login required', attemptable: true },
  { name: 'API key + succeeded CLI', raw: { provider: 'claude', authKind: 'api_key', label: 'Claude', connected: true, connectionSource: 'api_key', keyLast4: '1234', cliStatus: { installed: true, authState: 'succeeded' } }, display: 'CLI connected', attemptable: true },
  { name: 'no key + unknown CLI', raw: { provider: 'claude', authKind: 'api_key', label: 'Claude', connected: false, cliStatus: { installed: true, authState: 'unknown', errorCode: 'claude_cli_auth_unknown' } }, display: 'CLI status unverified', attemptable: true },
  { name: 'no key + failed CLI', raw: { provider: 'claude', authKind: 'api_key', label: 'Claude', connected: false, cliStatus: { installed: true, authState: 'auth_failed', errorCode: 'claude_cli_login_required' } }, display: 'CLI login required', attemptable: false },
  { name: 'no key + missing CLI', raw: { provider: 'claude', authKind: 'api_key', label: 'Claude', connected: false, errorCode: 'claude_cli_setup_required', cliStatus: { installed: false, authState: 'unknown', errorCode: 'claude_cli_setup_required' } }, display: 'Run `claude login`', attemptable: false },
  { name: 'Grok unverified CLI', raw: { provider: 'grok', authKind: 'cli', label: 'Grok', connected: false, installed: true, authUnverified: true }, display: 'Status unverified', attemptable: true },
  { name: 'Grok contradictory uninstalled CLI', raw: { provider: 'grok', authKind: 'cli', label: 'Grok', connected: false, installed: false, authUnverified: true }, display: 'Not connected', attemptable: false },
];

describe('Claude dual transport status pipeline', () => {
  it.each(cases)('$name flows raw status through view into independent final HTML', ({ raw, display, attemptable }) => {
    const view = toView(raw, local);
    expect(view).not.toBeNull();
    expect(view!.cliStatus).toEqual(raw.cliStatus);
    expect(view!.errorCode).toBe(raw.errorCode);
    expect(renderProviderSettingsPanel({ statuses: [view!] })).toContain(display);
    expect(isProviderAuthAttemptable(view!)).toBe(attemptable);
  });
});
