import { describe, expect, it } from 'vitest';

import {
  appendWriteReanchor,
  shouldWriteReanchor,
  toAnthropicMessages,
  toOpenAiMessages,
  WRITE_REANCHOR_SYSTEM,
} from '../main/ai/messages';

describe('Write-mode re-anchor (G003 / AC4)', () => {
  it('exposes a substantive raw-output re-anchor string', () => {
    expect(WRITE_REANCHOR_SYSTEM.length).toBeGreaterThan(40);
    expect(WRITE_REANCHOR_SYSTEM.toLowerCase()).toContain('only');
  });

  it('shouldWriteReanchor is true only for the write surface', () => {
    expect(shouldWriteReanchor('write')).toBe(true);
    expect(shouldWriteReanchor('advise')).toBe(false);
    expect(shouldWriteReanchor('html')).toBe(false);
    expect(shouldWriteReanchor('block')).toBe(false);
    expect(shouldWriteReanchor(undefined)).toBe(false);
  });

  describe('appendWriteReanchor (Anthropic system / ChatGPT instructions)', () => {
    it('appends the re-anchor for write, after the base prompt', () => {
      const out = appendWriteReanchor('BASE', 'write');
      expect(out.startsWith('BASE')).toBe(true);
      expect(out.endsWith(WRITE_REANCHOR_SYSTEM)).toBe(true);
      expect(out).toContain('\n\n');
    });

    it('returns the bare re-anchor when the base is empty', () => {
      expect(appendWriteReanchor('', 'write')).toBe(WRITE_REANCHOR_SYSTEM);
      expect(appendWriteReanchor('   ', 'write')).toBe(WRITE_REANCHOR_SYSTEM);
    });

    it('is a no-op for advise / html / block / undefined', () => {
      expect(appendWriteReanchor('BASE', 'advise')).toBe('BASE');
      expect(appendWriteReanchor('BASE', 'html')).toBe('BASE');
      expect(appendWriteReanchor('BASE', 'block')).toBe('BASE');
      expect(appendWriteReanchor('BASE', undefined)).toBe('BASE');
    });
  });

  describe('toOpenAiMessages (OpenRouter / Ollama / LM Studio)', () => {
    const history = [
      { role: 'user' as const, text: 'q1' },
      { role: 'assistant' as const, text: 'a1 (conversational advise)' },
    ];

    it('injects the re-anchor as a system turn immediately before the final user turn for write', () => {
      const msgs = toOpenAiMessages('INSTR', history, 'rewrite this', 'write');
      expect(msgs[0]).toEqual({ role: 'system', content: 'INSTR' });
      const last = msgs[msgs.length - 1];
      const penultimate = msgs[msgs.length - 2];
      expect(last).toEqual({ role: 'user', content: 'rewrite this' });
      expect(penultimate).toEqual({ role: 'system', content: WRITE_REANCHOR_SYSTEM });
    });

    it('does NOT inject the re-anchor for advise (conversational stays intact)', () => {
      const msgs = toOpenAiMessages('INSTR', history, 'what do you think?', 'advise');
      expect(msgs.some((m) => m.content === WRITE_REANCHOR_SYSTEM)).toBe(false);
      expect(msgs[msgs.length - 1]).toEqual({ role: 'user', content: 'what do you think?' });
    });

    it('does NOT inject the re-anchor when no surfaceMode is given (regression: legacy callers)', () => {
      const msgs = toOpenAiMessages('INSTR', history, 'hi');
      expect(msgs.some((m) => m.content === WRITE_REANCHOR_SYSTEM)).toBe(false);
      // shape unchanged: system, q1, a1, user
      expect(msgs).toEqual([
        { role: 'system', content: 'INSTR' },
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1 (conversational advise)' },
        { role: 'user', content: 'hi' },
      ]);
    });
  });

  describe('toAnthropicMessages (re-anchor lives in the system field, not the message array)', () => {
    it('never injects a system turn into the message array (alternation preserved)', () => {
      const msgs = toAnthropicMessages([{ role: 'user', text: 'q1' }], 'rewrite');
      expect(msgs.every((m) => m.role !== 'system')).toBe(true);
      expect(msgs.some((m) => m.content === WRITE_REANCHOR_SYSTEM)).toBe(false);
    });
  });
});
