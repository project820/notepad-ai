import { describe, it, expect, vi } from 'vitest';

import { ClaudeProvider } from '../main/ai/claude-provider';
import type { ApiKeyStore } from '../main/ai/api-key-store';
import type { AiChatEvent, AiChatRequest } from '../main/ai/types';

// G002 — DI seam: ClaudeProvider accepts an injectable stream function so tests
// (and the future CLI-first composition) can count Anthropic API calls and force
// failures without hitting the network.

function keyStore(key: string | null): ApiKeyStore {
  return {
    getApiKey: vi.fn(async () => key),
    getKeyStatus: vi.fn(async () => ({ connected: key != null, keyLast4: key?.slice(-4), persisted: true })),
  } as unknown as ApiKeyStore;
}

const req: AiChatRequest = {
  id: 'r1',
  instructions: 'sys',
  history: [],
  userText: 'hi',
  model: { provider: 'claude', id: 'claude-sonnet-4-5' },
} as unknown as AiChatRequest;

describe('ClaudeProvider DI seam (G002)', () => {
  it('routes through the injected streamFn exactly once when a key is present', async () => {
    const streamFn = vi.fn(async (_args: unknown, onEvent: (e: AiChatEvent) => void) => {
      onEvent({ kind: 'delta', text: 'A' });
      onEvent({ kind: 'done', text: 'A' });
    });
    const provider = new ClaudeProvider(keyStore('sk-claude-1234'), streamFn as never);
    const events: AiChatEvent[] = [];
    await provider.streamChat(req, (e) => events.push(e));

    expect(streamFn).toHaveBeenCalledTimes(1);
    expect(events.map((e) => e.kind)).toContain('done');
  });

  it('does NOT call the API stream when no key is configured (auth error instead)', async () => {
    const streamFn = vi.fn(async () => {});
    const provider = new ClaudeProvider(keyStore(null), streamFn as never);
    const events: AiChatEvent[] = [];
    await provider.streamChat(req, (e) => events.push(e));

    expect(streamFn).not.toHaveBeenCalled(); // API call count == 0 on the no-key path
    expect(events.some((e) => e.kind === 'error')).toBe(true);
  });

  it('surfaces a forced API failure from the injected streamFn', async () => {
    const streamFn = vi.fn(async (_args: unknown, onEvent: (e: AiChatEvent) => void) => {
      onEvent({ kind: 'error', message: 'overloaded', errorKind: 'provider' });
    });
    const provider = new ClaudeProvider(keyStore('sk-claude-1234'), streamFn as never);
    const events: AiChatEvent[] = [];
    await provider.streamChat(req, (e) => events.push(e));

    expect(streamFn).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.kind === 'error' && e.message === 'overloaded')).toBe(true);
  });
});
