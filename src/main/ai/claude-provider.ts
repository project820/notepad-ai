/**
 * Claude provider — Anthropic Messages API with a BYO API key.
 * Docs: https://platform.claude.com/docs/en/api/messages
 */

import type { ApiKeyStore } from './api-key-store';
import { humanizeEngineIdForProvider } from './model-catalog';
import { toAnthropicMessages } from './messages';
import { claudeErrorMessage, extractClaudeTextDelta } from './sse';
import { streamSseChat, missingKeyError } from './stream-http';
import type { AiChatEvent, AiChatRequest, AiProvider, ModelRef, ProviderAuthStatus } from './types';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_TOKENS = 4096;

const CLAUDE_MODELS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
  { id: 'claude-opus-4-1', label: 'Claude Opus 4.1' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
];

export class ClaudeProvider implements AiProvider {
  readonly id = 'claude' as const;
  readonly authKind = 'api_key' as const;

  constructor(private keys: ApiKeyStore) {}

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
    return CLAUDE_MODELS.map((m) => ({
      provider: 'claude' as const,
      id: m.id,
      label: m.label,
      humanizeEngineId: humanizeEngineIdForProvider('claude'),
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
    const messages = toAnthropicMessages(req.history, req.userText);
    await streamSseChat(
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
          system: req.instructions,
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
