import { describe, expect, it } from 'vitest';

import {
  changeRate,
  compareProtectedSpans,
  extractProtectedSpans,
  guardVerdict,
  OVER_HUMANIZE_WARN,
} from '../humanize-guards';
import {
  buildHumanizeDirective,
  detectLanguage,
  DEFAULT_STYLE,
  styleDirective,
} from '../humanize-engine';
import { EN_CATEGORIES, KO_CATEGORIES, EN_EXPERIMENTAL } from '../humanize-taxonomy';

describe('extractProtectedSpans', () => {
  it('extracts code blocks, inline code, quotes, numbers, and proper nouns', () => {
    const md = [
      '```js',
      'const x = 1;',
      '```',
      'Use `npm run build` and keep "the exact quote" intact.',
      'Revenue was 1,200 won (12%) per OpenAI Codex.',
    ].join('\n');
    const spans = extractProtectedSpans(md);
    expect(spans.codeBlocks).toHaveLength(1);
    expect(spans.inlineCode).toContain('`npm run build`');
    expect(spans.quotes.some((q) => q.includes('the exact quote'))).toBe(true);
    expect(spans.numbers).toContain('1,200');
    expect(spans.numbers).toContain('12%');
    expect(spans.properNouns).toContain('OpenAI Codex');
  });
  it('does not double-count content inside fenced code', () => {
    const md = ['```', 'value = 42', '```'].join('\n');
    const spans = extractProtectedSpans(md);
    expect(spans.numbers).not.toContain('42'); // 42 lives inside the fence
  });
});

describe('compareProtectedSpans', () => {
  it('passes when all protected spans are preserved', () => {
    const src = 'Keep `code` and 3.14 and "quote".';
    const out = 'We keep `code`, the value 3.14, and "quote" here.';
    expect(compareProtectedSpans(src, out).ok).toBe(true);
  });
  it('fails when a number is dropped', () => {
    const cmp = compareProtectedSpans('The total is 1,200 won.', 'The total is large.');
    expect(cmp.ok).toBe(false);
    expect(cmp.missingNumbers).toContain('1,200');
  });
  it('fails when inline code is dropped', () => {
    const cmp = compareProtectedSpans('Run `build` now.', 'Run the build now.');
    expect(cmp.ok).toBe(false);
    expect(cmp.missingInlineCode).toContain('`build`');
  });
});

describe('changeRate', () => {
  it('is 0 for identical text and 1 for fully disjoint text', () => {
    expect(changeRate('a b c', 'a b c')).toBe(0);
    expect(changeRate('a b c', 'x y z')).toBe(1);
  });
  it('is between 0 and 1 for partial overlap', () => {
    const r = changeRate('the quick brown fox', 'the slow brown cat');
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThan(1);
  });
});

describe('guardVerdict', () => {
  it('blocks apply when a protected number is lost', () => {
    const v = guardVerdict('Pay 500 dollars by Friday.', 'Pay later.');
    expect(v.blockApply).toBe(true);
  });
  it('flags over-humanization when change rate exceeds the threshold', () => {
    const v = guardVerdict('alpha beta gamma delta', 'totally different words here now');
    expect(v.rate).toBeGreaterThan(OVER_HUMANIZE_WARN);
    expect(v.overHumanized).toBe(true);
  });
});

describe('detectLanguage', () => {
  it('detects Korean vs English by script ratio', () => {
    expect(detectLanguage('안녕하세요 반갑습니다')).toBe('ko');
    expect(detectLanguage('Hello there friend')).toBe('en');
  });
});

describe('taxonomy + directives', () => {
  it('Korean taxonomy has the 10 macro categories; English is minimal + experimental', () => {
    expect(KO_CATEGORIES.length).toBe(10);
    expect(EN_CATEGORIES.length).toBeLessThanOrEqual(3);
    expect(EN_EXPERIMENTAL).toBe(true);
  });
  it('buildHumanizeDirective returns empty for naturalness off', () => {
    expect(buildHumanizeDirective('ko', 'off')).toBe('');
  });
  it('Korean directive includes the meaning-preservation invariant', () => {
    const d = buildHumanizeDirective('ko', 'balanced');
    expect(d).toContain('의미를 바꾸지');
    expect(d).toContain('번역투');
  });
  it('English directive is labeled experimental', () => {
    const d = buildHumanizeDirective('en', 'balanced');
    expect(d.toLowerCase()).toContain('experimental');
    expect(d).toContain('Never change meaning');
  });
  it('styleDirective composes difficulty + naturalness', () => {
    const d = styleDirective(DEFAULT_STYLE, 'ko');
    expect(d).toContain('college reading level');
    expect(d).toContain('번역투');
  });
  it('styleDirective with naturalness off yields difficulty only', () => {
    const d = styleDirective({ difficulty: 'college', naturalness: 'off' }, 'en');
    expect(d).toContain('college reading level');
    expect(d).not.toContain('Never change meaning');
  });
});
