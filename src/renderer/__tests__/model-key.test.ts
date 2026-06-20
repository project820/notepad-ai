import { describe, expect, it } from 'vitest';

import { modelKey, parseModelKey } from '../model-key';

describe('modelKey', () => {
  it('serializes a (provider, id) pair to "provider:id"', () => {
    expect(modelKey({ provider: 'chatgpt', id: 'gpt-5.4-mini' })).toBe('chatgpt:gpt-5.4-mini');
    expect(modelKey({ provider: 'openrouter', id: 'anthropic/claude-sonnet-4.5' })).toBe(
      'openrouter:anthropic/claude-sonnet-4.5',
    );
    expect(modelKey({ provider: 'ollama', id: 'llama3.1' })).toBe('ollama:llama3.1');
  });
});

describe('parseModelKey', () => {
  it('splits a known key on the first colon', () => {
    expect(parseModelKey('claude:claude-sonnet-4-5')).toEqual({ provider: 'claude', id: 'claude-sonnet-4-5' });
    expect(parseModelKey('lmstudio:qwen2.5')).toEqual({ provider: 'lmstudio', id: 'qwen2.5' });
  });

  it('keeps colons inside the id (splits only on the first)', () => {
    expect(parseModelKey('openrouter:org/model:tag')).toEqual({ provider: 'openrouter', id: 'org/model:tag' });
  });

  it('treats a bare id (no colon) as a ChatGPT model', () => {
    expect(parseModelKey('gpt-5.4-mini')).toEqual({ provider: 'chatgpt', id: 'gpt-5.4-mini' });
  });

  it('falls back to chatgpt for an unknown provider segment', () => {
    expect(parseModelKey('gemini:pro')).toEqual({ provider: 'chatgpt', id: 'pro' });
  });

  it('round-trips every supported provider', () => {
    for (const provider of ['chatgpt', 'claude', 'openrouter', 'ollama', 'lmstudio'] as const) {
      const ref = { provider, id: 'some-model' };
      expect(parseModelKey(modelKey(ref))).toEqual(ref);
    }
  });
});
