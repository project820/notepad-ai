/**
 * Output-token budget for AI generation.
 *
 * Normal chat uses each provider's default output cap. HTML export is the one
 * place that needs a large output budget — it writes a full, self-contained HTML
 * document that is typically several times larger than the source Markdown — so it
 * requests the SELECTED model's full output capacity.
 *
 * Sizing is per provider/model:
 *  - ChatGPT (codex `/responses` backend): does NOT accept a max-output-tokens
 *    parameter — sending one is an HTTP 400 — and already streams its full native
 *    capacity, so we return `undefined` (omit the param entirely).
 *  - Claude (Messages API): max_tokens is required; we send each model's documented
 *    max output (e.g. Opus 4.1 caps at 32K — sending a flat 64K would 400).
 *  - OpenRouter: clamps to the upstream model's max; we send each model's max output.
 *
 * This module is PURE — no Electron / network imports — so the math and detection
 * are unit tested in a plain Node environment.
 */

import type { AiProviderId } from './types';

/**
 * Per-model max OUTPUT tokens, keyed by `${provider}:${id}`. Mirrors the curated
 * catalog (model-catalog.ts); keep the two in sync. Unknown / custom models fall
 * back to the per-provider default below.
 */
const MODEL_MAX_OUTPUT: Record<string, number> = {
  // Claude — each model's documented max output tokens.
  'claude:claude-sonnet-4-5': 64_000,
  'claude:claude-opus-4-1': 32_000,
  'claude:claude-haiku-4-5': 64_000,
  // OpenRouter — documented max output for each curated slug.
  'openrouter:anthropic/claude-sonnet-4.5': 64_000,
  'openrouter:google/gemini-2.5-pro': 65_536,
  'openrouter:x-ai/grok-4': 32_000,
  'openrouter:openai/gpt-5.1': 32_000,
};

/** Per-provider fallback max output for models not in {@link MODEL_MAX_OUTPUT}. */
const PROVIDER_DEFAULT_OUTPUT: Record<AiProviderId, number> = {
  chatgpt: 0, // unused — chatgpt returns undefined below
  claude: 8_192,
  openrouter: 32_000,
  // Local OpenAI-compatible servers (G002+): conservative placeholder caps until
  // per-model sizing lands. They accept a max_tokens param, so a finite default is safe.
  ollama: 8_192,
  lmstudio: 8_192,
};

/**
 * Max OUTPUT tokens to request for an HTML-export generation, sized to the SELECTED
 * model's capacity.
 *
 * Returns `undefined` for ChatGPT (its codex backend rejects a max-output-tokens
 * parameter and already emits its full native capacity). For Claude / OpenRouter it
 * returns the model's documented max output, falling back to a safe per-provider
 * default for unknown / custom models — so HTML export uses the model's full output
 * capacity without truncation, and never requests more than the model allows.
 */
export function htmlExportMaxTokens(provider: AiProviderId, modelId: string): number | undefined {
  if (provider === 'chatgpt') return undefined;
  return MODEL_MAX_OUTPUT[`${provider}:${modelId}`] ?? PROVIDER_DEFAULT_OUTPUT[provider];
}

/**
 * Best-effort max CONTEXT window (input+output tokens) per model, keyed by
 * `${provider}:${id}`. Powers the model picker's context badge and the HTML-export
 * source-size budget. Best-effort and maintained alongside the catalog; unknown /
 * custom models fall back to the per-provider default below.
 */
const MODEL_CONTEXT_WINDOW: Record<string, number> = {
  // ChatGPT (GPT-5.x) — large-context flagships.
  'chatgpt:gpt-5.5': 1_000_000,
  'chatgpt:gpt-5.4': 1_000_000,
  'chatgpt:gpt-5.4-mini': 400_000,
  // Claude 4.x.
  'claude:claude-sonnet-4-5': 200_000,
  'claude:claude-opus-4-1': 200_000,
  'claude:claude-haiku-4-5': 200_000,
  // OpenRouter slugs.
  'openrouter:anthropic/claude-sonnet-4.5': 200_000,
  'openrouter:google/gemini-2.5-pro': 1_000_000,
  'openrouter:x-ai/grok-4': 256_000,
  'openrouter:openai/gpt-5.1': 400_000,
};

/** Per-provider fallback context window for models not in {@link MODEL_CONTEXT_WINDOW}. */
const PROVIDER_DEFAULT_CONTEXT: Record<AiProviderId, number> = {
  chatgpt: 400_000,
  claude: 200_000,
  openrouter: 128_000,
  // Local providers (G002+): conservative default context window; refined per-model later.
  ollama: 32_768,
  lmstudio: 32_768,
};

/**
 * Max context window (tokens) for the given model.
 *
 * A live `ModelRef.contextWindow` (e.g. an Ollama `/api/show` value) takes
 * priority when known; otherwise we fall back to the curated table and then a
 * per-provider default — so local models report a real window when discovery
 * provides one, and a sane fallback otherwise.
 */
export function modelContextWindowTokens(
  provider: AiProviderId,
  modelId: string,
  liveContextWindow?: number,
): number {
  if (typeof liveContextWindow === 'number' && liveContextWindow > 0) return liveContextWindow;
  return MODEL_CONTEXT_WINDOW[`${provider}:${modelId}`] ?? PROVIDER_DEFAULT_CONTEXT[provider];
}

/** Human badge for a context window: `1M`, `1.5M`, `256K`. Empty for invalid input. */
export function formatContextWindow(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '';
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  return `${Math.round(tokens / 1000)}K`;
}

/**
 * Detect the HTML-export generation request by its instructions signature.
 * Mirrors the renderer's HTML_EXPORT_INSTRUCTIONS constant; a miss only means the
 * request keeps the normal output cap (safe degrade, never an error).
 */
export function isHtmlExportInstructions(instructions: unknown): boolean {
  return typeof instructions === 'string' && instructions.includes('self-contained HTML5 document');
}
