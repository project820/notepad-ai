import { describe, it, expect } from 'vitest';
import { clampTypography, stepTypography, typographyCssVars, DEFAULT_TYPOGRAPHY } from '../renderer/typography';

describe('clampTypography', () => {
  it('returns defaults for empty/nullish input', () => {
    expect(clampTypography(null)).toEqual(DEFAULT_TYPOGRAPHY);
    expect(clampTypography({})).toEqual(DEFAULT_TYPOGRAPHY);
  });
  it('clamps each axis into range', () => {
    expect(clampTypography({ letterSpacing: 99 }).letterSpacing).toBe(3);
    expect(clampTypography({ letterSpacing: -99 }).letterSpacing).toBe(-0.5);
    expect(clampTypography({ charScaleX: 5 }).charScaleX).toBe(1.3);
    expect(clampTypography({ charScaleX: 0 }).charScaleX).toBe(0.85);
    expect(clampTypography({ lineHeight: 9 }).lineHeight).toBe(2);
    expect(clampTypography({ lineHeight: 0 }).lineHeight).toBe(1);
  });
  it('snaps to the nearest step', () => {
    expect(clampTypography({ lineHeight: 1.44 }).lineHeight).toBe(1.4);
    expect(clampTypography({ lineHeight: 1.46 }).lineHeight).toBe(1.5);
    expect(clampTypography({ charScaleX: 1.07 }).charScaleX).toBe(1.05);
    expect(clampTypography({ letterSpacing: 0.7 }).letterSpacing).toBe(0.5);
  });
  it('tolerates non-finite values', () => {
    expect(clampTypography({ lineHeight: NaN }).lineHeight).toBe(1);
  });
});

describe('stepTypography', () => {
  it('increments/decrements by the axis step and clamps', () => {
    expect(stepTypography(DEFAULT_TYPOGRAPHY, 'lineHeight', 1).lineHeight).toBe(1.1);
    expect(stepTypography(DEFAULT_TYPOGRAPHY, 'lineHeight', -1).lineHeight).toBe(1); // already at min
    expect(stepTypography({ ...DEFAULT_TYPOGRAPHY, lineHeight: 2 }, 'lineHeight', 1).lineHeight).toBe(2); // capped
    expect(stepTypography(DEFAULT_TYPOGRAPHY, 'charScaleX', 1).charScaleX).toBe(1.05);
    expect(stepTypography(DEFAULT_TYPOGRAPHY, 'letterSpacing', 1).letterSpacing).toBe(0.5);
  });
});

describe('typographyCssVars', () => {
  it('formats CSS variables with units', () => {
    const vars = typographyCssVars({ letterSpacing: 1.5, charScaleX: 1.1, lineHeight: 1.4 });
    expect(vars['--type-letter-spacing']).toBe('1.5px');
    expect(vars['--type-char-scale']).toBe('1.1');
    expect(vars['--type-line-height']).toBe('1.4');
  });
});
