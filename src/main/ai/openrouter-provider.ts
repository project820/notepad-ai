/**
 * OpenRouter provider — OpenAI-compatible chat completions with a BYO API key.
 * Docs: https://openrouter.ai/docs/api-reference/chat-completion
 *
 * OpenRouter exposes Gemini/Grok/many models via one key, so it is the v1 path
 * for non-OpenAI/non-Claude models (native Gemini/Grok OAuth is post-v1).
 */

import type { ApiKeyStore } from './api-key-store';
import { getCuratedModels } from './model-catalog';
import { toOpenAiMessages } from './messages';
import { supportsVision } from './vision-capabilities';
import { extractOpenAiTextDelta, isOpenAiDone } from './sse';
import { streamSseChat, missingKeyError } from './stream-http';
import type { AiChatEvent, AiChatRequest, AiProvider, ModelRef, ProviderAuthStatus } from './types';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export class OpenRouterProvider implements AiProvider {
  readonly id = 'openrouter' as const;
  readonly authKind = 'api_key' as const;

  constructor(private keys: ApiKeyStore) {}

  async getAuthStatus(): Promise<ProviderAuthStatus> {
    const status = await this.keys.getKeyStatus('openrouter');
    return {
      provider: 'openrouter',
      authKind: 'api_key',
      connected: status.connected,
      label: 'OpenRouter (API key)',
      keyLast4: status.keyLast4,
      persisted: status.persisted,
    };
  }

  async listModels(): Promise<ModelRef[]> {
    return getCuratedModels()
      .filter((m) => m.provider === 'openrouter')
      .map((m) => ({
        provider: 'openrouter' as const,
        id: m.id,
        label: m.label,
        humanizeEngineId: m.humanizeEngineId,
        requiresAuth: true,
      }));
  }

  async streamChat(req: AiChatRequest, onEvent: (e: AiChatEvent) => void): Promise<void> {
    const key = await this.keys.getApiKey('openrouter');
    if (!key) {
      const err = missingKeyError('OpenRouter');
      onEvent({ kind: 'error', message: err.message, errorKind: err.errorKind });
      return;
    }
    const messages = toOpenAiMessages(
      req.instructions,
      req.history,
      req.userText,
      req.surfaceMode,
      supportsVision('openrouter', req.model.id) ? req.images : undefined,
    );
    await streamSseChat(
      {
        url: OPENROUTER_URL,
        providerLabel: 'OpenRouter',
        signal: req.signal,
        headers: {
          Authorization: `Bearer ${key}`,
          'HTTP-Referer': 'https://github.com/notepad-ai/notepad-ai',
          'X-Title': 'Notepad AI',
        },
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
