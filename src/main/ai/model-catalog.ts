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
      // Grok CLI provider reuses the OpenAI humanize engine for now (G005).
      return 'openai';
  }
}

const CURATED: ReadonlyArray<Omit<ModelRef, 'humanizeEngineId'>> = [
  // ChatGPT (subscription OAuth). Live list is also fetched at runtime.
  { provider: 'chatgpt', id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', requiresAuth: true },
  { provider: 'chatgpt', id: 'gpt-5.5', label: 'GPT-5.5', requiresAuth: true },
  { provider: 'chatgpt', id: 'gpt-5.4', label: 'GPT-5.4', requiresAuth: true },
  // Claude — CLI-first (claude -p) with API-key fallback. Every id below is
  // smoke-verified against the local CLI (docs/model-id-verification.md).
  { provider: 'claude', id: 'claude-opus-4-8', label: 'Claude Opus 4.8', requiresAuth: true },
  { provider: 'claude', id: 'claude-sonnet-5', label: 'Claude Sonnet 5', requiresAuth: true },
  { provider: 'claude', id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', requiresAuth: true },
  { provider: 'claude', id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', requiresAuth: true },
  // OpenRouter (API key) — provider/model slugs.
  { provider: 'openrouter', id: 'anthropic/claude-sonnet-4.5', label: 'Claude Sonnet 4.5 (OpenRouter)', requiresAuth: true },
  { provider: 'openrouter', id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro (OpenRouter)', requiresAuth: true },
  { provider: 'openrouter', id: 'x-ai/grok-4', label: 'Grok 4 (OpenRouter)', requiresAuth: true },
  { provider: 'openrouter', id: 'openai/gpt-5.1', label: 'GPT-5.1 (OpenRouter)', requiresAuth: true },
  // Grok (local subscription CLI — no API key; CLI-only). Default model.
  { provider: 'grok', id: 'grok', label: 'Grok (CLI)', requiresAuth: true },
];

/** The curated catalog with humanize engine ids attached. */
export function getCuratedModels(): ModelRef[] {
  return CURATED.map((m) => ({ ...m, humanizeEngineId: humanizeEngineIdForProvider(m.provider) }));
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
