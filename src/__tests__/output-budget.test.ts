import { describe, it, expect } from 'vitest';
import {
  htmlExportMaxTokens,
  isHtmlExportInstructions,
  modelContextWindowTokens,
  formatContextWindow,
} from '../main/ai/output-budget';


describe('htmlExportMaxTokens', () => {
  it('returns undefined for ChatGPT — the codex backend rejects a max-output-tokens param', () => {
    // Sending max_output_tokens to the codex /responses backend is an HTTP 400, so
    // we must omit it entirely (it streams its full native capacity anyway).
    expect(htmlExportMaxTokens('chatgpt', 'gpt-5.5')).toBeUndefined();
    expect(htmlExportMaxTokens('chatgpt', 'gpt-5.4-mini')).toBeUndefined();
    expect(htmlExportMaxTokens('chatgpt', 'some-future-model')).toBeUndefined();
  });

  it('sizes Claude to each model\'s documented max output (Opus caps lower than Sonnet)', () => {
    expect(htmlExportMaxTokens('claude', 'claude-sonnet-4-5')).toBe(64_000);
    expect(htmlExportMaxTokens('claude', 'claude-haiku-4-5')).toBe(64_000);
    // Opus 4.1 caps at 32K — a flat 64K would 400, so per-model sizing matters.
    expect(htmlExportMaxTokens('claude', 'claude-opus-4-1')).toBe(32_000);
  });

  it('sizes OpenRouter per curated model slug', () => {
    expect(htmlExportMaxTokens('openrouter', 'anthropic/claude-sonnet-4.5')).toBe(64_000);
    expect(htmlExportMaxTokens('openrouter', 'google/gemini-2.5-pro')).toBe(65_536);
    expect(htmlExportMaxTokens('openrouter', 'x-ai/grok-4')).toBe(32_000);
  });

  it('falls back to a safe per-provider default for unknown / custom models', () => {
    expect(htmlExportMaxTokens('claude', 'claude-some-custom')).toBe(8_192);
    expect(htmlExportMaxTokens('openrouter', 'meta/llama-custom')).toBe(32_000);
  });

  it('never requests a tiny default — capped models all exceed the old 4096', () => {
    expect(htmlExportMaxTokens('claude', 'claude-sonnet-4-5')!).toBeGreaterThan(4096);
    expect(htmlExportMaxTokens('openrouter', 'google/gemini-2.5-pro')!).toBeGreaterThan(4096);
    expect(htmlExportMaxTokens('claude', 'unknown')!).toBeGreaterThan(4096);
  });

  it('uses a finite per-provider default for local providers (they accept max_tokens)', () => {
    expect(htmlExportMaxTokens('ollama', 'llama3:8b')).toBe(8_192);
    expect(htmlExportMaxTokens('lmstudio', 'qwen2.5-7b-instruct')).toBe(8_192);
    expect(htmlExportMaxTokens('ollama', 'any-model')!).toBeGreaterThan(4096);
  });
});

describe('modelContextWindowTokens', () => {
  it('returns each model\'s context window, with a per-provider fallback', () => {
    expect(modelContextWindowTokens('chatgpt', 'gpt-5.4')).toBe(1_000_000);
    expect(modelContextWindowTokens('openrouter', 'google/gemini-2.5-pro')).toBe(1_000_000);
    expect(modelContextWindowTokens('claude', 'claude-sonnet-4-5')).toBe(200_000);
    expect(modelContextWindowTokens('openrouter', 'x-ai/grok-4')).toBe(256_000);
    // Unknown/custom → provider default.
    expect(modelContextWindowTokens('claude', 'claude-future')).toBe(200_000);
    expect(modelContextWindowTokens('openrouter', 'meta/llama')).toBe(128_000);
  });

  it('falls back to a conservative per-provider default for local providers', () => {
    expect(modelContextWindowTokens('ollama', 'llama3:8b')).toBe(32_768);
    expect(modelContextWindowTokens('lmstudio', 'qwen2.5-7b-instruct')).toBe(32_768);
  });

  it('prefers a live ModelRef.contextWindow over the fallback table when known', () => {
    // A live Ollama /api/show value wins over the per-provider default…
    expect(modelContextWindowTokens('ollama', 'llama3:8b', 131_072)).toBe(131_072);
    // …and a live value even overrides a curated cloud entry.
    expect(modelContextWindowTokens('claude', 'claude-sonnet-4-5', 500_000)).toBe(500_000);
    // Non-positive / missing live values are ignored (fall back to the table).
    expect(modelContextWindowTokens('ollama', 'llama3:8b', 0)).toBe(32_768);
    expect(modelContextWindowTokens('claude', 'claude-sonnet-4-5', undefined)).toBe(200_000);
  });
});

describe('formatContextWindow', () => {
  it('formats millions as M and thousands as K', () => {
    expect(formatContextWindow(1_000_000)).toBe('1M');
    expect(formatContextWindow(1_500_000)).toBe('1.5M');
    expect(formatContextWindow(256_000)).toBe('256K');
    expect(formatContextWindow(200_000)).toBe('200K');
  });
  it('returns empty for invalid input', () => {
    expect(formatContextWindow(0)).toBe('');
    expect(formatContextWindow(-5)).toBe('');
    expect(formatContextWindow(NaN)).toBe('');
  });
});

describe('isHtmlExportInstructions', () => {
  it('matches the HTML-export instructions signature', () => {
    expect(
      isHtmlExportInstructions(
        'You are an expert front-end engineer. You output a single, complete, self-contained HTML5 document with inline CSS.',
      ),
    ).toBe(true);
  });

  it('does not match normal chat instructions', () => {
    expect(isHtmlExportInstructions('You are a helpful writing assistant.')).toBe(false);
    expect(isHtmlExportInstructions('')).toBe(false);
    expect(isHtmlExportInstructions(undefined)).toBe(false);
    expect(isHtmlExportInstructions(null)).toBe(false);
  });
});
