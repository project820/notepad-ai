import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sanitizeReasoning, type ReasoningCapabilityContext } from '../main/ai/reasoning-capabilities';
import { migratePrefs } from '../renderer/prefs';
import type { AiChatRequest, AiProvider } from '../main/ai/types';
import { ProviderRegistry } from '../main/ai/provider-registry';
import { appendWriteReanchor } from '../main/ai/messages';
const auth = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
  forceRefreshAccessToken: vi.fn(),
  getStatus: vi.fn(),
}));

vi.mock('../main/codex-auth', () => ({
  getAccessToken: auth.getAccessToken,
  forceRefreshAccessToken: auth.forceRefreshAccessToken,
  getStatus: auth.getStatus,
}));


const request = (overrides: Partial<AiChatRequest> = {}): AiChatRequest => ({
  instructions: 'instructions',
  history: [],
  userText: 'message',
  model: { provider: 'chatgpt', id: 'gpt-5.6-sol' },
  ...overrides,
});

const verifiedContext = (): ReasoningCapabilityContext => ({
  featureEnabled: true,
  accountAvailableModels: new Set(['gpt-5.6-sol']),
  transportVerifiedEffortsByModel: { 'gpt-5.6-sol': ['low', 'high', 'max'] },
  snapshotGeneration: 1,
});

describe('sanitizeReasoning', () => {
  it('fails closed while the G5 feature flag is off', () => {
    const ctx = { ...verifiedContext(), featureEnabled: false };
    expect(sanitizeReasoning(request({ reasoningEffort: 'low' }), ctx).reasoningEffort).toBeUndefined();
  });

  it('strips unknown model, non-ChatGPT provider, unverified effort, and max', () => {
    expect(sanitizeReasoning(request({ model: { provider: 'chatgpt', id: 'other' }, reasoningEffort: 'low' }), verifiedContext()).reasoningEffort).toBeUndefined();
    expect(sanitizeReasoning(request({ model: { provider: 'claude', id: 'gpt-5.6-sol' }, reasoningEffort: 'low' }), verifiedContext()).reasoningEffort).toBeUndefined();
    expect(sanitizeReasoning(request({ model: { provider: 'chatgpt', id: 'unverified' }, reasoningEffort: 'low' }), verifiedContext()).reasoningEffort).toBeUndefined();
    expect(sanitizeReasoning(request({ surfaceMode: 'html', reasoningEffort: 'high' }), verifiedContext()).reasoningEffort).toBe('high');
    expect(sanitizeReasoning(request({ surfaceMode: 'html', reasoningEffort: 'low' }), verifiedContext()).reasoningEffort).toBe('low');
    expect(sanitizeReasoning(request({ reasoningEffort: 'max' }), verifiedContext()).reasoningEffort).toBeUndefined();
  });
});

describe('migratePrefs reasoning fields', () => {
  it('retains only non-Ultra effort tiers and removes every mode', () => {
    expect(migratePrefs({ reasoningEffort: 'high', reasoningMode: 'pro' }).reasoningEffort).toBe('high');
    for (const effort of ['max', 'pro', 'ultra', 'unknown']) {
      expect(migratePrefs({ reasoningEffort: effort as never }).reasoningEffort).toBeUndefined();
    }
    expect(migratePrefs({ reasoningMode: 'ultra' }).reasoningMode).toBeUndefined();
  });
});

function fakeChatGpt(captured: AiChatRequest[]): AiProvider {
  return {
    id: 'chatgpt',
    authKind: 'oauth',
    getAuthStatus: async () => ({ provider: 'chatgpt', authKind: 'oauth', connected: true, label: 'ChatGPT' }),
    listModels: async () => [],
    streamChat: async (req, onEvent) => {
      captured.push(req);
      onEvent({ kind: 'done', text: 'ok' });
    },
  };
}

describe('G5 request wiring', () => {
  let captured: AiChatRequest[];
  let registry: ProviderRegistry;

  beforeEach(() => {
    captured = [];
    registry = new ProviderRegistry({} as never, { chatgpt: fakeChatGpt(captured) });
  });

  it.each([
    ['unified', 'write'],
    ['block', 'block'],
    ['HTML export', 'html'],
  ] as const)('sends the %s request without a reasoning body while flag-off', async (_name, surfaceMode) => {
    await registry.streamProviderChat(request({ surfaceMode, reasoningEffort: 'high' }), () => {});
    expect(captured).toHaveLength(1);
    expect(JSON.stringify(captured[0])).not.toContain('reasoningEffort');
  });
  it('bumps the capability snapshot after a forced model refresh', async () => {
    const first = await registry.getReasoningCapabilities();
    await registry.getAvailableModels(true);
    const refreshed = await registry.getReasoningCapabilities();

    expect(first.featureEnabled).toBe(false);
    expect(first.models).toEqual([]);
    expect(refreshed.snapshotGeneration).toBeGreaterThan(first.snapshotGeneration);
  });

  it('never transmits max, and persisted pro mode is absent before transport', async () => {
    const prefs = migratePrefs({ reasoningEffort: 'max' as never, reasoningMode: 'pro' });
    await registry.streamProviderChat(request({ reasoningEffort: prefs.reasoningEffort }), () => {});
    expect(JSON.stringify(captured[0])).not.toContain('reasoningEffort');
    expect(prefs.reasoningMode).toBeUndefined();
  });
});
 
describe('ChatGPT exact request body after sanitization', () => {
  const expectedBody = (reasoning?: 'high', surfaceMode?: AiChatRequest['surfaceMode']) => ({
    model: 'gpt-5.6-sol',
    instructions: appendWriteReanchor('instructions', surfaceMode),
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'message' }] }],
    store: false,
    stream: true,
    ...(reasoning ? { reasoning: { effort: reasoning } } : {}),
  });

  async function streamBody(
    req: AiChatRequest,
    context?: ReasoningCapabilityContext,
  ): Promise<Record<string, unknown>> {
    auth.getStatus.mockResolvedValue({ signedIn: true });
    auth.getAccessToken.mockResolvedValue('token');
    const bodies: Record<string, unknown>[] = [];
    global.fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const { ChatGptProvider } = await import('../main/ai/chatgpt-provider');
    const registry = new ProviderRegistry(
      {} as never,
      { chatgpt: new ChatGptProvider() },
      undefined,
      undefined,
      undefined,
      context,
    );
    await registry.streamProviderChat(req, () => {});
    expect(bodies).toHaveLength(1);
    return bodies[0];
  }

  it('does not transmit unified effort when the production flag is off', async () => {
    expect(await streamBody(request({ surfaceMode: 'write', reasoningEffort: 'high' })))
      .toEqual(expectedBody(undefined, 'write'));
  });

  it('wires verified unified and Block AI efforts through to the ChatGPT body', async () => {
    expect(await streamBody(request({ surfaceMode: 'write', reasoningEffort: 'high' }), verifiedContext()))
      .toEqual(expectedBody('high', 'write'));
    expect(await streamBody(request({ surfaceMode: 'block', reasoningEffort: 'high' }), verifiedContext()))
      .toEqual(expectedBody('high', 'block'));
  });

  it('forwards HTML export effort only when the capability snapshot verifies it', async () => {
    expect(await streamBody(request({ surfaceMode: 'html', reasoningEffort: 'high' }), verifiedContext()))
      .toEqual(expectedBody('high', 'html'));
  });

  it('strips max and never transmits a pro mode', async () => {
    const req = { ...request({ surfaceMode: 'write', reasoningEffort: 'max' }), reasoningMode: 'pro' };
    const body = await streamBody(req, verifiedContext());

    expect(body).toEqual(expectedBody(undefined, 'write'));
    expect(body).not.toHaveProperty('reasoning');
    expect(body).not.toHaveProperty('reasoningMode');
  });
});
