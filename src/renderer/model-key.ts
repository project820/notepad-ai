/**
 * Pure (provider, id) ⇆ "provider:id" model-key serialization.
 *
 * A canonical, dependency-free helper so every surface that round-trips a model
 * selection through a single string (e.g. <select> option values, dataset
 * attributes, the HTML-export picker) uses one format. Mirrors the local helpers
 * previously inlined in html-export-wizard.ts.
 */

import { isAiProviderId, type AiProviderId } from '../main/ai/types';

export type ModelKeyParts = { provider: AiProviderId; id: string };

/** Serialize a (provider, id) selection to a `provider:id` key. */
export function modelKey(m: { provider: string; id: string }): string {
  return `${m.provider}:${m.id}`;
}

/**
 * Parse a `provider:id` key back into its parts, splitting on the FIRST colon
 * (model ids may themselves contain colons). Falls back to the `chatgpt`
 * provider when the key has no colon or names an unknown provider. Never throws.
 */
export function parseModelKey(v: string): ModelKeyParts {
  const i = v.indexOf(':');
  if (i < 0) return { provider: 'chatgpt', id: v };
  const provider = v.slice(0, i);
  const id = v.slice(i + 1);
  return { provider: isAiProviderId(provider) ? provider : 'chatgpt', id };
}
