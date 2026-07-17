import { describe, expect, it, vi } from 'vitest';

import { API_KEY_PROVIDERS, ApiKeyStore, type KeyStoreBackend } from '../main/ai/api-key-store';
import { ComposedGrokProvider } from '../main/ai/grok-composed';
import { XaiApiProvider, XAI_CHAT_COMPLETIONS_URL } from '../main/ai/xai-api-provider';
import type { CliProcess, CliSpawn } from '../main/ai/cli-runner';
import type { AiChatEvent, AiChatRequest, ModelRef, ProviderAuthStatus } from '../main/ai/types';

const request: AiChatRequest = {
  instructions: 'Be concise.',
  history: [{ role: 'assistant', text: 'Earlier.' }],
  userText: 'Hello',
  model: { provider: 'grok', id: 'grok-4.5' },
};

function keyStore(): ApiKeyStore {
  let stored: Buffer | null = null;
  const backend: KeyStoreBackend = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => value.toString(),
    readFile: async () => stored,
    writeFile: async (value) => { stored = value; },
    removeFile: async () => { stored = null; },
  };
  return new ApiKeyStore(backend);
}

function sourceStatus(connected: boolean): ProviderAuthStatus {
  return {
    provider: 'grok', authKind: 'api_key', connected, label: 'Grok (xAI API)',
  };
}

function cliStatus(installed = true): ProviderAuthStatus {
  return {
    provider: 'grok', authKind: 'cli', connected: false, label: 'Grok (CLI)',
    installed, authUnverified: installed,
    errorCode: installed ? 'grok_cli_auth_unknown' : 'grok_cli_setup_required',
  };
}

function authProbeChild(output: string): CliProcess {
  let onOutput: ((chunk: string) => void) | undefined;
  let onClose: ((code: number | null) => void) | undefined;
  const child: CliProcess = {
    stdin: { write: () => {}, end: () => {}, on: () => {} },
    stdout: { on: (_event, callback) => { onOutput = callback; } },
    stderr: { on: () => {} },
    on: (event, callback) => {
      if (event === 'close') onClose = callback as (code: number | null) => void;
    },
    kill: () => {},
  };
  queueMicrotask(() => {
    onOutput?.(output);
    onClose?.(0);
  });
  return child;
}
function delayedAuthProbeChild(): CliProcess & { complete(output: string): void } {
  let onOutput: ((chunk: string) => void) | undefined;
  let onClose: ((code: number | null) => void) | undefined;
  let completed = false;
  let bufferedOutput: string | undefined;
  // Buffer completion so listener-attach vs compl() ordering can never race:
  // on slow/loaded CI runners the probe may wire stdout/close listeners a tick
  // after complete() fires, which would otherwise drop the event and hang.
  const flush = () => {
    if (!completed) return;
    if (onOutput && bufferedOutput !== undefined) {
      onOutput(bufferedOutput);
      bufferedOutput = undefined;
    }
    onClose?.(0);
  };
  return {
    stdin: { write: () => {}, end: () => {}, on: () => {} },
    stdout: { on: (_event, callback) => { onOutput = callback; flush(); } },
    stderr: { on: () => {} },
    on: (event, callback) => {
      if (event === 'close') { onClose = callback as (code: number | null) => void; flush(); }
    },
    kill: () => {},
    complete: (output) => {
      completed = true;
      bufferedOutput = output;
      flush();
    },
  };
}

describe('ApiKeyStore Grok allowlist', () => {
  it('allows a Grok key to be stored', async () => {
    expect(API_KEY_PROVIDERS).toContain('grok');
    const keys = keyStore();
    await expect(keys.setApiKey('grok', 'xai-key-1234')).resolves.toEqual({ persisted: true });
    await expect(keys.getApiKey('grok')).resolves.toBe('xai-key-1234');
  });
});
describe('XaiApiProvider', () => {
  it('sends the exact OpenAI-compatible body and parses SSE deltas', async () => {
    const keys = keyStore();
    await keys.setApiKey('grok', 'xai-secret-1234');
    const fetchMock = vi.fn(async () => new Response(
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: {"choices":[{"delta":{"content":"!"}}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new XaiApiProvider(keys);
    const events: AiChatEvent[] = [];

    await provider.streamChat({ ...request, maxOutputTokens: 321 }, (event) => events.push(event));

    expect(fetchMock).toHaveBeenCalledWith(XAI_CHAT_COMPLETIONS_URL, expect.objectContaining({
      method: 'POST', redirect: 'error', headers: expect.objectContaining({ Authorization: 'Bearer xai-secret-1234' }),
    }));
    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sent).toEqual({
      model: 'grok-4.5', stream: true, max_tokens: 321,
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'assistant', content: 'Earlier.' },
        { role: 'user', content: 'Hello' },
      ],
    });
    expect(events).toEqual([
      { kind: 'delta', text: 'Hi' },
      { kind: 'delta', text: '!' },
      { kind: 'done', text: 'Hi!' },
    ]);
  });

  it('reports a classified missing-key error without fetching', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const events: AiChatEvent[] = [];
    await new XaiApiProvider(keyStore()).streamChat(request, (event) => events.push(event));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(events).toMatchObject([{ kind: 'error', errorKind: 'auth' }]);
  });
});

describe('ComposedGrokProvider restricted transport routing', () => {
  function harness(apiConnected: boolean, apiEvents: AiChatEvent[], models: ModelRef[] = []) {
    let apiCalls = 0;
    let cliCalls = 0;
    const api = {
      getAuthStatus: async () => sourceStatus(apiConnected),
      listModels: async () => models,
      streamChat: async (_request: AiChatRequest, onEvent: (event: AiChatEvent) => void) => {
        apiCalls++;
        apiEvents.forEach(onEvent);
      },
    } as unknown as XaiApiProvider;
    const cli = {
      getAuthStatus: async () => cliStatus(),
      listModels: async () => [],
      streamChat: async (_request: AiChatRequest, onEvent: (event: AiChatEvent) => void) => {
        cliCalls++;
        onEvent({ kind: 'delta', text: 'CLI' });
        onEvent({ kind: 'done', text: 'CLI' });
      },
    } as unknown as import('../main/ai/grok-cli-provider').GrokCliProvider;
    const provider = new ComposedGrokProvider(keyStore(), (() => { throw new Error('unused'); }) as CliSpawn, undefined, { api, cli });
    return { provider, apiCalls: () => apiCalls, cliCalls: () => cliCalls };
  }

  it('uses CLI directly with no API key and exposes independent CLI status', async () => {
    const h = harness(false, []);
    const events: AiChatEvent[] = [];
    await h.provider.streamChat(request, (event) => events.push(event));
    expect(h.apiCalls()).toBe(0);
    expect(h.cliCalls()).toBe(1);
    await expect(h.provider.getAuthStatus()).resolves.toMatchObject({
      connected: true,
      authKind: 'api_key',
      cliStatus: { installed: true, authState: 'succeeded' },
    });
  });
  it('lists composer only when an xAI API key is connected', async () => {
    const models: ModelRef[] = [
      { provider: 'grok', id: 'grok-4.5', label: 'Grok 4.5', humanizeEngineId: 'openai', requiresAuth: true },
      { provider: 'grok', id: 'grok-composer-2.5-fast', label: 'Grok Composer 2.5 Fast', humanizeEngineId: 'openai', requiresAuth: true },
    ];

    const cliOnly = await harness(false, [], models).provider.listModels();
    expect(cliOnly.map((model) => model.id)).toEqual(['grok-4.5']);
    await expect(harness(true, [], models).provider.listModels()).resolves.toEqual(models);
  });
  it('surfaces an auth error instead of forwarding composer to the CLI-only route', async () => {
    const h = harness(false, []);
    const events: AiChatEvent[] = [];

    await h.provider.streamChat({
      ...request,
      model: { provider: 'grok', id: 'grok-composer-2.5-fast' },
    }, (event) => events.push(event));

    expect(h.apiCalls()).toBe(0);
    expect(h.cliCalls()).toBe(0);
    expect(events).toEqual([{
      kind: 'error',
      message: 'grok-composer-2.5-fast requires an xAI API key.',
      errorKind: 'auth',
      errorCode: 'grok_composer_requires_api_key',
    }]);
  });
  it('forwards custom model IDs to the CLI-only route', async () => {
    const h = harness(false, []);
    const events: AiChatEvent[] = [];

    await h.provider.streamChat({
      ...request,
      model: { provider: 'grok', id: 'my-fine-tune' },
    }, (event) => events.push(event));

    expect(h.apiCalls()).toBe(0);
    expect(h.cliCalls()).toBe(1);
    expect(events).toEqual([
      { kind: 'delta', text: 'CLI' },
      { kind: 'done', text: 'CLI' },
    ]);
  });
  it('keeps the API route for composer when an xAI API key is connected', async () => {
    const h = harness(true, [
      { kind: 'delta', text: 'API' },
      { kind: 'done', text: 'API' },
    ]);
    const events: AiChatEvent[] = [];

    await h.provider.streamChat({
      ...request,
      model: { provider: 'grok', id: 'grok-composer-2.5-fast' },
    }, (event) => events.push(event));

    expect(h.apiCalls()).toBe(1);
    expect(h.cliCalls()).toBe(0);
    expect(events).toEqual([
      { kind: 'delta', text: 'API' },
      { kind: 'done', text: 'API' },
    ]);
  });
  it('keeps a confirmed logout as an auth-failed cache entry instead of fresh unknown', async () => {
    const h = harness(false, []);

    h.provider.recordCliAuthResult('auth_failed');

    await expect(h.provider.getAuthStatus()).resolves.toMatchObject({
      connected: false,
      cliStatus: { installed: true, authState: 'auth_failed' },
    });
  });
  it('does not let an earlier status probe overwrite a confirmed logout', async () => {
    const child = delayedAuthProbeChild();
    const spawn = vi.fn(() => child);
    const provider = new ComposedGrokProvider(keyStore(), spawn, async () => ({ command: '/trusted/grok' }));

    const pending = provider.getAuthStatus();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    provider.recordCliAuthResult('auth_failed');
    const joined = provider.getAuthStatus();
    child.complete('You are logged in with grok.com.\n');

    await expect(pending).resolves.toMatchObject({ cliStatus: { authState: 'auth_failed' } });
    await expect(joined).resolves.toMatchObject({ cliStatus: { authState: 'auth_failed' } });
    await expect(provider.getAuthStatus()).resolves.toMatchObject({ cliStatus: { authState: 'auth_failed' } });
  });
  it('re-probes a persisted Grok CLI session in a fresh provider instance', async () => {
    const spawn = vi.fn(() => authProbeChild('You are logged in with grok.com.\n\nAvailable models:\n'));
    const provider = new ComposedGrokProvider(
      keyStore(),
      spawn,
      async () => ({ command: '/trusted/grok' }),
    );

    const status = await provider.getAuthStatus();

    expect(spawn).toHaveBeenCalledWith('/trusted/grok', ['models'], expect.any(Object));
    expect(status).toMatchObject({
      connected: true,
      connectionSource: 'cli',
      cliStatus: { installed: true, authState: 'succeeded' },
    });
  });

  it.each([
    ['missing key', { kind: 'error', message: 'API key missing', errorKind: 'auth' }],
    ['transport unavailable', { kind: 'error', message: 'network down', errorKind: 'network' }],
    ['auth startup failure', { kind: 'error', message: 'credential rejected', errorKind: 'auth' }],
  ] as const)('falls back to CLI only for pre-output %s', async (_name, failure) => {
    const h = harness(true, [failure]);
    await h.provider.streamChat(request, () => {});
    expect(h.apiCalls()).toBe(1);
    expect(h.cliCalls()).toBe(1);
  });

  it.each([
    ['invalid model', { kind: 'error', message: 'invalid model', errorKind: 'provider' }],
    ['policy', { kind: 'error', message: 'policy denied', errorKind: 'provider' }],
    ['rate limit', { kind: 'error', message: 'slow down', errorKind: 'rate_limit' }],
  ] as const)('does not fall back for %s', async (_name, failure) => {
    const h = harness(true, [failure]);
    const events: AiChatEvent[] = [];
    await h.provider.streamChat(request, (event) => events.push(event));
    expect(h.apiCalls()).toBe(1);
    expect(h.cliCalls()).toBe(0);
    expect(events).toEqual([failure]);
  });

  it('never switches transport after an API delta', async () => {
    const h = harness(true, [
      { kind: 'delta', text: 'API' },
      { kind: 'error', message: 'network down', errorKind: 'network' },
    ]);
    await h.provider.streamChat(request, () => {});
    expect(h.apiCalls()).toBe(1);
    expect(h.cliCalls()).toBe(0);
  });

  it('does not fall back when the selected model is not shared by both transports', async () => {
    const h = harness(true, [{ kind: 'error', message: 'network down', errorKind: 'network' }]);
    await h.provider.streamChat({ ...request, model: { provider: 'grok', id: 'grok-composer-2.5-fast' } }, () => {});
    expect(h.apiCalls()).toBe(1);
    expect(h.cliCalls()).toBe(0);
  });

  it('htmlSurfaceTransport mirrors the html streamChat api/cli pick', async () => {
    const connected = harness(true, []);
    await expect(connected.provider.htmlSurfaceTransport()).resolves.toBe('api');

    const disconnected = harness(false, []);
    await expect(disconnected.provider.htmlSurfaceTransport()).resolves.toBe('cli');
  });
});
