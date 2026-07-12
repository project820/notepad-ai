/**
 * Shared AI provider types — the v1 multi-provider contract.
 *
 * These types are the single source of truth for the main-process provider
 * registry and the renderer. The renderer NEVER sees secret material: API keys
 * live only in the main process; status objects expose `keyLast4` at most.
 */

export type AiProviderId = 'chatgpt' | 'claude' | 'openrouter' | 'ollama' | 'lmstudio' | 'grok';

const AI_PROVIDER_IDS: readonly AiProviderId[] = ['chatgpt', 'claude', 'openrouter', 'ollama', 'lmstudio', 'grok'];

export function isAiProviderId(value: unknown): value is AiProviderId {
  return typeof value === 'string' && (AI_PROVIDER_IDS as readonly string[]).includes(value);
}

export type AuthKind = 'oauth' | 'api_key' | 'local' | 'cli';

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

export type ProviderAuthStatusCode =
  | 'claude_cli_setup_required'
  | 'claude_cli_auth_unknown'
  | 'claude_cli_login_required'
  | 'grok_cli_setup_required'
  | 'grok_cli_auth_unknown';

/** A renderer-safe provider auth status. Never contains secret material. */
export type ProviderAuthStatus = {
  provider: AiProviderId;
  authKind: AuthKind;
  connected: boolean;
  /** Active authenticated transport, distinct from the settings control capability. */
  connectionSource?: 'oauth' | 'api_key' | 'cli';
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
  /** Stable setup status code; the renderer maps it to localized user copy. */
  errorCode?: ProviderAuthStatusCode;
  /** Whether the provider CLI is installed, when independently known. */
  installed?: boolean;
  /** True when authentication cannot be verified but the provider may be usable. */
  authUnverified?: boolean;
  /** Claude's CLI transport status, independent from top-level API-key status. */
  cliStatus?: {
    installed: boolean;
    authState: 'unknown' | 'succeeded' | 'auth_failed';
    errorCode?: ProviderAuthStatusCode;
  };
};

export type ChatTurn = { role: 'user' | 'assistant'; text: string };

/** Which chat surface initiated the turn — drives Write-only output re-anchoring. */
export type SurfaceMode = 'write' | 'advise' | 'html' | 'block';
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

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

const ALLOWED_IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp'] as const;
/** Max images per turn. */
export const MAX_IMAGE_ATTACHMENTS = 4;
/** Max decoded bytes per image (8 MiB). */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const IMAGE_MAGIC: Record<AiImageAttachment['mime'], (b: Uint8Array) => boolean> = {
  'image/png': (b) =>
    b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  'image/jpeg': (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) =>
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && // "RIFF"
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50, // "WEBP"
};

/**
 * Verify a base64 image's leading bytes match its declared mime, decoding only
 * the prefix (no full decode). Stops a renderer from labelling arbitrary content
 * as image/png to smuggle it to a vision provider (G006 IPC image-magic).
 */
const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Decode the first `maxBytes` of a base64 string without any platform API. */
function decodeBase64Prefix(base64: string, maxBytes: number): Uint8Array {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of base64) {
    if (ch === '=') break;
    const v = B64_ALPHABET.indexOf(ch);
    if (v < 0) continue; // skip whitespace / stray chars
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
      if (out.length >= maxBytes) break;
    }
  }
  return Uint8Array.from(out);
}

function imageMagicMatches(base64: string, mime: AiImageAttachment['mime']): boolean {
  const prefix = decodeBase64Prefix(base64.slice(0, 32), 12);
  return IMAGE_MAGIC[mime](prefix);
}

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
    if (!imageMagicMatches(rec.base64, rec.mime as AiImageAttachment['mime'])) {
      return { ok: false, error: 'image content does not match its declared type' };
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

/** Byte/shape caps for the ai:chat IPC payload (Phase 3 input validation). */
export const CHAT_LIMITS = {
  idMax: 256,
  modelIdMax: 256,
  /** instructions carry the document context, so this is generous but bounded. */
  instructionsMax: 16 * 1024 * 1024,
  userTextMax: 4 * 1024 * 1024,
  historyMax: 2000,
  historyTotalMax: 16 * 1024 * 1024,
} as const;

/**
 * Validate the text portion of an ai:chat IPC payload (id, instructions, userText,
 * history, model.id) for type and byte bounds. TypeScript types do not survive the
 * IPC boundary, so a compromised/buggy renderer must not be able to crash the main
 * handler or force a multi-GB provider request. Pure + unit-testable.
 */
export function validateChatTextPayload(input: unknown): { ok: true } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') return { ok: false, error: 'payload must be an object' };
  const p = input as {
    id?: unknown;
    instructions?: unknown;
    userText?: unknown;
    history?: unknown;
    model?: unknown;
  };
  if (typeof p.id !== 'string' || p.id.length === 0 || p.id.length > CHAT_LIMITS.idMax) {
    return { ok: false, error: 'invalid chat id' };
  }
  if (typeof p.instructions !== 'string' || p.instructions.length > CHAT_LIMITS.instructionsMax) {
    return { ok: false, error: 'invalid or oversized instructions' };
  }
  if (typeof p.userText !== 'string' || p.userText.length > CHAT_LIMITS.userTextMax) {
    return { ok: false, error: 'invalid or oversized message' };
  }
  if (!Array.isArray(p.history)) return { ok: false, error: 'history must be an array' };
  if (p.history.length > CHAT_LIMITS.historyMax) return { ok: false, error: 'history too long' };
  let total = 0;
  for (const turn of p.history) {
    if (!turn || typeof turn !== 'object') return { ok: false, error: 'invalid history turn' };
    const t = turn as { role?: unknown; text?: unknown };
    if (t.role !== 'user' && t.role !== 'assistant') return { ok: false, error: 'invalid history role' };
    if (typeof t.text !== 'string') return { ok: false, error: 'invalid history text' };
    total += t.text.length;
    if (total > CHAT_LIMITS.historyTotalMax) return { ok: false, error: 'history too large' };
  }
  // model may be a bare string id or { provider, id } — only bound the id length here.
  if (typeof p.model === 'string') {
    if (p.model.length > CHAT_LIMITS.modelIdMax) return { ok: false, error: 'invalid model id' };
  } else if (p.model && typeof p.model === 'object') {
    const id = (p.model as { id?: unknown }).id;
    if (id !== undefined && (typeof id !== 'string' || id.length > CHAT_LIMITS.modelIdMax)) {
      return { ok: false, error: 'invalid model id' };
    }
  }
  return { ok: true };
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
  /** Optional reasoning tier; main validates it against the current capability snapshot. */
  reasoningEffort?: ReasoningEffort;
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
  /** Current-account model IDs only; excludes generic fallback catalogs. */
  listAccountModels?(): Promise<ModelRef[]>;
  /** Stream a chat completion. Emits delta/done/error via onEvent. */
  streamChat(req: AiChatRequest, onEvent: (e: AiChatEvent) => void): Promise<void>;
}
