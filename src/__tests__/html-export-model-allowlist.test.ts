import { describe, expect, it } from 'vitest';

import {
  HTML_EXPORT_MODEL_PROVIDERS,
  filterHtmlExportModels,
  htmlCapableProviderIds,
  isHtmlExportModelProviderAllowed,
  isHtmlExportProviderUsable,
} from '../main/ai/html-export-model-allowlist';
import type { ProviderAuthStatus } from '../main/ai/types';

describe('HTML export model allowlist (§5.3 / AC-M1d)', () => {
  it('allows exactly the five first-party/local providers and excludes OpenRouter', () => {
    expect([...HTML_EXPORT_MODEL_PROVIDERS].sort()).toEqual(
      ['chatgpt', 'claude', 'grok', 'lmstudio', 'ollama'],
    );
    expect(HTML_EXPORT_MODEL_PROVIDERS).not.toContain('openrouter');
  });

  it('isHtmlExportModelProviderAllowed is true only for allowed providers', () => {
    for (const provider of HTML_EXPORT_MODEL_PROVIDERS) {
      expect(isHtmlExportModelProviderAllowed(provider)).toBe(true);
    }
    for (const denied of ['openrouter', 'OPENROUTER', '', ' claude', undefined, null, 42]) {
      expect(isHtmlExportModelProviderAllowed(denied)).toBe(false);
    }
  });

  it('filterHtmlExportModels drops OpenRouter without re-injecting it', () => {
    const models = [
      { provider: 'claude', id: 'claude-sonnet' },
      { provider: 'openrouter', id: 'anthropic/claude-sonnet-4.5' },
      { provider: 'grok', id: 'grok-4.5' },
      { provider: 'openrouter', id: 'meta/llama' },
    ];
    const filtered = filterHtmlExportModels(models);
    expect(filtered.map((m) => m.id)).toEqual(['claude-sonnet', 'grok-4.5']);
    expect(filtered.some((m) => m.provider === 'openrouter')).toBe(false);
  });

  it('fail-closed drops a model with a missing or blank provider', () => {
    const filtered = filterHtmlExportModels([
      { provider: undefined, id: 'a' },
      { provider: '', id: 'b' },
      { provider: 'ollama', id: 'llama3' },
    ]);
    expect(filtered.map((m) => m.id)).toEqual(['llama3']);
  });
});

describe('isHtmlExportProviderUsable (HTML transport honesty)', () => {
  const base = (partial: Partial<ProviderAuthStatus> & Pick<ProviderAuthStatus, 'provider'>): ProviderAuthStatus => ({
    authKind: 'api_key',
    connected: false,
    label: partial.provider,
    ...partial,
  });

  it('allows connected non-Claude allowlisted providers', () => {
    expect(isHtmlExportProviderUsable(base({ provider: 'chatgpt', connected: true, authKind: 'oauth' }))).toBe(true);
    expect(isHtmlExportProviderUsable(base({ provider: 'grok', connected: true }))).toBe(true);
    expect(isHtmlExportProviderUsable(base({ provider: 'ollama', connected: true, authKind: 'local' }))).toBe(true);
    expect(isHtmlExportProviderUsable(base({ provider: 'lmstudio', connected: true, authKind: 'local' }))).toBe(true);
  });

  it('rejects disconnected allowlisted providers', () => {
    expect(isHtmlExportProviderUsable(base({ provider: 'chatgpt', connected: false, authKind: 'oauth' }))).toBe(false);
    expect(isHtmlExportProviderUsable(base({ provider: 'grok', connected: false }))).toBe(false);
  });

  it('rejects OpenRouter even when connected', () => {
    expect(isHtmlExportProviderUsable(base({ provider: 'openrouter', connected: true }))).toBe(false);
  });

  it('rejects Claude API-only (connected, no CLI / setup required)', () => {
    expect(isHtmlExportProviderUsable(base({
      provider: 'claude',
      connected: true,
      connectionSource: 'api_key',
      errorCode: 'claude_cli_setup_required',
      cliStatus: { installed: false, authState: 'unknown', errorCode: 'claude_cli_setup_required' },
    }))).toBe(false);
    // API connected, CLI nested status missing entirely
    expect(isHtmlExportProviderUsable(base({
      provider: 'claude',
      connected: true,
      connectionSource: 'api_key',
    }))).toBe(false);
  });

  it('accepts Claude when CLI is the active connection source', () => {
    expect(isHtmlExportProviderUsable(base({
      provider: 'claude',
      connected: true,
      connectionSource: 'cli',
      cliStatus: { installed: true, authState: 'succeeded' },
    }))).toBe(true);
  });

  it('accepts Claude when nested cliStatus reports installed+succeeded (dual API+CLI)', () => {
    expect(isHtmlExportProviderUsable(base({
      provider: 'claude',
      connected: true,
      connectionSource: 'api_key',
      cliStatus: { installed: true, authState: 'succeeded' },
    }))).toBe(true);
  });

  it('rejects Claude when CLI is installed but auth is not ready (fail-closed)', () => {
    expect(isHtmlExportProviderUsable(base({
      provider: 'claude',
      connected: true,
      connectionSource: 'api_key',
      cliStatus: { installed: true, authState: 'auth_failed', errorCode: 'claude_cli_login_required' },
    }))).toBe(false);
    expect(isHtmlExportProviderUsable(base({
      provider: 'claude',
      connected: false,
      cliStatus: { installed: true, authState: 'unknown', errorCode: 'claude_cli_auth_unknown' },
    }))).toBe(false);
  });

  it('htmlCapableProviderIds collects only usable providers', () => {
    const ids = htmlCapableProviderIds([
      base({ provider: 'openrouter', connected: true }),
      base({ provider: 'chatgpt', connected: true, authKind: 'oauth' }),
      base({
        provider: 'claude',
        connected: true,
        connectionSource: 'api_key',
        cliStatus: { installed: false, authState: 'unknown', errorCode: 'claude_cli_setup_required' },
        errorCode: 'claude_cli_setup_required',
      }),
      base({
        provider: 'grok',
        connected: false,
      }),
    ]);
    expect([...ids]).toEqual(['chatgpt']);
  });
});
