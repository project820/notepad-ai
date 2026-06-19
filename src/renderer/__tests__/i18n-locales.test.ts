// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { t, setLocale } from '../i18n';

afterEach(() => setLocale('en'));

describe('i18n — 5 locales (#3)', () => {
  it('switches the unified-chat Send label across all locales', () => {
    const expected: Record<string, string> = {
      en: 'Send',
      ko: '보내기',
      'zh-Hans': '发送',
      'zh-Hant': '傳送',
      ja: '送信',
    };
    for (const [loc, label] of Object.entries(expected)) {
      setLocale(loc as never);
      expect(t('uc.send')).toBe(label);
    }
  });

  it('localizes core surfaces (settings title, table delete confirm, footnote back) per locale', () => {
    setLocale('zh-Hans');
    expect(t('settings.title')).toBe('设置');
    expect(t('footnote.back')).toBe('← 返回');
    setLocale('ja');
    expect(t('settings.title')).toBe('設定');
    expect(t('panel.outline')).toBe('アウトライン');
    setLocale('zh-Hant');
    expect(t('menu.lang.zhHant')).toBe('繁體中文');
  });

  it('falls back to English for an unknown key', () => {
    setLocale('ja');
    expect(t('totally.unknown.key')).toBe('totally.unknown.key');
  });
});
