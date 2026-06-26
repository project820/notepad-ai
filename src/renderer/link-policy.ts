/**
 * link-policy.ts — fail-closed link classification for the preview (Phase 0 seam).
 *
 * The previous preview link handler only intercepted `^https?:` and `#…`, letting
 * every other href fall through to the browser's default navigation (fail-open).
 * Combined with the missing main-process navigation guard, a crafted href such as
 * `" https://attacker"` (leading space) bypassed the regex but still navigated.
 *
 * This pure classifier inverts the policy: deny by default, normalize through the
 * URL parser, and allow ONLY http/https (handled out-of-process via IPC) or an
 * in-document fragment. Phase 1 wires `preview-links` and a document capture-phase
 * listener onto this so no anchor ever triggers a default navigation.
 */

export type LinkAction =
  | { action: 'external'; url: string }
  | { action: 'fragment'; fragment: string }
  | { action: 'deny' };

/**
 * Classify a raw `href`. `baseUrl` resolves relative refs; default `about:blank`
 * makes any relative/protocol-relative ref fail to parse → denied.
 */
export function classifyLinkHref(rawHref: unknown, baseUrl: string = 'about:blank'): LinkAction {
  if (typeof rawHref !== 'string') return { action: 'deny' };
  const raw = rawHref.trim();
  if (raw.length === 0) return { action: 'deny' };

  // In-document fragment (e.g. footnote/heading jump).
  if (raw.startsWith('#')) {
    const fragment = raw.slice(1);
    return fragment.length > 0 ? { action: 'fragment', fragment } : { action: 'deny' };
  }

  let url: URL;
  try {
    url = new URL(raw, baseUrl);
  } catch {
    return { action: 'deny' };
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    return { action: 'external', url: url.href };
  }
  return { action: 'deny' };
}
