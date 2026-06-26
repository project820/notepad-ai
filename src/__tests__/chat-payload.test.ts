/**
 * chat-payload.test.ts — ai:chat IPC payload validation (Phase 3, H-15).
 *
 * Types do not survive the IPC boundary, so the main handler validates the
 * renderer-supplied payload before allocating a provider stream. These cover the
 * shape/byte bounds and that a normal payload passes.
 */

import { describe, it, expect } from 'vitest';
import { validateChatTextPayload, CHAT_LIMITS } from '../main/ai/types';

const ok = {
  id: 'chat-1',
  instructions: 'You are helpful.',
  userText: 'hello',
  history: [
    { role: 'user', text: 'hi' },
    { role: 'assistant', text: 'hey' },
  ],
  model: { provider: 'claude', id: 'claude-x' },
};

describe('validateChatTextPayload', () => {
  it('accepts a well-formed payload (object model, string model, no model)', () => {
    expect(validateChatTextPayload(ok)).toEqual({ ok: true });
    expect(validateChatTextPayload({ ...ok, model: 'gpt-x' })).toEqual({ ok: true });
    expect(validateChatTextPayload({ ...ok, model: undefined })).toEqual({ ok: true });
  });

  it('rejects a non-object payload', () => {
    for (const v of [null, undefined, 'x', 42, []]) {
      expect(validateChatTextPayload(v).ok).toBe(false);
    }
  });

  it('rejects a missing/empty/oversized id', () => {
    expect(validateChatTextPayload({ ...ok, id: '' }).ok).toBe(false);
    expect(validateChatTextPayload({ ...ok, id: 123 }).ok).toBe(false);
    expect(validateChatTextPayload({ ...ok, id: 'x'.repeat(CHAT_LIMITS.idMax + 1) }).ok).toBe(false);
  });

  it('rejects non-string or oversized instructions / userText', () => {
    expect(validateChatTextPayload({ ...ok, instructions: 5 }).ok).toBe(false);
    expect(validateChatTextPayload({ ...ok, instructions: 'x'.repeat(CHAT_LIMITS.instructionsMax + 1) }).ok).toBe(false);
    expect(validateChatTextPayload({ ...ok, userText: {} }).ok).toBe(false);
    expect(validateChatTextPayload({ ...ok, userText: 'x'.repeat(CHAT_LIMITS.userTextMax + 1) }).ok).toBe(false);
  });

  it('rejects a non-array, too-long, or malformed history', () => {
    expect(validateChatTextPayload({ ...ok, history: 'nope' }).ok).toBe(false);
    expect(
      validateChatTextPayload({ ...ok, history: Array.from({ length: CHAT_LIMITS.historyMax + 1 }, () => ({ role: 'user', text: 'x' })) }).ok,
    ).toBe(false);
    expect(validateChatTextPayload({ ...ok, history: [{ role: 'system', text: 'x' }] }).ok).toBe(false);
    expect(validateChatTextPayload({ ...ok, history: [{ role: 'user', text: 5 }] }).ok).toBe(false);
    expect(validateChatTextPayload({ ...ok, history: [null] }).ok).toBe(false);
  });

  it('rejects an oversized total history payload', () => {
    const big = { role: 'user' as const, text: 'x'.repeat(1024 * 1024) };
    const history = Array.from({ length: 20 }, () => ({ ...big }));
    expect(validateChatTextPayload({ ...ok, history }).ok).toBe(false);
  });

  it('rejects an oversized model id', () => {
    expect(validateChatTextPayload({ ...ok, model: 'x'.repeat(CHAT_LIMITS.modelIdMax + 1) }).ok).toBe(false);
    expect(validateChatTextPayload({ ...ok, model: { provider: 'claude', id: 'x'.repeat(CHAT_LIMITS.modelIdMax + 1) } }).ok).toBe(false);
  });
});
