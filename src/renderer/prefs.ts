import type { Theme, FontSize } from './toolbar';
import type { Quality } from './quality';
import type { Naturalness } from './humanize-engine';
import { clampTypography, type TypographyPref } from './typography';

export type SelectedModel = { provider: 'chatgpt' | 'claude' | 'openrouter'; id: string };
export type StylePref = { difficulty: Quality; naturalness: Naturalness };

export type Prefs = {
  theme: Theme;
  fontSize: FontSize;
  splitRatio?: number;
  /** Legacy ChatGPT-only model id (kept for back-compat / migration source). */
  model?: string;
  /** Legacy Block AI model id. */
  blockModel?: string;
  /** v1 structured model selection (provider + id). Migrated from `model`. */
  selectedModel?: SelectedModel;
  /** v1 structured Block AI model selection. Migrated from `blockModel`. */
  blockSelectedModel?: SelectedModel;
  /** v1 unified style setting (difficulty + always-on humanize). Migrated from `quality`. */
  style?: StylePref;
  /** v1.1 global typography view-settings (letter-spacing / char scale / line-height). */
  typography?: TypographyPref;
  locale?: 'en' | 'ko' | 'zh-Hans' | 'zh-Hant' | 'ja';
  quality?: 'elementary' | 'highschool' | 'college' | 'professor' | 'professional';
  /** v0.2 preview line-number gutter toggle (default off; back-filled by migratePrefs). */
  previewLineNumbers?: boolean;
};

const KEY = 'notepad-ai:prefs:v1';

function detectLocale(): 'en' | 'ko' | 'zh-Hans' | 'zh-Hant' | 'ja' {
  try {
    const langs = (navigator.languages?.length ? navigator.languages : [navigator.language]) ?? ['en'];
    for (const l of langs) {
      const tag = (l || '').toLowerCase();
      if (tag.startsWith('ko')) return 'ko';
      if (tag.startsWith('zh')) {
        // Traditional for TW/HK/MO, otherwise Simplified.
        return /-(tw|hk|mo)|hant/.test(tag) ? 'zh-Hant' : 'zh-Hans';
      }
      if (tag.startsWith('ja')) return 'ja';
      if (tag.startsWith('en')) return 'en';
    }
  } catch { /* ignore */ }
  return 'en';
}

const DEFAULTS: Prefs = { theme: 'system', fontSize: 'md', model: 'gpt-5.4-mini', blockModel: 'gpt-5.4-mini', locale: detectLocale(), quality: 'college', previewLineNumbers: false };

/**
 * Pure prefs migration: merges defaults + stored prefs, then back-fills the v1
 * structured fields (`selectedModel`, `blockSelectedModel`, `style`) from the
 * legacy flat fields (`model`, `blockModel`, `quality`) when absent. Additive
 * and back-compatible — legacy fields are preserved. Never throws.
 */
export function migratePrefs(parsed: Partial<Prefs> | null | undefined): Prefs {
  const merged: Prefs = { ...DEFAULTS, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  if (!merged.selectedModel && merged.model) {
    merged.selectedModel = { provider: 'chatgpt', id: merged.model };
  }
  if (!merged.blockSelectedModel && merged.blockModel) {
    merged.blockSelectedModel = { provider: 'chatgpt', id: merged.blockModel };
  }
  if (!merged.style) {
    merged.style = { difficulty: merged.quality ?? 'college', naturalness: 'balanced' };
  }
  merged.typography = clampTypography(merged.typography);
  return merged;
}

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return migratePrefs(null);
    return migratePrefs(JSON.parse(raw));
  } catch {
    return migratePrefs(null);
  }
}

export function savePrefs(prefs: Prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  // remove any forced color-scheme so prefers-color-scheme kicks in for "system"
  if (theme === 'system') root.style.colorScheme = '';
  else root.style.colorScheme = theme;
}

export function resolvedDark(theme: Theme): boolean {
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function applyFontSize(size: FontSize) {
  document.documentElement.dataset.fontSize = size;
}
