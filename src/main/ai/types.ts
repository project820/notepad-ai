/**
 * Shared AI provider types — the v1 multi-provider contract.
 *
 * These types are the single source of truth for the main-process provider
 * registry and the renderer. The renderer NEVER sees secret material: API keys
 * live only in the main process; status objects expose `keyLast4` at most.
 */

export type AiProviderId = 'chatgpt' | 'claude' | 'openrouter';

export const AI_PROVIDER_IDS: readonly AiProviderId[] = ['chatgpt', 'claude', 'openrouter'];

export function isAiProviderId(value: unknown): value is AiProviderId {
  return typeof value === 'string' && (AI_PROVIDER_IDS as readonly string[]).includes(value);
}

export type AuthKind = 'oauth' | 'api_key';

/**
 * A selectable model. `provider` + `id` uniquely identify it. `humanizeEngineId`
 * tells the renderer which humanize engine to load when this model is selected
 * (consumed by the imnotai-embed story).
 */
export type ModelRef = {
  provider: AiProviderId;
  id: string;
  label?: string;
  humanizeEngineId: string;
  /** True when the model cannot be used until its provider is authenticated. */
  requiresAuth: boolean;
  /** True for user-entered custom model IDs (not in the curated catalog). */
  custom?: boolean;
};

/** A renderer-safe provider auth status. Never contains secret material. */
export type ProviderAuthStatus = {
  provider: AiProviderId;
  authKind: AuthKind;
  connected: boolean;
  /** Human label, e.g. "ChatGPT", "Claude (API key)". */
  label: string;
  /** Account identity for OAuth (email/plan) when available. */
  accountLabel?: string;
  /** Unix seconds expiry for OAuth tokens, when known. */
  expiresAt?: number;
  /** Last 4 chars of an API key, for "key ••••1234" display. Never the full key. */
  keyLast4?: string;
  /** Whether the key/token is persisted to disk (false = in-memory session only). */
  persisted?: boolean;
  /** Actionable error string when the last auth/use attempt failed. */
  error?: string;
};

export type ChatTurn = { role: 'user' | 'assistant'; text: string };

export type AiChatRequest = {
  instructions: string;
  history: ChatTurn[];
  userText: string;
  /** Provider+model selection. */
  model: { provider: AiProviderId; id: string };
  signal?: AbortSignal;
};

export type AiChatEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'done'; text: string }
  | { kind: 'error'; message: string; errorKind?: AiProviderErrorKind };

export type AiProviderErrorKind = 'auth' | 'rate_limit' | 'network' | 'provider' | 'cancelled';

/** Carries a classified error so the renderer can show actionable inline messages. */
export class AiProviderError extends Error {
  readonly errorKind: AiProviderErrorKind;
  constructor(errorKind: AiProviderErrorKind, message: string) {
    super(message);
    this.name = 'AiProviderError';
    this.errorKind = errorKind;
  }
}

/**
 * Map an HTTP status + provider name to a classified, actionable message.
 * Pure function — unit tested.
 */
export function classifyHttpError(
  providerLabel: string,
  status: number,
  detail?: string,
): AiProviderError {
  const trimmed = (detail ?? '').trim().slice(0, 200);
  const suffix = trimmed ? ` — ${trimmed}` : '';
  if (status === 401 || status === 403) {
    return new AiProviderError(
      'auth',
      `${providerLabel} rejected the credentials (HTTP ${status}). Check your sign-in or API key in AI settings.${suffix}`,
    );
  }
  if (status === 429) {
    return new AiProviderError(
      'rate_limit',
      `${providerLabel} is rate limiting requests (HTTP 429). Wait a moment and retry, or pick another model.${suffix}`,
    );
  }
  return new AiProviderError(
    'provider',
    `${providerLabel} request failed (HTTP ${status}).${suffix}`,
  );
}

export interface AiProvider {
  readonly id: AiProviderId;
  readonly authKind: AuthKind;
  /** Renderer-safe auth status. */
  getAuthStatus(): Promise<ProviderAuthStatus>;
  /** Curated/known models for this provider (may include live-fetched ones). */
  listModels(): Promise<ModelRef[]>;
  /** Stream a chat completion. Emits delta/done/error via onEvent. */
  streamChat(req: AiChatRequest, onEvent: (e: AiChatEvent) => void): Promise<void>;
}
