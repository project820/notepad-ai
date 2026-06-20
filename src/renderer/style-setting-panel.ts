/**
 * style-setting-panel.ts — the single "Style" control that replaces the former
 * F6 reading-level dial (G004 / AC16).
 *
 * Combines two dimensions into one setting:
 *   - difficulty  (former F6 reading level: elementary … professional)
 *   - naturalness (the always-on humanize layer strength: off … strong)
 *
 * Pure `render*` (Node-testable) + DOM `mount*`, per the settings-panel pattern.
 */

import { QUALITY_ORDER, type Quality } from './quality';
import type { Naturalness, StyleSetting } from './humanize-engine';
import { t } from './i18n';

const NATURALNESS_ORDER: Naturalness[] = ['off', 'light', 'balanced', 'strong'];

/** Difficulty option labels, resolved from i18n at render time (quality.* keys). */
function difficultyLabels(): Record<Quality, string> {
  return {
    elementary: t('quality.elementary'),
    highschool: t('quality.highschool'),
    college: t('quality.college'),
    professor: t('quality.professor'),
    professional: t('quality.professional'),
  };
}

/** Naturalness option labels, resolved from i18n at render time (naturalness.* keys). */
function naturalnessLabels(): Record<Naturalness, string> {
  return {
    off: t('naturalness.off'),
    light: t('naturalness.light'),
    balanced: t('naturalness.balanced'),
    strong: t('naturalness.strong'),
  };
}

export type StyleSettingRenderOptions = { setting: StyleSetting };
export type StyleSettingOptions = StyleSettingRenderOptions & {
  onChange: (next: StyleSetting) => void;
};
export type StyleSettingHandle = { destroy: () => void };

function escapeHTML(raw: string): string {
  return raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function options<T extends string>(values: T[], current: T, labels: Record<T, string>): string {
  return values
    .map(
      (v) =>
        `<option value="${escapeHTML(v)}"${v === current ? ' selected' : ''}>${escapeHTML(labels[v])}</option>`,
    )
    .join('');
}

export function renderStyleSettingPanel(opts: StyleSettingRenderOptions): string {
  const { difficulty, naturalness } = opts.setting;
  return `<div class="style-root">
  <h2 class="style-title">${escapeHTML(t('style.title'))}</h2>
  <label class="style-field">
    <span class="style-label">${escapeHTML(t('style.difficulty'))}</span>
    <select class="style-select" data-style="difficulty">${options(
      QUALITY_ORDER,
      difficulty,
      difficultyLabels(),
    )}</select>
  </label>
  <label class="style-field">
    <span class="style-label">${escapeHTML(t('style.naturalness'))}</span>
    <select class="style-select" data-style="naturalness">${options(
      NATURALNESS_ORDER,
      naturalness,
      naturalnessLabels(),
    )}</select>
  </label>
</div>`;
}

export function mountStyleSettingPanel(
  parent: HTMLElement,
  opts: StyleSettingOptions,
): StyleSettingHandle {
  parent.innerHTML = renderStyleSettingPanel(opts);
  let current: StyleSetting = { ...opts.setting };

  const onChange = (e: Event) => {
    const sel = e.target as HTMLSelectElement;
    if (sel.dataset.style === 'difficulty') {
      current = { ...current, difficulty: sel.value as Quality };
      opts.onChange(current);
    } else if (sel.dataset.style === 'naturalness') {
      current = { ...current, naturalness: sel.value as Naturalness };
      opts.onChange(current);
    }
  };

  parent.addEventListener('change', onChange);
  return {
    destroy: () => {
      parent.removeEventListener('change', onChange);
      parent.innerHTML = '';
    },
  };
}
