import { describe, it, expect } from 'vitest';
import {
  HTML_EXPORT_OUTPUT_FRACTION,
  htmlExportMaxTokens,
  isHtmlExportInstructions,
} from '../main/ai/output-budget';

describe('htmlExportMaxTokens', () => {
  it('targets 70% of context but clamps to the provider output ceiling', () => {
    // 70% of 200K = 140K, clamped to Claude's 64K output ceiling.
    expect(htmlExportMaxTokens('claude')).toBe(64_000);
    // 70% of 256K = 179.2K, clamped to 64K.
    expect(htmlExportMaxTokens('chatgpt')).toBe(64_000);
    // 70% of 128K = 89.6K, clamped to 32K.
    expect(htmlExportMaxTokens('openrouter')).toBe(32_000);
  });

  it('exposes the 70% fraction constant', () => {
    expect(HTML_EXPORT_OUTPUT_FRACTION).toBe(0.7);
  });

  it('is always far above the old 4096 default and never below it', () => {
    for (const p of ['chatgpt', 'claude', 'openrouter'] as const) {
      expect(htmlExportMaxTokens(p)).toBeGreaterThan(4096);
    }
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
