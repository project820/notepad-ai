export type HtmlExportRuntimeLocale = 'en' | 'ko' | 'zh-Hans' | 'zh-Hant' | 'ja';

export type HtmlExportRuntimeLabels = {
  switchToDarkTheme: string;
  switchToLightTheme: string;
  previousSlide: string;
  nextSlide: string;
  slideIndicator: string;
};

const HTML_EXPORT_RUNTIME_LABELS: Record<HtmlExportRuntimeLocale, HtmlExportRuntimeLabels> = {
  en: {
    switchToDarkTheme: 'Switch to dark theme',
    switchToLightTheme: 'Switch to light theme',
    previousSlide: 'Previous slide',
    nextSlide: 'Next slide',
    slideIndicator: 'Slide {current} of {total}',
  },
  ko: {
    switchToDarkTheme: '어두운 테마로 전환',
    switchToLightTheme: '밝은 테마로 전환',
    previousSlide: '이전 슬라이드',
    nextSlide: '다음 슬라이드',
    slideIndicator: '슬라이드 {current}/{total}',
  },
  'zh-Hans': {
    switchToDarkTheme: '切换到深色主题',
    switchToLightTheme: '切换到浅色主题',
    previousSlide: '上一张幻灯片',
    nextSlide: '下一张幻灯片',
    slideIndicator: '第 {current} 张，共 {total} 张',
  },
  'zh-Hant': {
    switchToDarkTheme: '切換至深色主題',
    switchToLightTheme: '切換至淺色主題',
    previousSlide: '上一張投影片',
    nextSlide: '下一張投影片',
    slideIndicator: '第 {current} 張，共 {total} 張',
  },
  ja: {
    switchToDarkTheme: 'ダークテーマに切り替え',
    switchToLightTheme: 'ライトテーマに切り替え',
    previousSlide: '前のスライド',
    nextSlide: '次のスライド',
    slideIndicator: 'スライド {current}/{total}',
  },
};

export function htmlExportRuntimeLabels(locale: HtmlExportRuntimeLocale = 'en'): HtmlExportRuntimeLabels {
  return HTML_EXPORT_RUNTIME_LABELS[locale];
}
