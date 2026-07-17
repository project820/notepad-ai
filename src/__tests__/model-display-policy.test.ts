import { describe, expect, it } from 'vitest';
import { applyModelDisplayPolicy } from '../main/ai/model-display-policy';
import type { AiProviderId, ModelRef } from '../main/ai/types';

function model(provider: AiProviderId, id: string): ModelRef {
  return { provider, id, humanizeEngineId: 'openai', requiresAuth: true };
}

describe('applyModelDisplayPolicy', () => {
  it('uses exact cloud allow-lists while retaining Ollama discovery results', () => {
    const visible = applyModelDisplayPolicy([
      model('chatgpt', 'gpt-5.6'),
      model('chatgpt', 'gpt-5.6-preview'),
      model('chatgpt', 'gpt-5.3-codex-spark'),
      model('claude', 'claude-sonnet-5'),
      model('claude', 'claude-sonnet-4-6'),
      model('grok', 'grok-4.5'),
      model('grok', 'grok-4'),
      model('ollama', 'llama3:latest'),
      model('lmstudio', 'my-local-model'),
    ]);

    expect(visible.map((entry) => `${entry.provider}:${entry.id}`)).toEqual([
      'chatgpt:gpt-5.6',
      'chatgpt:gpt-5.3-codex-spark',
      'claude:claude-sonnet-5',
      'grok:grok-4.5',
      'ollama:llama3:latest',
    ]);
  });

  it('hides OpenRouter catalog entries but reinjects a current legacy selection', () => {
    const visible = applyModelDisplayPolicy([
      model('openrouter', 'openai/gpt-5.1'),
      model('chatgpt', 'gpt-5.4-mini'),
    ], { currentSelection: { provider: 'openrouter', id: 'openai/gpt-5.1' } });

    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({
      provider: 'openrouter',
      id: 'openai/gpt-5.1',
      custom: true,
    });
  });
  it('hides LM Studio catalog entries but reinjects a current legacy selection', () => {
    const visible = applyModelDisplayPolicy([
      model('lmstudio', 'my-local-model'),
      model('ollama', 'llama3:latest'),
    ], { currentSelection: { provider: 'lmstudio', id: 'my-local-model' } });

    expect(visible).toEqual([
      expect.objectContaining({ provider: 'ollama', id: 'llama3:latest' }),
      expect.objectContaining({ provider: 'lmstudio', id: 'my-local-model', custom: true }),
    ]);
  });

  it('reinjects a no-longer-allowed selected cloud model without restoring other stale IDs', () => {
    const visible = applyModelDisplayPolicy([
      model('chatgpt', 'gpt-5.4-mini'),
      model('claude', 'claude-sonnet-4-6'),
    ], { currentSelection: { provider: 'claude', id: 'claude-sonnet-4-6' } });

    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({ provider: 'claude', id: 'claude-sonnet-4-6', custom: true });
  });
  it('does not reinject a curated model omitted by the route-honest inventory', () => {
    const visible = applyModelDisplayPolicy([
      model('grok', 'grok-4.5'),
    ], { currentSelection: { provider: 'grok', id: 'grok-composer-2.5-fast' } });

    expect(visible.map((entry) => `${entry.provider}:${entry.id}`)).toEqual(['grok:grok-4.5']);
  });
});
