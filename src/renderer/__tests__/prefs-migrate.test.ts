// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';

import { loadPrefs, migratePrefs, savePrefs } from '../prefs';
beforeEach(() => {
  localStorage.clear();
});

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
    const p = migratePrefs({ model: 'gpt-5.5', selectedModel: { provider: 'claude', id: 'claude-sonnet-4-6' } });
    expect(p.selectedModel).toEqual({ provider: 'claude', id: 'claude-sonnet-4-6' });
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

  it('preserves an already-migrated blockSelectedModel (no clobber)', () => {
    const p = migratePrefs({ blockModel: 'gpt-5.5', blockSelectedModel: { provider: 'openrouter', id: 'x-ai/grok-4' } });
    expect(p.blockSelectedModel).toEqual({ provider: 'openrouter', id: 'x-ai/grok-4' });
  });

  it('preserves selectedModel and blockSelectedModel together', () => {
    const p = migratePrefs({
      selectedModel: { provider: 'claude', id: 'claude-opus-4-8' },
      blockSelectedModel: { provider: 'claude', id: 'claude-haiku-4-5' },
    });
    expect(p.selectedModel).toEqual({ provider: 'claude', id: 'claude-opus-4-8' });
    expect(p.blockSelectedModel).toEqual({ provider: 'claude', id: 'claude-haiku-4-5' });
  });

  it('accepts a local provider selection (widened provider union)', () => {
    const p = migratePrefs({ selectedModel: { provider: 'ollama', id: 'llama3.1' } });
    expect(p.selectedModel).toEqual({ provider: 'ollama', id: 'llama3.1' });
  });

  it('preserves workspaceRoot and leaves it unset by default', () => {
    expect(migratePrefs(null).workspaceRoot).toBeUndefined();
    expect(migratePrefs({ workspaceRoot: '/home/u/notes' }).workspaceRoot).toBe('/home/u/notes');
  });
});
describe('savePrefs', () => {
  it('merges a local field change with a newer change from another window', () => {
    const local = loadPrefs();
    localStorage.setItem(
      'notepad-ai:prefs:v1',
      JSON.stringify({ ...local, fontSize: 'lg' }),
    );

    local.theme = 'dark';
    savePrefs(local);

    expect(loadPrefs()).toMatchObject({ theme: 'dark', fontSize: 'lg' });
  });
});

describe('migratePrefs — stale Claude id remap (PR-1 Bug B)', () => {
  it('remaps stale claude ids across selectedModel, blockSelectedModel, and htmlModel', () => {
    const p = migratePrefs({
      selectedModel: { provider: 'claude', id: 'claude-sonnet-4-5' },
      blockSelectedModel: { provider: 'claude', id: 'claude-opus-4-1' },
      htmlModel: { provider: 'claude', id: 'claude-sonnet-4-5' },
    });
    expect(p.selectedModel).toEqual({ provider: 'claude', id: 'claude-sonnet-4-6' });
    expect(p.blockSelectedModel).toEqual({ provider: 'claude', id: 'claude-opus-4-8' });
    expect(p.htmlModel).toEqual({ provider: 'claude', id: 'claude-sonnet-4-6' });
  });

  it('remaps claude-opus-4-1 -> claude-opus-4-8', () => {
    expect(
      migratePrefs({ selectedModel: { provider: 'claude', id: 'claude-opus-4-1' } }).selectedModel,
    ).toEqual({ provider: 'claude', id: 'claude-opus-4-8' });
  });

  it('leaves verified/current claude ids unchanged', () => {
    const p = migratePrefs({
      selectedModel: { provider: 'claude', id: 'claude-opus-4-8' },
      blockSelectedModel: { provider: 'claude', id: 'claude-haiku-4-5' },
      htmlModel: { provider: 'claude', id: 'claude-sonnet-4-6' },
    });
    expect(p.selectedModel).toEqual({ provider: 'claude', id: 'claude-opus-4-8' });
    expect(p.blockSelectedModel).toEqual({ provider: 'claude', id: 'claude-haiku-4-5' });
    expect(p.htmlModel).toEqual({ provider: 'claude', id: 'claude-sonnet-4-6' });
  });

  it('preserves unknown / custom claude ids (no lockout)', () => {
    const p = migratePrefs({ selectedModel: { provider: 'claude', id: 'claude-experimental-9' } });
    expect(p.selectedModel).toEqual({ provider: 'claude', id: 'claude-experimental-9' });
  });

  it('never remaps OpenRouter selections (incl. the anthropic/claude-sonnet-4.5 slug)', () => {
    const p = migratePrefs({
      selectedModel: { provider: 'openrouter', id: 'anthropic/claude-sonnet-4.5' },
      htmlModel: { provider: 'openrouter', id: 'anthropic/claude-sonnet-4.5' },
    });
    expect(p.selectedModel).toEqual({ provider: 'openrouter', id: 'anthropic/claude-sonnet-4.5' });
    expect(p.htmlModel).toEqual({ provider: 'openrouter', id: 'anthropic/claude-sonnet-4.5' });
  });

  it('leaves non-claude (chatgpt) selections untouched', () => {
    const p = migratePrefs({ selectedModel: { provider: 'chatgpt', id: 'gpt-5.5' } });
    expect(p.selectedModel).toEqual({ provider: 'chatgpt', id: 'gpt-5.5' });
  });

  it('leaves htmlModel unset when absent', () => {
    expect(
      migratePrefs({ selectedModel: { provider: 'claude', id: 'claude-opus-4-8' } }).htmlModel,
    ).toBeUndefined();
  });
});
