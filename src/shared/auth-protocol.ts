/**
 * Renderer-safe authentication IPC contract shared by the main process,
 * preload bridge, and renderer.
 */

/** Non-secret warning code surfaced to the renderer. */
type AuthWarningCode = 'secure_storage_unavailable';

/** Non-secret authentication state surfaced to the renderer. */
export type AuthSnapshot = {
  signedIn: boolean;
  email?: string;
  plan?: string;
  expiresAt?: number;
  /** True when tokens are persisted to encrypted disk; false = memory-only (session). */
  persisted?: boolean;
  /** Non-secret warning code surfaced to the renderer. */
  warning?: AuthWarningCode;
};

/** Stable, renderer-safe error codes emitted by the device-code login flow. */
type LoginErrorCode =
  | 'device_code_request_failed'
  | 'device_code_response_invalid'
  | 'cancelled'
  | 'polling_failed'
  | 'polling_status_error'
  | 'timeout_or_incomplete_response'
  | 'token_exchange_failed'
  | 'persist_failed';

/** A progress or terminal event from the device-code login flow. */
export type LoginUpdate =
  | { kind: 'usercode'; userCode: string; verificationUri: string }
  | { kind: 'success'; auth: AuthSnapshot }
  | { kind: 'error'; code: LoginErrorCode; detail?: string };
