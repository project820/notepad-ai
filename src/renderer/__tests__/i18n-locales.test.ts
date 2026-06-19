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

  it('exposes v0.2 foundation keys (HTML export, footnote, default .md editor) in all locales', () => {
    const expected: Record<string, Record<string, string>> = {
      'he.button': { en: 'Generate HTML', ko: 'HTML 생성', 'zh-Hans': '生成 HTML', 'zh-Hant': '產生 HTML', ja: 'HTML を生成' },
      'he.download': { en: 'Download', ko: '다운로드', 'zh-Hans': '下载', 'zh-Hant': '下載', ja: 'ダウンロード' },
      'he.openSaved': { en: 'Open in browser', ko: '브라우저에서 열기', 'zh-Hans': '在浏览器中打开', 'zh-Hant': '在瀏覽器中開啟', ja: 'ブラウザで開く' },
      'tip.footnote': { en: 'Insert footnote', ko: '각주 삽입', 'zh-Hans': '插入脚注', 'zh-Hant': '插入註腳', ja: '脚注を挿入' },
      'settings.mdHandler.button': { en: 'Set as default .md editor', ko: '기본 .md 편집기로 설정', 'zh-Hans': '设为默认 .md 编辑器', 'zh-Hant': '設為預設 .md 編輯器', ja: '既定の .md エディターに設定' },
    };
    for (const [key, perLocale] of Object.entries(expected)) {
      for (const [loc, label] of Object.entries(perLocale)) {
        setLocale(loc as never);
        // Non-empty AND exact per-locale value (proves the key exists in this locale, not just the en fallback).
        expect(t(key), `${key} @ ${loc}`).toBeTruthy();
        expect(t(key), `${key} @ ${loc}`).toBe(label);
      }
    }
  });
});
