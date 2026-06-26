/**
 * Main-process security gates (Phase 0 safety net). Pure, Electron-free, and
 * unit-tested so navigation/IPC trust decisions can be verified without spinning
 * up a BrowserWindow. The leader maps real Electron events (`will-navigate`,
 * `IpcMainInvokeEvent`) onto these helpers in Phase 1; nothing here imports from
 * `electron` on purpose.
 */

/**
 * Stable reason codes for denied security decisions. String codes (not a numeric
 * enum) so they survive IPC/log boundaries and read clearly in assertions.
 */
export const SECURITY_REASON = {
  /** A navigation/window-open target is not an app-owned origin. */
  NAV_UNTRUSTED_ORIGIN: 'NAV_UNTRUSTED_ORIGIN',
  /** An IPC message arrived without a verifiable sender frame. */
  IPC_UNTRUSTED_SENDER: 'IPC_UNTRUSTED_SENDER',
  /** An IPC message came from a subframe or an untrusted frame URL. */
  IPC_UNTRUSTED_FRAME: 'IPC_UNTRUSTED_FRAME',
  /** A filesystem path is outside the set of granted roots. */
  PATH_GRANT_DENIED: 'PATH_GRANT_DENIED',
  /** A preload bridge API the renderer asked for is not exposed. */
  API_NOT_EXPOSED: 'API_NOT_EXPOSED',
} as const;

/** Union of the {@link SECURITY_REASON} string codes. */
export type SecurityReason = (typeof SECURITY_REASON)[keyof typeof SECURITY_REASON];

/** Vite dev server host/port the renderer is served from in development. */
const DEV_HOST = 'localhost';
const DEV_PORT = '5173';

/** Schemes the dev server uses: the page (http) and the HMR socket (ws). */
const DEV_PROTOCOLS = new Set(['http:', 'ws:']);

/**
 * True only for an origin the app itself owns.
 *
 * - Development: exactly `http://localhost:5173` or `ws://localhost:5173`
 *   (host must be `localhost`, port must be `5173`).
 * - Production: a local `file:` URL only (the packaged renderer `index.html`),
 *   with no remote host (`file:///…` / `file://localhost/…`; `file://host/…`
 *   is rejected).
 *
 * Everything else is rejected: remote `https:`/`http:`, `data:`, `about:blank`,
 * other schemes, non-strings, malformed URLs, and any string containing
 * whitespace or control characters (the WHATWG URL parser silently strips those,
 * so they are rejected before parsing).
 */
export function isTrustedAppUrl(rawUrl: unknown, opts: { isDev: boolean }): boolean {
  if (typeof rawUrl !== 'string') return false;
  if (rawUrl.length === 0) return false;
  // Reject any C0 control char, space, or DEL anywhere. `new URL()` would
  // otherwise strip a leading space or interior tab/newline and parse a URL
  // the caller never intended (e.g. " http://localhost:5173").
  if (/[\u0000-\u0020\u007f]/.test(rawUrl)) return false;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (opts.isDev) {
    if (!DEV_PROTOCOLS.has(url.protocol)) return false;
    if (url.hostname !== DEV_HOST) return false;
    return url.port === DEV_PORT;
  }

  // Production renderer is loaded from a local file with no remote host.
  return url.protocol === 'file:' && url.hostname === '';
}

/**
 * The trust-relevant fields extracted from an Electron IPC event. The leader
 * maps a real `IpcMainInvokeEvent` onto this shape in Phase 1; this validator
 * stays pure so the trust logic is testable on its own.
 */
export type TrustedSenderShape = {
  /** Whether `event.senderFrame` exists (a verifiable origin frame). */
  hasSenderFrame: boolean;
  /** Whether the sender is the top-level (main) frame, not a subframe. */
  isMainFrame: boolean;
  /** The sender frame's URL, or `null` when unavailable. */
  frameUrl: string | null;
};

/**
 * Validate that an IPC message came from the app's own top-level frame.
 *
 * Requires all of: a present sender frame, the main (top-level) frame, and a
 * frame URL that passes {@link isTrustedAppUrl}. On failure returns the most
 * specific reason: {@link SECURITY_REASON.IPC_UNTRUSTED_SENDER} when there is no
 * sender frame, otherwise {@link SECURITY_REASON.IPC_UNTRUSTED_FRAME} for a
 * subframe or an untrusted frame URL.
 */
export function assertTrustedSenderShape(
  shape: TrustedSenderShape,
  opts: { isDev: boolean },
): { ok: true } | { ok: false; reason: string } {
  if (!shape.hasSenderFrame) {
    return { ok: false, reason: SECURITY_REASON.IPC_UNTRUSTED_SENDER };
  }
  if (!shape.isMainFrame) {
    return { ok: false, reason: SECURITY_REASON.IPC_UNTRUSTED_FRAME };
  }
  if (!isTrustedAppUrl(shape.frameUrl, opts)) {
    return { ok: false, reason: SECURITY_REASON.IPC_UNTRUSTED_FRAME };
  }
  return { ok: true };
}
