/**
 * Built-in curated model catalog.
 *
 * Model IDs can go stale when providers deprecate them. The renderer therefore
 * also offers a custom model-ID text input (see `makeCustomModel`) so users are
 * never locked out by an outdated catalog entry.
 *
 * Provider docs (verify IDs during maintenance):
 * - Anthropic Messages API: https://platform.claude.com/docs/en/api/messages
 * - OpenRouter chat completions: https://openrouter.ai/docs/api-reference/chat-completion
 */

import { applyModelDisplayPolicy } from './model-display-policy';
import type { AiProviderId, ModelRef } from './types';

/** Humanize engine id bound to a provider (consumed by imnotai-embed). */
export function humanizeEngineIdForProvider(provider: AiProviderId): string {
  switch (provider) {
    case 'chatgpt':
      return 'openai';
    case 'claude':
      return 'claude';
    case 'openrouter':
      return 'openrouter';
    case 'ollama':
    case 'lmstudio':
      // Local OpenAI-compatible servers reuse the OpenAI humanize engine for now.
      return 'openai';
    case 'grok':
      // xAI's OpenAI-compatible API and the Grok CLI use the OpenAI engine.
      return 'openai';
  }
}

const CURATED: ReadonlyArray<Omit<ModelRef, 'humanizeEngineId'>> = [
  // ChatGPT (subscription OAuth). Live list is also fetched at runtime.
  { provider: 'chatgpt', id: 'gpt-5.6', label: 'GPT-5.6', requiresAuth: true },
  { provider: 'chatgpt', id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', requiresAuth: true },
  { provider: 'chatgpt', id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', requiresAuth: true },
  { provider: 'chatgpt', id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', requiresAuth: true },
  { provider: 'chatgpt', id: 'gpt-5.5', label: 'GPT-5.5', requiresAuth: true },
  // Claude — CLI-first (claude -p) with API-key fallback.
  { provider: 'claude', id: 'claude-opus-4-8', label: 'Claude Opus 4.8', requiresAuth: true },
  { provider: 'claude', id: 'claude-sonnet-5', label: 'Claude Sonnet 5', requiresAuth: true },
  { provider: 'claude', id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', requiresAuth: true },
  { provider: 'claude', id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', requiresAuth: true },
  // Grok — xAI API primary with a local CLI fallback.
  { provider: 'grok', id: 'grok-4.5', label: 'Grok 4.5', requiresAuth: true },
  { provider: 'grok', id: 'grok-composer-2.5-fast', label: 'Grok Composer 2.5 Fast', requiresAuth: true },
];

/** The curated catalog with humanize engine ids attached. */
export function getCuratedModels(): ModelRef[] {
  return applyModelDisplayPolicy(
    CURATED.map((m) => ({ ...m, humanizeEngineId: humanizeEngineIdForProvider(m.provider) })),
  );
}

/** Build a ModelRef for a user-entered custom model id. */
export function makeCustomModel(provider: AiProviderId, id: string, label?: string): ModelRef {
  const trimmed = id.trim();
  return {
    provider,
    id: trimmed,
    label: label?.trim() || trimmed,
    humanizeEngineId: humanizeEngineIdForProvider(provider),
    requiresAuth: true,
    custom: true,
  };
}

/** True when (provider,id) is present in the supplied catalog. */
export function isKnownModel(catalog: ModelRef[], provider: AiProviderId, id: string): boolean {
  return catalog.some((m) => m.provider === provider && m.id === id);
}

/**
 * Resolve a (provider,id) selection to a ModelRef. Falls back to a custom model
 * ref when the id is not in the curated catalog (avoids lockout on stale ids).
 */
export function resolveModelRef(
  catalog: ModelRef[],
  provider: AiProviderId,
  id: string,
): ModelRef {
  const found = catalog.find((m) => m.provider === provider && m.id === id);
  return found ?? makeCustomModel(provider, id);
}
