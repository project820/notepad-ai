/**
 * Humanize/style engine — builds the always-on style directive injected into
 * every AI system prompt (unified chat + Block AI). Pure and unit tested.
 *
 * The single "Style setting" absorbs the former F6 reading-level dial
 * (difficulty) and adds a naturalness dimension (the humanize layer).
 */

import { qualityDirective, type Quality } from './quality';
import { categoriesFor, EN_EXPERIMENTAL } from './humanize-taxonomy';

export type Naturalness = 'off' | 'light' | 'balanced' | 'strong';

export type StyleSetting = {
  difficulty: Quality;
  naturalness: Naturalness;
};

export const DEFAULT_STYLE: StyleSetting = { difficulty: 'college', naturalness: 'balanced' };


/** Detect the dominant language by Hangul ratio (cheap heuristic). */
export function detectLanguage(text: string): 'ko' | 'en' {
  const hangul = (text.match(/[\uac00-\ud7a3]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  return hangul >= latin ? 'ko' : 'en';
}

const NATURALNESS_PREAMBLE: Record<Exclude<Naturalness, 'off'>, string> = {
  light: 'Lightly smooth the wording so it does not read as AI-generated.',
  balanced: 'Rewrite so the text reads as naturally human-written, not AI-generated.',
  strong: 'Aggressively remove AI-tell so the text reads fully human-written.',
};

/**
 * Build the humanize directive for a language + naturalness. Returns '' when
 * naturalness is 'off'. The meaning-preservation invariant is always included.
 */
export function buildHumanizeDirective(language: 'ko' | 'en', naturalness: Naturalness): string {
  if (naturalness === 'off') return '';
  const cats = categoriesFor(language);
  const rules = cats.map((c) => `- (${c.label}) ${c.directive}`).join('\n');
  const invariant =
    language === 'ko'
      ? '절대 의미를 바꾸지 말 것: 사실·수치·고유명사·직접 인용·코드는 그대로 보존한다.'
      : 'Never change meaning: preserve facts, numbers, proper nouns, direct quotes, and code verbatim.';
  const expNote =
    language === 'en' && EN_EXPERIMENTAL
      ? '\n(English humanization is experimental and intentionally minimal.)'
      : '';
  return `${NATURALNESS_PREAMBLE[naturalness]}\n${rules}\n${invariant}${expNote}`;
}

/**
 * Compose the full style directive (difficulty + naturalness) for a system
 * prompt, given the user's StyleSetting and the working language.
 */
export function styleDirective(setting: StyleSetting, language: 'ko' | 'en'): string {
  const parts = [qualityDirective(setting.difficulty), buildHumanizeDirective(language, setting.naturalness)];
  return parts.filter((p) => p.trim().length > 0).join('\n\n');
}
