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

/**
 * DESIGN.md fetch allowlist (⑤ html-export). The renderer never fetches
 * directly — it asks the main process via `design:fetch`, which normalizes the
 * user input to a single canonical raw URL and then hard-checks it here before
 * any network call. Only the VoltAgent/awesome-design-md DESIGN.md files are
 * reachable; everything else (other owners/repos, non-https, getdesign arbitrary
 * paths, traversal slugs, oversized input) is rejected.
 */

const DESIGN_MD_OWNER = 'VoltAgent';
const DESIGN_MD_REPO = 'awesome-design-md';
const DESIGN_MD_BRANCH = 'main';
const DESIGN_MD_DIR = 'design-md';
const DESIGN_MD_FILE = 'DESIGN.md';
const DESIGN_RAW_HOST = 'raw.githubusercontent.com';

/** A design slug is a single safe path segment — no scheme, slash, dot, or traversal. */
function isValidDesignSlug(slug: string): boolean {
  if (typeof slug !== 'string') return false;
  if (slug.length === 0 || slug.length > 80) return false;
  // letters/digits/underscore/dash only; cannot start or end with a dash.
  return /^[A-Za-z0-9_](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?$/.test(slug);
}

function canonicalDesignRawUrl(slug: string): string {
  return `https://${DESIGN_RAW_HOST}/${DESIGN_MD_OWNER}/${DESIGN_MD_REPO}/${DESIGN_MD_BRANCH}/${DESIGN_MD_DIR}/${slug}/${DESIGN_MD_FILE}`;
}

function sameOwnerRepo(owner: string, repo: string): boolean {
  return owner.toLowerCase() === DESIGN_MD_OWNER.toLowerCase() && repo.toLowerCase() === DESIGN_MD_REPO.toLowerCase();
}

/**
 * Normalize any supported design reference to the canonical raw DESIGN.md URL,
 * or return `null` when the input is not an allowed design source.
 *
 * Accepts: a bare slug (`replicate`), a getdesign.md page (`/<slug>` or
 * `/<slug>/design-md`), the canonical raw URL, or a GitHub blob URL — all only
 * for VoltAgent/awesome-design-md on the `main` branch.
 */
export function normalizeDesignMdUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  if (value.length === 0 || value.length > 2048) return null;

  // Bare slug — no scheme and no path separators.
  if (!value.includes('/') && !value.includes(':')) {
    return isValidDesignSlug(value) ? canonicalDesignRawUrl(value) : null;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;

  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean);

  if (host === 'getdesign.md' || host === 'www.getdesign.md') {
    // Only `/<slug>` or `/<slug>/design-md` — never an arbitrary getdesign path.
    if (segments.length === 1 && isValidDesignSlug(segments[0])) return canonicalDesignRawUrl(segments[0]);
    if (segments.length === 2 && segments[1] === DESIGN_MD_DIR && isValidDesignSlug(segments[0])) {
      return canonicalDesignRawUrl(segments[0]);
    }
    return null;
  }

  if (host === DESIGN_RAW_HOST) {
    // owner / repo / branch / design-md / slug / DESIGN.md
    if (segments.length !== 6) return null;
    const [owner, repo, branch, dir, slug, file] = segments;
    if (!sameOwnerRepo(owner, repo) || branch !== DESIGN_MD_BRANCH || dir !== DESIGN_MD_DIR || file !== DESIGN_MD_FILE) {
      return null;
    }
    return isValidDesignSlug(slug) ? canonicalDesignRawUrl(slug) : null;
  }

  if (host === 'github.com') {
    // owner / repo / blob / branch / design-md / slug / DESIGN.md
    if (segments.length !== 7) return null;
    const [owner, repo, blob, branch, dir, slug, file] = segments;
    if (
      !sameOwnerRepo(owner, repo) ||
      blob !== 'blob' ||
      branch !== DESIGN_MD_BRANCH ||
      dir !== DESIGN_MD_DIR ||
      file !== DESIGN_MD_FILE
    ) {
      return null;
    }
    return isValidDesignSlug(slug) ? canonicalDesignRawUrl(slug) : null;
  }

  return null;
}

/**
 * Final gate before `design:fetch` performs a network request. Accepts ONLY the
 * exact canonical raw DESIGN.md URL shape (the output of `normalizeDesignMdUrl`),
 * with the canonical owner/repo casing and no query/hash.
 */
export function isAllowedDesignFetchUrl(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  const value = raw.trim();
  if (value.length === 0) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.hostname.toLowerCase() !== DESIGN_RAW_HOST) return false;
  if (url.search || url.hash) return false;
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length !== 6) return false;
  const [owner, repo, branch, dir, slug, file] = segments;
  return (
    owner === DESIGN_MD_OWNER &&
    repo === DESIGN_MD_REPO &&
    branch === DESIGN_MD_BRANCH &&
    dir === DESIGN_MD_DIR &&
    file === DESIGN_MD_FILE &&
    isValidDesignSlug(slug)
  );
}

/**
 * True only for a local `.html`/`.htm` filesystem path — used by `html:open-saved`
 * before handing the path to `shell.openPath`. URL strings (incl. `file:`) and
 * non-html extensions are rejected.
 */
export function isOpenableSavedPath(input: unknown): boolean {
  if (typeof input !== 'string') return false;
  const value = input.trim();
  if (value.length === 0) return false;
  // Reject anything that looks like a URL (scheme://… or file:…).
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  if (/^file:/i.test(value)) return false;
  // Reject control characters / newlines.
  if (/[\u0000-\u001f]/.test(value)) return false;
  const lower = value.toLowerCase();
  return lower.endsWith('.html') || lower.endsWith('.htm');
}

/**
 * Canonical GitHub Contents API URL listing the design-md directory. The only
 * URL `design:list` is allowed to fetch (the index of available designs).
 */
const DESIGN_LIST_HOST = 'api.github.com';
export function designListContentsUrl(): string {
  return `https://${DESIGN_LIST_HOST}/repos/${DESIGN_MD_OWNER}/${DESIGN_MD_REPO}/contents/${DESIGN_MD_DIR}?ref=${DESIGN_MD_BRANCH}`;
}

/** Final gate before `design:list` fetches — only the exact Contents API URL. */
export function isAllowedDesignListFetchUrl(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.hostname.toLowerCase() !== DESIGN_LIST_HOST) return false;
  if (url.hash) return false;
  if (url.search !== `?ref=${DESIGN_MD_BRANCH}`) return false;
  const segments = url.pathname.split('/').filter(Boolean);
  // repos / owner / repo / contents / design-md
  if (segments.length !== 5) return false;
  const [repos, owner, repo, contents, dir] = segments;
  return (
    repos === 'repos' &&
    owner === DESIGN_MD_OWNER &&
    repo === DESIGN_MD_REPO &&
    contents === 'contents' &&
    dir === DESIGN_MD_DIR
  );
}

/** The public getdesign.md gallery page for a design slug (for the "open guide" link). */
export function getdesignPageUrl(slug: string): string | null {
  return isValidDesignSlug(slug) ? `https://getdesign.md/${slug}` : null;
}

/** Human-friendly name from a slug: "together-ai" → "Together Ai". */
export function titleizeDesignSlug(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export type DesignListEntry = { slug: string; name: string; pageUrl: string };

/**
 * Parse a GitHub Contents API response (array of dir entries) into the list of
 * valid design slugs. Pure + unit-tested: ignores non-directories, invalid
 * slugs, and malformed input; de-dupes; sorts by name.
 */
export function parseDesignListFromContents(json: unknown): DesignListEntry[] {
  if (!Array.isArray(json)) return [];
  const seen = new Set<string>();
  const out: DesignListEntry[] = [];
  for (const item of json) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as { name?: unknown; type?: unknown };
    if (rec.type !== 'dir') continue;
    const slug = typeof rec.name === 'string' ? rec.name : '';
    if (!isValidDesignSlug(slug) || seen.has(slug)) continue;
    const pageUrl = getdesignPageUrl(slug);
    if (!pageUrl) continue;
    seen.add(slug);
    out.push({ slug, name: titleizeDesignSlug(slug), pageUrl });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Max bytes for a fetched design icon (avatar). Larger responses are rejected. */
const DESIGN_ICON_MAX_BYTES = 64 * 1024;

/**
 * Allowlist for a design icon URL — only GitHub avatar PNGs on
 * `avatars.githubusercontent.com` with a bounded `s`/`size` query. Everything
 * else (other hosts, non-PNG, oversized size) is rejected; the UI falls back to
 * initials. This is the URL gate; {@link validateDesignIconBytes} gates the body.
 */
export function isAllowedDesignIconUrl(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.hostname.toLowerCase() !== 'avatars.githubusercontent.com') return false;
  if (url.hash) return false;
  // Allow only a numeric size query within [16, 128], or no query at all.
  for (const [k, v] of url.searchParams) {
    if (k !== 's' && k !== 'size') return false;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 16 || n > 128) return false;
  }
  return true;
}

/**
 * Validate fetched icon bytes before converting to a data URI: PNG magic bytes
 * and a hard size cap. Returns the data URI on success, or null to fall back.
 */
export function pngBytesToDataUri(bytes: Uint8Array): string | null {
  if (!bytes || bytes.length === 0 || bytes.length > DESIGN_ICON_MAX_BYTES) return null;
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 8) return null;
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) return null;
  const b64 = Buffer.from(bytes).toString('base64');
  return `data:image/png;base64,${b64}`;
}
