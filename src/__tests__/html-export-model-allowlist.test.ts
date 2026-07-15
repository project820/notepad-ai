import { describe, expect, it } from 'vitest';

import {
  HTML_EXPORT_MODEL_PROVIDERS,
  filterHtmlExportModels,
  isHtmlExportModelProviderAllowed,
} from '../main/ai/html-export-model-allowlist';

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
