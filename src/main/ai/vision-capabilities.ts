/**
 * vision-capabilities.ts — STRICT allowlist of models that may receive image
 * inputs directly (G005/G007 decision D2). Default is FALSE: any model not
 * explicitly verified here falls back to local OCR rather than risking an
 * HTTP 400 from sending images to a text-only endpoint.
 *
 * Pure + unit-tested. No network, no SDK calls.
 */

import type { AiProviderId } from './types';

/**
 * Verified vision-capable model id patterns per provider. Conservative on
 * purpose — we under-claim (OCR fallback) rather than over-claim. ChatGPT is
 * intentionally excluded: the app's ChatGPT path is the unofficial Codex
 * subscription backend whose image support is not contractually stable, so it
 * uses OCR fallback. Local providers (ollama/lmstudio) are always OCR-only here.
 */
const VISION_MATCHERS: Partial<Record<AiProviderId, RegExp[]>> = {
  claude: [/^claude-(?:opus|sonnet|haiku)/i, /^claude-3/i, /^claude-4/i],
  // Verified xAI vision model. Unknown/custom Grok ids remain OCR-only.
  grok: [/^grok-4\.5$/i],
  openrouter: [
    /gpt-4o/i,
    /gpt-4\.1/i,
    /gpt-5/i,
    /claude-3/i,
    /claude-(?:opus|sonnet|haiku)/i,
    /gemini-(?:1\.5|2|3)/i,
    /llama-3\.2-(?:11b|90b)-vision/i,
    /pixtral/i,
    /qwen2?-?vl/i,
  ],
};

/**
 * True only when (provider, modelId) is an explicitly verified vision model.
 * Unknown/custom ids, ChatGPT, and all local models return false (→ OCR).
 */
export function supportsVision(provider: unknown, modelId: unknown): boolean {
  if (typeof provider !== 'string' || typeof modelId !== 'string') return false;
  const matchers = VISION_MATCHERS[provider as AiProviderId];
  if (!matchers) return false;
  return matchers.some((re) => re.test(modelId));
}
