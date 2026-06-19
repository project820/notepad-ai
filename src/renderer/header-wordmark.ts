/**
 * Brand wordmark wiring (AC2).
 *
 * The "notepad·ai" wordmark doubles as a GitHub link + version surface:
 *   - hover tooltip carries the running app version prepended to a star prompt
 *     (`v0.2.0 · Star us on GitHub ★`), driven by the `[data-tooltip]` overlay;
 *   - click / Enter / Space opens the repository externally.
 *
 * The element is the source of truth for the tooltip text — we set its
 * `data-tooltip` (and mirror it on `aria-label` for screen readers).
 */

import { t } from './i18n';

export const NOTEPAD_REPO_URL = 'https://github.com/project820/notepad-ai';

export type WordmarkDeps = {
  openExternal: (url: string) => void;
  getVersion: () => Promise<string>;
};

/** Compose the wordmark tooltip: version prefix + localized star prompt. */
export function wordmarkTooltip(version: string): string {
  const base = t('tip.wordmark');
  return version ? `v${version} · ${base}` : base;
}

/**
 * Wire the wordmark element. Returns a `relabel` callback so the caller can
 * refresh the tooltip text on locale change.
 */
export function wireWordmark(el: HTMLElement, deps: WordmarkDeps): { relabel: () => void } {
  let version = '';

  const relabel = () => {
    const label = wordmarkTooltip(version);
    el.dataset.tooltip = label;
    el.setAttribute('aria-label', label);
  };
  relabel();

  void (async () => {
    try {
      version = await deps.getVersion();
    } catch {
      version = '';
    }
    relabel();
  })();

  const open = () => deps.openExternal(NOTEPAD_REPO_URL);
  el.addEventListener('click', open);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  });

  return { relabel };
}
