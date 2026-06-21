/**
 * ChatGPT provider — wraps the existing Codex subscription-OAuth client behind
 * the AiProvider interface. Behavior is intentionally unchanged for regression
 * safety; only the surface shape is adapted.
 *
 * NOTE: the ChatGPT Codex endpoint is an UNOFFICIAL subscription backend, not a
 * stable public API. Claude and OpenRouter are the stable BYO-key fallbacks.
 */

import { getStatus } from '../codex-auth';
import { streamChat } from '../codex-client';
import { getModels } from '../codex-models';
import { humanizeEngineIdForProvider } from './model-catalog';
import { appendWriteReanchor } from './messages';
import type { AiChatEvent, AiChatRequest, AiProvider, ModelRef, ProviderAuthStatus } from './types';

export class ChatGptProvider implements AiProvider {
  readonly id = 'chatgpt' as const;
  readonly authKind = 'oauth' as const;

  async getAuthStatus(): Promise<ProviderAuthStatus> {
    const snap = await getStatus();
    return {
      provider: 'chatgpt',
      authKind: 'oauth',
      connected: snap.signedIn,
      label: 'ChatGPT',
      accountLabel: snap.email
        ? snap.plan
          ? `${snap.email} · ${snap.plan}`
          : snap.email
        : undefined,
      expiresAt: snap.expiresAt,
      persisted: true,
    };
  }

  async listModels(): Promise<ModelRef[]> {
    const models = await getModels(false);
    return models.map((m) => ({
      provider: 'chatgpt' as const,
      id: m.id,
      label: m.label,
      humanizeEngineId: humanizeEngineIdForProvider('chatgpt'),
      requiresAuth: true,
    }));
  }

  async streamChat(req: AiChatRequest, onEvent: (e: AiChatEvent) => void): Promise<void> {
    await streamChat(
      {
        instructions: appendWriteReanchor(req.instructions, req.surfaceMode),
        history: req.history,
        userText: req.userText,
        model: req.model.id,
        signal: req.signal,
        maxOutputTokens: req.maxOutputTokens,
      },
      (e) => onEvent(e),
    );
  }
}
