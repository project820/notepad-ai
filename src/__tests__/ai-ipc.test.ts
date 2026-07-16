import { beforeEach, describe, expect, it, vi } from 'vitest';

const ipc = vi.hoisted(() => {
  type Handler = (event: any, payload: any) => unknown;
  const handlers = new Map<string, Handler>();
  return {
    handleTrusted: (channel: string, handler: Handler) => handlers.set(channel, handler),
    handler: (channel: string) => handlers.get(channel),
    reset: () => handlers.clear(),
  };
});

vi.mock('../main/ipc-guard', () => ({ handleTrusted: ipc.handleTrusted }));
vi.mock('electron', () => ({ dialog: { showOpenDialog: vi.fn() }, BrowserWindow: {} }));

import { registerAiIpc } from '../main/ipc/ai-ipc';

const payload = {
  id: 'chat-1',
  instructions: 'Be helpful.',
  history: [],
  userText: 'Hello',
  model: { provider: 'claude' as const, id: 'claude-sonnet' },
};

describe('registerAiIpc surface mode boundary', () => {
  const streamProviderChat = vi.fn(async () => {});
  const sender = { id: 1, send: vi.fn() };

  beforeEach(() => {
    ipc.reset();
    streamProviderChat.mockClear();
    sender.send.mockClear();
    registerAiIpc({ getRegistry: () => ({ streamProviderChat }) as never });
  });

  it('downgrades renderer-supplied html mode while preserving chat modes', async () => {
    const handler = ipc.handler('ai:chat');
    expect(handler).toBeDefined();

    await handler!({ sender }, { ...payload, surfaceMode: 'html' });
    expect(streamProviderChat).toHaveBeenLastCalledWith(
      expect.objectContaining({ surfaceMode: undefined }),
      expect.any(Function),
    );

    await handler!({ sender }, { ...payload, surfaceMode: 'write' });
    expect(streamProviderChat).toHaveBeenLastCalledWith(
      expect.objectContaining({ surfaceMode: 'write' }),
      expect.any(Function),
    );
  });
});
