/**
 * Shared AI provider types — the v1 multi-provider contract.
 *
 * These types are the single source of truth for the main-process provider
 * registry and the renderer. The renderer NEVER sees secret material: API keys
 * live only in the main process; status objects expose `keyLast4` at most.
 */

export type AiProviderId = 'chatgpt' | 'claude' | 'openrouter' | 'ollama' | 'lmstudio';

export const AI_PROVIDER_IDS: readonly AiProviderId[] = ['chatgpt', 'claude', 'openrouter', 'ollama', 'lmstudio'];

export function isAiProviderId(value: unknown): value is AiProviderId {
  return typeof value === 'string' && (AI_PROVIDER_IDS as readonly string[]).includes(value);
}

export type AuthKind = 'oauth' | 'api_key' | 'local';

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
  /** Best-effort max context window (input+output tokens) for the model, when known. */
  contextWindow?: number;
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

/** Which chat surface initiated the turn — drives Write-only output re-anchoring. */
export type SurfaceMode = 'write' | 'advise' | 'html' | 'block';

/** A user-attached image for a multimodal turn (OCR or direct vision). */
export type AiImageAttachment = {
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  /** Base64-encoded image bytes (no data: prefix). */
  base64: string;
  /** Decoded byte length (used for the size cap). */
  bytes: number;
  /** Optional original filename, for display only. */
  name?: string;
};

export const ALLOWED_IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp'] as const;
/** Max images per turn. */
export const MAX_IMAGE_ATTACHMENTS = 4;
/** Max decoded bytes per image (8 MiB). */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Validate renderer-supplied image attachments at the IPC boundary. Pure. */
export function validateImageAttachments(
  input: unknown,
): { ok: true; images: AiImageAttachment[] } | { ok: false; error: string } {
  if (input === undefined || input === null) return { ok: true, images: [] };
  if (!Array.isArray(input)) return { ok: false, error: 'images must be an array' };
  if (input.length > MAX_IMAGE_ATTACHMENTS) {
    return { ok: false, error: `too many images (max ${MAX_IMAGE_ATTACHMENTS})` };
  }
  const images: AiImageAttachment[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') return { ok: false, error: 'invalid image entry' };
    const rec = item as { mime?: unknown; base64?: unknown; bytes?: unknown; name?: unknown };
    if (!(ALLOWED_IMAGE_MIME as readonly unknown[]).includes(rec.mime)) {
      return { ok: false, error: 'unsupported image type (png/jpeg/webp only)' };
    }
    if (typeof rec.base64 !== 'string' || rec.base64.length === 0) {
      return { ok: false, error: 'empty image data' };
    }
    if (typeof rec.bytes !== 'number' || !Number.isFinite(rec.bytes) || rec.bytes <= 0) {
      return { ok: false, error: 'invalid image size' };
    }
    if (rec.bytes > MAX_IMAGE_BYTES) {
      return { ok: false, error: `image too large (max ${Math.floor(MAX_IMAGE_BYTES / (1024 * 1024))} MiB)` };
    }
    images.push({
      mime: rec.mime as AiImageAttachment['mime'],
      base64: rec.base64,
      bytes: rec.bytes,
      name: typeof rec.name === 'string' ? rec.name.slice(0, 200) : undefined,
    });
  }
  return { ok: true, images };
}

export type AiChatRequest = {
  instructions: string;
  history: ChatTurn[];
  userText: string;
  /** Provider+model selection. */
  model: { provider: AiProviderId; id: string };
  signal?: AbortSignal;
  /** Escalated output-token cap (HTML export). Omitted → provider default. */
  maxOutputTokens?: number;
  /** Originating chat surface; 'write' re-anchors the model to raw document output. */
  surfaceMode?: SurfaceMode;
  /** Attached images for a multimodal turn (vision-direct or OCR fallback). */
  images?: AiImageAttachment[];
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
