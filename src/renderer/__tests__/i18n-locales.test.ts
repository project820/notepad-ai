// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { DICTS, t, setLocale, type Locale } from '../i18n';

afterEach(() => setLocale('en'));

const LOCALES: Exclude<Locale, 'en'>[] = ['ko', 'zh-Hans', 'zh-Hant', 'ja'];
const SAME_AS_EN_ALLOWLIST: Record<Exclude<Locale, 'en'>, readonly string[]> = {
  ko: ['block.ai', 'menu.lang.en', 'menu.lang.ja', 'menu.lang.ko', 'menu.lang.zhHans', 'menu.lang.zhHant'],
  'zh-Hans': ['block.ai', 'menu.lang.en', 'menu.lang.ja', 'menu.lang.ko', 'menu.lang.zhHans', 'menu.lang.zhHant'],
  'zh-Hant': ['block.ai', 'menu.lang.en', 'menu.lang.ja', 'menu.lang.ko', 'menu.lang.zhHans', 'menu.lang.zhHant'],
  ja: ['block.ai', 'menu.lang.en', 'menu.lang.ja', 'menu.lang.ko', 'menu.lang.zhHans', 'menu.lang.zhHant'],
};

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

  it('renames the style difficulty label to an understanding-level wording (G006 AC13)', () => {
    const expected: Record<string, string> = {
      en: 'Understanding level',
      ko: '이해 수준',
      'zh-Hans': '理解水平',
      'zh-Hant': '理解程度',
      ja: '理解レベル',
    };
    for (const [loc, label] of Object.entries(expected)) {
      setLocale(loc as never);
      expect(t('style.difficulty'), `style.difficulty @ ${loc}`).toBe(label);
      // naturalness label is intentionally unchanged
      expect(t('style.naturalness'), `style.naturalness @ ${loc}`).toBeTruthy();
    }
  });

  it('exposes the G004 write-help / advise-sync / project-no-file keys in all five locales', () => {
    for (const loc of ['en', 'ko', 'zh-Hans', 'zh-Hant', 'ja'] as const) {
      setLocale(loc);
      for (const key of ['uc.writeHelp', 'uc.advise.resync', 'uc.advise.synced', 'uc.project.noFile']) {
        const v = t(key as never);
        expect(v, `${key} @ ${loc}`).toBeTruthy();
        expect(v, `${key} @ ${loc} not the raw key`).not.toBe(key);
      }
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

  it('exposes v0.4 local-provider + small-context keys in all five locales (G003)', () => {
    const expected: Record<string, Record<string, string>> = {
      'settings.local.urlLabel': { en: 'Server URL', ko: '서버 URL', 'zh-Hans': '服务器 URL', 'zh-Hant': '伺服器 URL', ja: 'サーバー URL' },
      'settings.local.save': { en: 'Save URL', ko: 'URL 저장', 'zh-Hans': '保存 URL', 'zh-Hant': '儲存 URL', ja: 'URL を保存' },
      'settings.local.reset': { en: 'Reset', ko: '기본값', 'zh-Hans': '默认值', 'zh-Hant': '預設值', ja: '既定値' },
      'settings.local.modelsFound': { en: 'Models available', ko: '모델 사용 가능', 'zh-Hans': '可用模型', 'zh-Hant': '可用模型', ja: '利用可能なモデル' },
      'settings.local.hint': {
        en: 'Runs on your machine — no API key needed.',
        ko: '내 컴퓨터에서 실행 — API 키가 필요 없습니다.',
        'zh-Hans': '在本机运行 — 无需 API 密钥。',
        'zh-Hant': '在本機執行 — 不需要 API 金鑰。',
        ja: 'お使いのマシンで実行 — API キーは不要です。',
      },
      'settings.local.noModels': {
        en: 'No local models found. Start Ollama or load a model in LM Studio.',
        ko: '로컬 모델이 없습니다. Ollama를 실행하거나 LM Studio에서 모델을 로드하세요.',
        'zh-Hans': '未找到本地模型。请启动 Ollama 或在 LM Studio 中加载模型。',
        'zh-Hant': '找不到本機模型。請啟動 Ollama 或在 LM Studio 中載入模型。',
        ja: 'ローカルモデルが見つかりません。Ollama を起動するか、LM Studio でモデルを読み込んでください。',
      },
      'he.smallContext': {
        en: 'This model has a small context window — long documents may be weakened or truncated.',
        ko: '이 모델은 컨텍스트 창이 작아 긴 문서는 품질이 떨어지거나 잘릴 수 있습니다.',
        'zh-Hans': '该模型的上下文窗口较小 — 长文档可能会被削弱或截断。',
        'zh-Hant': '此模型的上下文視窗較小 — 長文件可能會被削弱或截斷。',
        ja: 'このモデルはコンテキストウィンドウが小さいため、長い文書は品質が低下したり切り詰められる場合があります。',
      },
    };
    for (const [key, perLocale] of Object.entries(expected)) {
      for (const [loc, label] of Object.entries(perLocale)) {
        setLocale(loc as never);
        expect(t(key), `${key} @ ${loc}`).toBe(label);
      }
    }
  });

  it('exposes v0.4 file-tree panel keys in all five locales (G005)', () => {
    const expected: Record<string, Record<string, string>> = {
      'panel.tab.outline': { en: 'Outline', ko: '개요', 'zh-Hans': '大纲', 'zh-Hant': '大綱', ja: 'アウトライン' },
      'panel.tab.files': { en: 'Files', ko: '파일', 'zh-Hans': '文件', 'zh-Hant': '檔案', ja: 'ファイル' },
      'panel.files.openFolder': { en: 'Open folder', ko: '폴더 열기', 'zh-Hans': '打开文件夹', 'zh-Hant': '開啟資料夾', ja: 'フォルダーを開く' },
      'panel.files.refresh': { en: 'Refresh', ko: '새로고침', 'zh-Hans': '刷新', 'zh-Hant': '重新整理', ja: '更新' },
      'panel.files.filter': { en: 'Filter files…', ko: '파일 필터…', 'zh-Hans': '筛选文件…', 'zh-Hant': '篩選檔案…', ja: 'ファイルを絞り込み…' },
      'panel.files.empty': {
        en: 'Open a folder to browse files',
        ko: '폴더를 열어 파일을 탐색하세요',
        'zh-Hans': '打开文件夹以浏览文件',
        'zh-Hant': '開啟資料夾以瀏覽檔案',
        ja: 'フォルダーを開いてファイルを参照',
      },
      'panel.files.emptyDir': { en: 'No matching items', ko: '일치하는 항목이 없습니다', 'zh-Hans': '没有匹配的项目', 'zh-Hant': '沒有符合的項目', ja: '一致する項目がありません' },
      'panel.files.loading': { en: 'Loading…', ko: '불러오는 중…', 'zh-Hans': '加载中…', 'zh-Hant': '載入中…', ja: '読み込み中…' },
      'panel.files.error': {
        en: "Couldn't read this folder",
        ko: '폴더를 읽지 못했습니다',
        'zh-Hans': '无法读取此文件夹',
        'zh-Hant': '無法讀取此資料夾',
        ja: 'このフォルダーを読み込めませんでした',
      },
      'panel.files.savePrompt': {
        en: 'Save changes before opening another file?',
        ko: '다른 파일을 열기 전에 변경사항을 저장할까요?',
        'zh-Hans': '在打开其他文件前保存更改吗？',
        'zh-Hant': '在開啟其他檔案前儲存變更嗎？',
        ja: '他のファイルを開く前に変更を保存しますか？',
      },
      'panel.files.ownerFocused': {
        en: 'Already open in another window — switched to it.',
        ko: '다른 창에서 이미 열려 있어 해당 창으로 전환했습니다.',
        'zh-Hans': '已在另一个窗口中打开 — 已切换到该窗口。',
        'zh-Hant': '已在另一個視窗中開啟 — 已切換到該視窗。',
        ja: '別のウィンドウで既に開いています — そのウィンドウに切り替えました。',
      },
      'file.convert.workerFailed': {
        en: 'The document converter stopped unexpectedly. Please try again.',
        ko: '문서 변환기가 예기치 않게 중지되었습니다. 다시 시도해주세요.',
        'zh-Hans': '文档转换器意外停止。请重试。',
        'zh-Hant': '文件轉換器意外停止。請再試一次。',
        ja: '文書コンバーターが予期せず停止しました。もう一度お試しください。',
      },
    };
    for (const [key, perLocale] of Object.entries(expected)) {
      for (const [loc, label] of Object.entries(perLocale)) {
        setLocale(loc as never);
        expect(t(key), `${key} @ ${loc}`).toBe(label);
      }
    }
  });

  it('exposes the language-restart prompt in all five locales', () => {
    const expected: Record<string, string> = {
      en: 'Changing the language requires restarting the app. Restart now?',
      ko: '언어를 변경하려면 앱을 다시 시작해야 합니다. 지금 다시 시작할까요?',
      'zh-Hans': '更改语言需要重启应用。现在重启吗？',
      'zh-Hant': '變更語言需要重新啟動應用程式。現在重新啟動嗎？',
      ja: '言語を変更するにはアプリの再起動が必要です。今すぐ再起動しますか？',
    };
    for (const [loc, label] of Object.entries(expected)) {
      setLocale(loc as never);
      expect(t('lang.restartPrompt'), `lang.restartPrompt @ ${loc}`).toBe(label);
    }
  });

  it('exposes the G002 HTML-export wizard keys (A/B/C/D, free requirement, default design) in all five locales', () => {
    const locales = ['en', 'ko', 'zh-Hans', 'zh-Hant', 'ja'] as const;
    const newKeys = [
      'he.summary.title',
      'he.summary.A',
      'he.summary.B',
      'he.summary.C',
      'he.summary.D',
      'he.freeReq.title',
      'he.freeReq.placeholder',
      'he.advanced.title',
      'he.design.useDefault',
      'he.result.modelReady',
    ];
    for (const loc of locales) {
      setLocale(loc);
      for (const key of newKeys) {
        const v = t(key as never);
        expect(v, `${key} @ ${loc}`).toBeTruthy();
        expect(v, `${key} @ ${loc} not the raw key (missing in this locale)`).not.toBe(key);
      }
    }

    // Exact per-locale values prove the key is translated in each locale, not just the en fallback.
    const expected: Record<string, Record<string, string>> = {
      'he.design.useDefault': {
        en: 'Use default design',
        ko: '기본 디자인 사용',
        'zh-Hans': '使用默认设计',
        'zh-Hant': '使用預設設計',
        ja: '既定のデザインを使用',
      },
      'he.summary.A': {
        en: 'A · Visual brief',
        ko: 'A · 비주얼 요약',
        'zh-Hans': 'A · 视觉摘要',
        'zh-Hant': 'A · 視覺摘要',
        ja: 'A · ビジュアル要約',
      },
    };
    for (const [key, perLocale] of Object.entries(expected)) {
      for (const [loc, label] of Object.entries(perLocale)) {
        setLocale(loc as never);
        expect(t(key as never), `${key} @ ${loc}`).toBe(label);
      }
    }

    // The design-fetch error was updated and no longer promises a tone-only retry.
    for (const loc of locales) {
      setLocale(loc);
      const v = t('he.error.fetch' as never);
      expect(v, `he.error.fetch @ ${loc}`).toBeTruthy();
      expect(v, `he.error.fetch @ ${loc} not the raw key`).not.toBe('he.error.fetch');
    }
  });
  it('keeps every locale dictionary key-complete and flags untranslated English values', () => {
    const englishKeys = Object.keys(DICTS.en).sort();
    for (const locale of LOCALES) {
      expect(Object.keys(DICTS[locale]).sort(), `${locale} has no missing or orphaned keys`).toEqual(englishKeys);
      const untranslatedKeys = englishKeys.filter((key) => DICTS[locale][key] === DICTS.en[key]);
      expect(untranslatedKeys, `${locale} English-equivalent values require an explicit allowlist entry`).toEqual(
        SAME_AS_EN_ALLOWLIST[locale],
      );
    }
  });
});
