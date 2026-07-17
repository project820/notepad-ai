import type { Theme, FontSize } from './toolbar';
import type { Quality } from './quality';
import type { Naturalness } from './humanize-engine';
import { clampTypography, type TypographyPref } from './typography';
import type { AiProviderId } from '../main/ai/types';
import { isHtmlExportModelAllowed } from '../main/ai/html-export-model-allowlist';

type SelectedModel = { provider: AiProviderId; id: string };
type StylePref = { difficulty: Quality; naturalness: Naturalness };

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
  /** v0.3 raw line-alignment toggle: spacers align raw editor lines with preview blocks (default off; back-filled by migratePrefs). */
  rawLineAlign?: boolean;
  /** v0.3.5 HTML-export model override (picked in the HTML wizard). Falls back to
   *  the main `selectedModel`/`model` when unset. */
  htmlModel?: SelectedModel;
  /** HTML wizard GPT Fast preference. */
  htmlFastMode?: boolean;
  /** v0.4 workspace root path for the file-tree panel (back-filled lazily; no default). */
  workspaceRoot?: string;
  /** Capability-gated reasoning tier. Persisted while transport verification remains off. */
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh';
  /** Reserved for a future verified reasoning mode; no mode is currently accepted. */
  reasoningMode?: string;
};

const KEY = 'notepad-ai:prefs:v1';
let lastPersistedPrefs: Prefs | null = null;

function clonePrefs(prefs: Prefs): Prefs {
  return JSON.parse(JSON.stringify(prefs)) as Prefs;
}

function readStoredPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    return migratePrefs(raw ? JSON.parse(raw) : null);
  } catch {
    return migratePrefs(null);
  }
}

function changedPrefs(base: Prefs, next: Prefs): Partial<Prefs> {
  const changes: Partial<Prefs> = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(next)]) as Set<keyof Prefs>) {
    if (JSON.stringify(base[key]) !== JSON.stringify(next[key])) {
      Object.assign(changes, { [key]: next[key] });
    }
  }
  return changes;
}

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

const DEFAULTS: Prefs = { theme: 'system', fontSize: 'md', model: 'gpt-5.4-mini', blockModel: 'gpt-5.4-mini', locale: detectLocale(), quality: 'college', previewLineNumbers: false, rawLineAlign: false };

/**
 * Known-stale Claude model ids → their smoke-verified replacements. ONLY these
 * exact ids are remapped; unknown / custom Claude ids and every non-Claude
 * selection (including OpenRouter slugs like `anthropic/claude-sonnet-4.5`) are
 * preserved untouched, so a user is never silently switched off their choice.
 */
const STALE_CLAUDE_MODEL_IDS: Record<string, string> = {
  'claude-sonnet-4-5': 'claude-sonnet-4-6',
  'claude-opus-4-1': 'claude-opus-4-8',
};

/** Remap a stale Claude selection to its verified target; pass everything else through. */
function remapStaleClaudeModel(sel: SelectedModel | undefined): SelectedModel | undefined {
  if (!sel || sel.provider !== 'claude') return sel;
  const target = STALE_CLAUDE_MODEL_IDS[sel.id];
  return target ? { provider: 'claude', id: target } : sel;
}
const ALLOWED_REASONING_EFFORTS = new Set<NonNullable<Prefs['reasoningEffort']>>([
  'none', 'low', 'medium', 'high', 'xhigh',
]);

function sanitizeReasoningPrefs(prefs: Prefs): void {
  if (!ALLOWED_REASONING_EFFORTS.has(prefs.reasoningEffort as NonNullable<Prefs['reasoningEffort']>)) {
    delete prefs.reasoningEffort;
  }
  // `pro` and every other mode are outside the verified transport contract.
  delete prefs.reasoningMode;
}

function sanitizeHtmlExportPrefs(prefs: Prefs): void {
  if (prefs.htmlModel && !isHtmlExportModelAllowed(prefs.htmlModel)) {
    prefs.htmlModel = { provider: 'chatgpt', id: 'gpt-5.6-sol' };
  }
  if (typeof prefs.htmlFastMode !== 'boolean') delete prefs.htmlFastMode;
}


/**
 * Pure prefs migration: merges defaults + stored prefs, then back-fills the v1
 * structured fields (`selectedModel`, `blockSelectedModel`, `style`) from the
 * legacy flat fields (`model`, `blockModel`, `quality`) when absent, and remaps
 * known-stale Claude ids across `selectedModel`, `blockSelectedModel`, and
 * `htmlModel` to their verified targets. Additive and back-compatible — legacy
 * fields are preserved. Never throws.
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
  merged.selectedModel = remapStaleClaudeModel(merged.selectedModel);
  merged.blockSelectedModel = remapStaleClaudeModel(merged.blockSelectedModel);
  merged.htmlModel = remapStaleClaudeModel(merged.htmlModel);
  merged.typography = clampTypography(merged.typography);
  sanitizeHtmlExportPrefs(merged);
  sanitizeReasoningPrefs(merged);
  return merged;
}

export function loadPrefs(): Prefs {
  const prefs = readStoredPrefs();
  lastPersistedPrefs = clonePrefs(prefs);
  return prefs;
}

export function savePrefs(prefs: Prefs) {
  try {
    const stored = readStoredPrefs();
    const base = lastPersistedPrefs ?? stored;
    const merged = migratePrefs({ ...stored, ...changedPrefs(base, prefs) });
    localStorage.setItem(KEY, JSON.stringify(merged));
    Object.assign(prefs, clonePrefs(merged));
    lastPersistedPrefs = clonePrefs(merged);
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
