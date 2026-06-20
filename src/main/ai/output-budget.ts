/**
 * Output-token budget for AI generation.
 *
 * Normal chat uses each provider's default output cap. HTML export is the one
 * place that needs a large output budget — it writes a full, self-contained HTML
 * document that is typically several times larger than the source Markdown — so
 * it ESCALATES the output cap: up to 70% of the model's max context window,
 * clamped to the provider's supported max OUTPUT tokens (you can never stream
 * more output than the API permits, so the clamp prevents HTTP 400s).
 *
 * The escalation is scoped to HTML export only (detected from the instructions
 * signature); every other request keeps the provider default. This module is
 * PURE — no Electron / network imports — so the math and detection are unit
 * tested in a plain Node environment.
 */

import type { AiProviderId } from './types';

/** Fraction of the context window an escalated (HTML-export) request may target. */
export const HTML_EXPORT_OUTPUT_FRACTION = 0.7;

/** Best-effort max context window (tokens) per provider. */
const CONTEXT_WINDOW: Record<AiProviderId, number> = {
  chatgpt: 256_000,
  claude: 200_000,
  openrouter: 128_000,
};

/**
 * Provider-supported max OUTPUT tokens — the hard clamp. 70% of a 200K+ context
 * is far more than any provider will emit in one response, so the realized cap
 * is this ceiling. Kept conservative so we never request more output than the
 * model allows (which would 400). Raising these (e.g. Claude 128K output beta)
 * is a future change behind the relevant provider beta header.
 */
const OUTPUT_CEILING: Record<AiProviderId, number> = {
  chatgpt: 64_000,
  claude: 64_000,
  openrouter: 32_000,
};

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_OUTPUT_CEILING = 32_000;

/**
 * Escalated output cap for HTML export: 70% of the model's context window,
 * clamped to the provider's supported output ceiling.
 */
export function htmlExportMaxTokens(provider: AiProviderId): number {
  const ctx = CONTEXT_WINDOW[provider] ?? DEFAULT_CONTEXT_WINDOW;
  const ceiling = OUTPUT_CEILING[provider] ?? DEFAULT_OUTPUT_CEILING;
  return Math.min(Math.floor(ctx * HTML_EXPORT_OUTPUT_FRACTION), ceiling);
}

/**
 * Detect the HTML-export generation request by its instructions signature.
 * Mirrors the renderer's HTML_EXPORT_INSTRUCTIONS constant; a miss only means
 * the request keeps the normal output cap (safe degrade, never an error).
 */
export function isHtmlExportInstructions(instructions: unknown): boolean {
  return typeof instructions === 'string' && instructions.includes('self-contained HTML5 document');
}
