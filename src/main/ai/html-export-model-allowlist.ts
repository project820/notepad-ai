/**
 * HTML export model picker allowlist (PR-M1d / §5.3, AC-M1c/d).
 *
 * The HTML export flow pins ONE route with no cross-provider fallback, so it may
 * only target the five first-party / local providers. OpenRouter is HARD-excluded
 * — unlike the general `applyModelDisplayPolicy`, this filter never re-injects a
 * current OpenRouter selection, because that provider's opaque cross-vendor routing
 * cannot honour the pinned no-fallback transport.
 *
 * Pure module. Foundation only: not wired into the live wizard picker until the
 * single cutover.
 */

import type { AiProviderId } from './types';

/** The five providers an HTML export attempt may pin (OpenRouter excluded). */
export const HTML_EXPORT_MODEL_PROVIDERS = [
  'chatgpt',
  'claude',
  'grok',
  'ollama',
  'lmstudio',
] as const satisfies readonly AiProviderId[];

type HtmlExportModelProvider = (typeof HTML_EXPORT_MODEL_PROVIDERS)[number];

/** True only for a provider the HTML export picker may offer. */
export function isHtmlExportModelProviderAllowed(
  provider: unknown,
): provider is HtmlExportModelProvider {
  return (
    typeof provider === 'string'
    && (HTML_EXPORT_MODEL_PROVIDERS as readonly string[]).includes(provider)
  );
}

/**
 * Hard-filter a model list to the HTML-export-allowed providers. A model with a
 * missing/blank provider is dropped (fail-closed) rather than defaulted, and
 * OpenRouter entries are never retained.
 */
export function filterHtmlExportModels<T extends { provider?: string }>(models: readonly T[]): T[] {
  return models.filter((model) => isHtmlExportModelProviderAllowed(model.provider));
}
