/**
 * xai-api-provider.ts — xAI's OpenAI-compatible chat-completions transport.
 * API keys stay in ApiKeyStore; this module never exposes them to the renderer.
 */

import type { ApiKeyStore } from './api-key-store';
import { getCuratedModels } from './model-catalog';
import { toOpenAiMessages } from './messages';
import { extractOpenAiTextDelta, isOpenAiDone } from './sse';
import { streamSseChat, missingKeyError } from './stream-http';
import { supportsVision } from './vision-capabilities';
import type { AiChatEvent, AiChatRequest, AiProvider, ModelRef, ProviderAuthStatus } from './types';

export const XAI_CHAT_COMPLETIONS_URL = 'https://api.x.ai/v1/chat/completions';

export class XaiApiProvider implements AiProvider {
  readonly id = 'grok' as const;
  readonly authKind = 'api_key' as const;

  constructor(
    private keys: ApiKeyStore,
    private streamFn: typeof streamSseChat = streamSseChat,
  ) {}

  async getAuthStatus(): Promise<ProviderAuthStatus> {
    const status = await this.keys.getKeyStatus('grok');
    return {
      provider: 'grok',
      authKind: 'api_key',
      connected: status.connected,
      label: 'Grok (xAI API)',
      keyLast4: status.keyLast4,
      persisted: status.persisted,
    };
  }

  async listModels(): Promise<ModelRef[]> {
    return getCuratedModels()
      .filter((model) => model.provider === 'grok')
      .map((model) => ({ ...model, provider: 'grok' as const }));
  }

  async streamChat(req: AiChatRequest, onEvent: (event: AiChatEvent) => void): Promise<void> {
    const key = await this.keys.getApiKey('grok');
    if (!key) {
      const error = missingKeyError('xAI');
      onEvent({ kind: 'error', message: error.message, errorKind: error.errorKind });
      return;
    }

    const messages = toOpenAiMessages(
      req.instructions,
      req.history,
      req.userText,
      req.surfaceMode,
      supportsVision('grok', req.model.id) ? req.images : undefined,
    );
    await this.streamFn(
      {
        url: XAI_CHAT_COMPLETIONS_URL,
        providerLabel: 'xAI',
        signal: req.signal,
        headers: { Authorization: `Bearer ${key}` },
        body: {
          model: req.model.id,
          messages,
          stream: true,
          ...(req.maxOutputTokens ? { max_tokens: req.maxOutputTokens } : {}),
        },
        mapEvent: (payload) => {
          if (isOpenAiDone(payload)) return { delta: '', done: true };
          return { delta: extractOpenAiTextDelta(payload) };
        },
      },
      onEvent,
    );
  }
}
