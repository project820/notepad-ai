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

import type { AiProviderId, ProviderAuthStatus } from './types';

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

/**
 * True when a provider status is usable for the HTML-export surface's pinned
 * no-fallback transport. Fail-closed: uncertain Claude CLI readiness is not
 * capable (HTML is CLI-only for Claude; API-key-only auth is insufficient).
 */
export type HtmlExportProviderUsabilityOptions = {
  localProvidersWithModels?: ReadonlySet<AiProviderId>;
};

/**
 * Local providers report a static connected status, so they require model
 * discovery evidence before the HTML surface may offer them.
 */
export function isHtmlExportProviderUsable(
  status: ProviderAuthStatus,
  options: HtmlExportProviderUsabilityOptions = {},
): boolean {
  if (!isHtmlExportModelProviderAllowed(status.provider)) return false;
  if (status.provider === 'ollama' || status.provider === 'lmstudio') {
    return status.connected === true && options.localProvidersWithModels?.has(status.provider) === true;
  }
  if (status.provider === 'claude') {
    // Claude HTML always routes through the CLI (never the Anthropic API).
    // getAuthStatus can report connected:true for API-only auth — reject that.
    if (
      status.errorCode === 'claude_cli_setup_required'
      || status.cliStatus?.errorCode === 'claude_cli_setup_required'
    ) {
      return false;
    }
    // Pure CLI session: connectionSource is set only when CLI probe succeeded.
    if (status.connectionSource === 'cli') return true;
    // Dual API+CLI: top-level source stays 'api_key', but nested cliStatus is ready.
    if (status.cliStatus?.installed === true && status.cliStatus.authState === 'succeeded') {
      return true;
    }
    return false;
  }
  return status.connected === true;
}

/** Provider ids whose current auth status can actually run an HTML export. */
export function htmlCapableProviderIds(
  statuses: readonly ProviderAuthStatus[],
  options: HtmlExportProviderUsabilityOptions = {},
): Set<AiProviderId> {
  const capable = new Set<AiProviderId>();
  for (const status of statuses) {
    if (isHtmlExportProviderUsable(status, options)) capable.add(status.provider);
  }
  return capable;
}
