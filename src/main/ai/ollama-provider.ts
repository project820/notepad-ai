/**
 * Ollama provider — local models via the Ollama HTTP API.
 * Docs: https://github.com/ollama/ollama/blob/main/docs/api.md
 *
 * Ollama is a LOCAL discovery surface, not an auth provider:
 *  - `getAuthStatus()` never touches the network — it always reports a static,
 *    auth-agnostic connected status. Server reachability is modeled only by an
 *    empty `listModels()` and a `network` chat error, never by auth status.
 *  - `listModels()` reads `/api/tags` (+ best-effort `/api/show` context length)
 *    under a 500ms hard timeout, returning `[]` on any failure (offline/slow).
 *  - `streamChat()` POSTs `/api/chat` and parses the NDJSON stream.
 */

import { humanizeEngineIdForProvider } from './model-catalog';
import { toOpenAiMessages } from './messages';
import { streamNdjsonChat } from './stream-http';
import {
  DEFAULT_OLLAMA_BASE_URL,
  getLocalJson,
  withLocalTimeout,
} from './local-config';
import type { AiChatEvent, AiChatRequest, AiProvider, ModelRef, ProviderAuthStatus } from './types';

/** Best-effort concurrency for optional `/api/show` context-window lookups. */
const SHOW_CONCURRENCY = 4;

type OllamaTagsResponse = { models?: Array<{ name?: unknown }> };

/** Extract the text delta from one Ollama `/api/chat` NDJSON line. Pure. */
export function extractOllamaChatDelta(line: string): string {
  try {
    const evt = JSON.parse(line);
    const content = evt?.message?.content;
    return typeof content === 'string' ? content : '';
  } catch {
    return '';
  }
}

/** Terminal-error message from one Ollama NDJSON line, or null. Pure. */
export function ollamaChatErrorMessage(line: string): string | null {
  try {
    const evt = JSON.parse(line);
    return typeof evt?.error === 'string' && evt.error ? evt.error : null;
  } catch {
    return null;
  }
}

/** True when an Ollama NDJSON line signals stream completion. Pure. */
export function isOllamaChatDone(line: string): boolean {
  try {
    return JSON.parse(line)?.done === true;
  } catch {
    return false;
  }
}

/**
 * Pull a context length out of an `/api/show` response. Ollama keys it by
 * architecture, e.g. `model_info["llama.context_length"]`. Pure, best-effort.
 */
export function extractOllamaContextLength(info: unknown): number | undefined {
  const modelInfo = (info as { model_info?: unknown })?.model_info;
  if (modelInfo && typeof modelInfo === 'object') {
    for (const [key, value] of Object.entries(modelInfo as Record<string, unknown>)) {
      if (key.endsWith('.context_length') && typeof value === 'number' && value > 0) return value;
    }
  }
  return undefined;
}

export class OllamaProvider implements AiProvider {
  readonly id = 'ollama' as const;
  readonly authKind = 'local' as const;

  constructor(private getBaseUrl: () => string | Promise<string> = () => DEFAULT_OLLAMA_BASE_URL) {}

  private async resolveBaseUrl(): Promise<string> {
    return (await this.getBaseUrl()) || DEFAULT_OLLAMA_BASE_URL;
  }

  async getAuthStatus(): Promise<ProviderAuthStatus> {
    // Static, network-free: local is discovery, not auth.
    return { provider: 'ollama', authKind: 'local', connected: true, label: 'Ollama' };
  }

  async listModels(): Promise<ModelRef[]> {
    const baseUrl = await this.resolveBaseUrl();
    let names: string[];
    try {
      const data = await withLocalTimeout((signal) =>
        getLocalJson<OllamaTagsResponse>(`${baseUrl}/api/tags`, signal),
      );
      names = Array.isArray(data?.models)
        ? data.models
            .map((m) => m?.name)
            .filter((n): n is string => typeof n === 'string' && n.length > 0)
        : [];
    } catch {
      return [];
    }
    if (names.length === 0) return [];
    const contextByName = await this.fetchContextWindows(baseUrl, names);
    return names.map((name) => {
      const contextWindow = contextByName.get(name);
      return {
        provider: 'ollama' as const,
        id: name,
        label: name,
        humanizeEngineId: humanizeEngineIdForProvider('ollama'),
        requiresAuth: false,
        ...(contextWindow ? { contextWindow } : {}),
      };
    });
  }

  /** Best-effort context-window enrichment via `/api/show`; failures are ignored. */
  private async fetchContextWindows(baseUrl: string, names: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    let index = 0;
    const worker = async (): Promise<void> => {
      while (index < names.length) {
        const name = names[index++];
        try {
          const info = await withLocalTimeout((signal) =>
            getLocalJson<unknown>(`${baseUrl}/api/show`, signal, {
              method: 'POST',
              // Send both keys: newer Ollama expects `model`, older uses `name`.
              body: JSON.stringify({ model: name, name }),
            }),
          );
          const ctx = extractOllamaContextLength(info);
          if (ctx) result.set(name, ctx);
        } catch {
          /* best-effort: model still lists without a context badge */
        }
      }
    };
    const workers = Array.from({ length: Math.min(SHOW_CONCURRENCY, names.length) }, worker);
    await Promise.all(workers);
    return result;
  }

  async streamChat(req: AiChatRequest, onEvent: (e: AiChatEvent) => void): Promise<void> {
    const baseUrl = await this.resolveBaseUrl();
    const messages = toOpenAiMessages(req.instructions, req.history, req.userText);
    await streamNdjsonChat(
      {
        url: `${baseUrl}/api/chat`,
        providerLabel: 'Ollama',
        signal: req.signal,
        headers: {},
        body: {
          model: req.model.id,
          messages,
          stream: true,
          ...(req.maxOutputTokens ? { options: { num_predict: req.maxOutputTokens } } : {}),
        },
        mapLine: (line) => {
          const error = ollamaChatErrorMessage(line);
          if (error) return { delta: '', error };
          return { delta: extractOllamaChatDelta(line), done: isOllamaChatDone(line) };
        },
      },
      onEvent,
    );
  }
}
