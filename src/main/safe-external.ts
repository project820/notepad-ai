/**
 * External-URL allowlist (S3). Pure and unit-tested so the main process never
 * hands an untrusted scheme (file:, javascript:, custom protocols, malformed or
 * empty strings) to `shell.openExternal`.
 */

const ALLOWED_PROTOCOLS = new Set(['https:', 'http:', 'mailto:']);

/** True only for http(s)/mailto URLs that parse cleanly. */
export function isAllowedExternalUrl(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  const value = raw.trim();
  if (value.length === 0) return false;
  try {
    const url = new URL(value);
    return ALLOWED_PROTOCOLS.has(url.protocol);
  } catch {
    return false;
  }
}
