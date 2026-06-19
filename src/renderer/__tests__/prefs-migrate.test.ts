import { describe, expect, it } from 'vitest';

import { migratePrefs } from '../prefs';

describe('migratePrefs', () => {
  it('null input yields defaults with derived structured fields', () => {
    const p = migratePrefs(null);
    expect(p.selectedModel).toEqual({ provider: 'chatgpt', id: 'gpt-5.4-mini' });
    expect(p.blockSelectedModel).toEqual({ provider: 'chatgpt', id: 'gpt-5.4-mini' });
    expect(p.style).toEqual({ difficulty: 'college', naturalness: 'balanced' });
  });

  it('derives selectedModel from a legacy model id (ChatGPT provider)', () => {
    const p = migratePrefs({ model: 'gpt-5.5', blockModel: 'gpt-5.4' });
    expect(p.selectedModel).toEqual({ provider: 'chatgpt', id: 'gpt-5.5' });
    expect(p.blockSelectedModel).toEqual({ provider: 'chatgpt', id: 'gpt-5.4' });
  });

  it('derives style.difficulty from a legacy quality level', () => {
    expect(migratePrefs({ quality: 'professional' }).style).toEqual({
      difficulty: 'professional',
      naturalness: 'balanced',
    });
  });

  it('preserves an already-migrated selectedModel (no clobber)', () => {
    const p = migratePrefs({ model: 'gpt-5.5', selectedModel: { provider: 'claude', id: 'claude-sonnet-4-5' } });
    expect(p.selectedModel).toEqual({ provider: 'claude', id: 'claude-sonnet-4-5' });
  });

  it('preserves an already-migrated style (no clobber)', () => {
    const p = migratePrefs({ quality: 'college', style: { difficulty: 'professor', naturalness: 'strong' } });
    expect(p.style).toEqual({ difficulty: 'professor', naturalness: 'strong' });
  });

  it('keeps legacy fields intact (additive migration)', () => {
    const p = migratePrefs({ model: 'gpt-5.5', quality: 'highschool' });
    expect(p.model).toBe('gpt-5.5');
    expect(p.quality).toBe('highschool');
  });

  it('tolerates non-object input', () => {
    expect(migratePrefs(undefined).selectedModel?.provider).toBe('chatgpt');
  });
});
