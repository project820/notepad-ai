/**
 * LM Studio provider — local models via LM Studio's OpenAI-compatible server.
 * Docs: https://lmstudio.ai/docs/app/api/endpoints/openai
 *
 * LM Studio is a LOCAL discovery surface, not an auth provider:
 *  - `getAuthStatus()` never touches the network — it always reports a static,
 *    auth-agnostic connected status. Server reachability is modeled only by an
 *    empty `listModels()` and a `network` chat error, never by auth status.
 *  - `listModels()` reads `/v1/models` (loaded models) under a 500ms hard
 *    timeout, returning `[]` on any failure (offline/slow).
 *  - `streamChat()` reuses the OpenAI-compatible SSE path (`/v1/chat/completions`).
 */

import { humanizeEngineIdForProvider } from './model-catalog';
import { toOpenAiMessages } from './messages';
import { extractOpenAiTextDelta, isOpenAiDone } from './sse';
import { streamSseChat } from './stream-http';
import {
  DEFAULT_LMSTUDIO_BASE_URL,
  getLocalJson,
  withLocalTimeout,
} from './local-config';
import type { AiChatEvent, AiChatRequest, AiProvider, ModelRef, ProviderAuthStatus } from './types';

type LmStudioModelsResponse = { data?: Array<{ id?: unknown }> };

export class LmStudioProvider implements AiProvider {
  readonly id = 'lmstudio' as const;
  readonly authKind = 'local' as const;

  constructor(private getBaseUrl: () => string | Promise<string> = () => DEFAULT_LMSTUDIO_BASE_URL) {}

  private async resolveBaseUrl(): Promise<string> {
    return (await this.getBaseUrl()) || DEFAULT_LMSTUDIO_BASE_URL;
  }

  async getAuthStatus(): Promise<ProviderAuthStatus> {
    // Static, network-free: local is discovery, not auth.
    return { provider: 'lmstudio', authKind: 'local', connected: true, label: 'LM Studio' };
  }

  async listModels(): Promise<ModelRef[]> {
    const baseUrl = await this.resolveBaseUrl();
    try {
      const data = await withLocalTimeout((signal) =>
        getLocalJson<LmStudioModelsResponse>(`${baseUrl}/v1/models`, signal),
      );
      const entries = Array.isArray(data?.data) ? data.data : [];
      return entries
        .map((m) => m?.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
        .map((id) => ({
          provider: 'lmstudio' as const,
          id,
          label: id,
          humanizeEngineId: humanizeEngineIdForProvider('lmstudio'),
          requiresAuth: false,
        }));
    } catch {
      return [];
    }
  }

  async streamChat(req: AiChatRequest, onEvent: (e: AiChatEvent) => void): Promise<void> {
    const baseUrl = await this.resolveBaseUrl();
    const messages = toOpenAiMessages(req.instructions, req.history, req.userText, req.surfaceMode);
    await streamSseChat(
      {
        url: `${baseUrl}/v1/chat/completions`,
        providerLabel: 'LM Studio',
        signal: req.signal,
        headers: {},
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
