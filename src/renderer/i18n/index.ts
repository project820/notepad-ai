/**
 * Tiny i18n — en / ko / zh-Hans / zh-Hant / ja. Persisted in prefs.
 * Visible UI strings call `t(key)`; switching locale rebuilds the UI surfaces
 * that own labels.
 */

export type Locale = 'en' | 'ko' | 'zh-Hans' | 'zh-Hant' | 'ja';
export type Dict = Record<string, string>;

import { en } from './en';
import { ja } from './ja';
import { ko } from './ko';
import { zhHans } from './zh-hans';
import { zhHant } from './zh-hant';

export const DICTS: Record<Locale, Dict> = {
  en,
  ko,
  'zh-Hans': zhHans,
  'zh-Hant': zhHant,
  ja,
};


let currentLocale: Locale = 'en';
const listeners = new Set<(locale: Locale) => void>();

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: Locale) {
  if (locale === currentLocale) return;
  currentLocale = locale;
  document.documentElement.lang = locale;
  listeners.forEach((cb) => cb(locale));
}

export function onLocaleChange(cb: (locale: Locale) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function t(key: string): string {
  return DICTS[currentLocale]?.[key] ?? DICTS.en[key] ?? key;
}
