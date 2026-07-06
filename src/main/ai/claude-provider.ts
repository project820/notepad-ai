/**
 * Claude provider — Anthropic Messages API with a BYO API key.
 * Docs: https://platform.claude.com/docs/en/api/messages
 */

import type { ApiKeyStore } from './api-key-store';
import { getCuratedModels } from './model-catalog';
import { appendWriteReanchor, toAnthropicMessages } from './messages';
import { supportsVision } from './vision-capabilities';
import { claudeErrorMessage, extractClaudeTextDelta } from './sse';
import { streamSseChat, missingKeyError } from './stream-http';
import type { AiChatEvent, AiChatRequest, AiProvider, ModelRef, ProviderAuthStatus } from './types';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_TOKENS = 4096;

export class ClaudeProvider implements AiProvider {
  readonly id = 'claude' as const;
  readonly authKind = 'api_key' as const;

  // `streamFn` is injectable so tests can count Anthropic API calls and force
  // failures, and so a future CLI-first composition (G004) can assert the API
  // path is NOT taken when the CLI handles the request (G002 DI seam).
  constructor(
    private keys: ApiKeyStore,
    private streamFn: typeof streamSseChat = streamSseChat,
  ) {}

  async getAuthStatus(): Promise<ProviderAuthStatus> {
    const status = await this.keys.getKeyStatus('claude');
    return {
      provider: 'claude',
      authKind: 'api_key',
      connected: status.connected,
      label: 'Claude (API key)',
      keyLast4: status.keyLast4,
      persisted: status.persisted,
    };
  }

  async listModels(): Promise<ModelRef[]> {
    return getCuratedModels()
      .filter((m) => m.provider === 'claude')
      .map((m) => ({
        provider: 'claude' as const,
        id: m.id,
        label: m.label,
        humanizeEngineId: m.humanizeEngineId,
        requiresAuth: true,
      }));
  }

  async streamChat(req: AiChatRequest, onEvent: (e: AiChatEvent) => void): Promise<void> {
    const key = await this.keys.getApiKey('claude');
    if (!key) {
      const err = missingKeyError('Claude');
      onEvent({ kind: 'error', message: err.message, errorKind: err.errorKind });
      return;
    }
    const messages = toAnthropicMessages(
      req.history,
      req.userText,
      supportsVision('claude', req.model.id) ? req.images : undefined,
    );
    await this.streamFn(
      {
        url: ANTHROPIC_URL,
        providerLabel: 'Claude',
        signal: req.signal,
        headers: {
          'x-api-key': key,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: {
          model: req.model.id,
          max_tokens: req.maxOutputTokens ?? MAX_TOKENS,
          system: appendWriteReanchor(req.instructions, req.surfaceMode),
          messages,
          stream: true,
        },
        mapEvent: (payload) => {
          const error = claudeErrorMessage(payload);
          if (error) return { delta: '', error };
          // Anthropic terminates with `message_stop`; the helper also emits a
          // trailing done when the stream closes, so we don't force done here.
          return { delta: extractClaudeTextDelta(payload) };
        },
      },
      onEvent,
    );
  }
}
