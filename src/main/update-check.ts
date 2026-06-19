/**
 * App update check (main process). The app is unsigned, so macOS blocks silent
 * auto-apply; instead we detect a newer GitHub release and let the renderer
 * notify the user to download/install. Pure version comparison is unit-tested.
 */

export type UpdateInfo = {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion: string;
  url: string;
};

const RELEASES_API = 'https://api.github.com/repos/project820/notepad-ai/releases/latest';
const RELEASES_PAGE = 'https://github.com/project820/notepad-ai/releases/latest';

/** Parse a semver-ish "1.2.3" (strips a leading v). Returns null when unparseable. */
export function parseVersion(v: string): [number, number, number] | null {
  const m = String(v).trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** True only when `latest` is strictly newer than `current`. Unparseable → false (never nag wrongly). */
export function isNewerVersion(current: string, latest: string): boolean {
  const c = parseVersion(current);
  const l = parseVersion(latest);
  if (!c || !l) return false;
  for (let i = 0; i < 3; i++) {
    if (l[i] > c[i]) return true;
    if (l[i] < c[i]) return false;
  }
  return false;
}

/**
 * Query the latest GitHub release and compare to the running version.
 * Never throws; returns null on any failure (offline, rate-limited, etc.).
 */
export async function checkForUpdate(
  currentVersion: string,
  fetchImpl: typeof fetch = fetch,
): Promise<UpdateInfo | null> {
  try {
    const r = await fetchImpl(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'notepad-ai' },
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { tag_name?: string; html_url?: string };
    const tag = (j.tag_name ?? '').trim();
    if (!tag) return null;
    return {
      updateAvailable: isNewerVersion(currentVersion, tag),
      currentVersion,
      latestVersion: tag.replace(/^v/i, ''),
      url: j.html_url || RELEASES_PAGE,
    };
  } catch {
    return null;
  }
}
