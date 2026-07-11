/**
 * Global typography view-settings (#6): letter-spacing (자간), horizontal glyph
 * scale (장평), and line-height (줄간격). Pure + unit-tested. Applied as CSS
 * variables to the editor + preview; it is a display setting only (the Markdown
 * source is never changed).
 */

export type TypographyPref = {
  /** Letter spacing in px. */
  letterSpacing: number;
  /** Horizontal glyph scale (1 = 100%). */
  charScaleX: number;
  /** Line-height multiplier (1 = default). */
  lineHeight: number;
};

export const DEFAULT_TYPOGRAPHY: TypographyPref = { letterSpacing: 0, charScaleX: 1, lineHeight: 1 };

const TYPO_RANGES = {
  letterSpacing: { min: -0.5, max: 3, step: 0.5 },
  charScaleX: { min: 0.85, max: 1.3, step: 0.05 },
  lineHeight: { min: 1, max: 2, step: 0.1 },
} as const;

function snap(value: number, min: number, max: number, step: number): number {
  const v = Number.isFinite(value) ? value : min;
  const clamped = Math.min(max, Math.max(min, v));
  const stepped = Math.round((clamped - min) / step) * step + min;
  const bounded = Math.min(max, Math.max(min, stepped));
  return Math.round(bounded * 100) / 100;
}

/** Clamp + step-snap each axis into its valid range. */
export function clampTypography(p: Partial<TypographyPref> | null | undefined): TypographyPref {
  const o = p ?? {};
  return {
    letterSpacing: snap(o.letterSpacing ?? 0, TYPO_RANGES.letterSpacing.min, TYPO_RANGES.letterSpacing.max, TYPO_RANGES.letterSpacing.step),
    charScaleX: snap(o.charScaleX ?? 1, TYPO_RANGES.charScaleX.min, TYPO_RANGES.charScaleX.max, TYPO_RANGES.charScaleX.step),
    lineHeight: snap(o.lineHeight ?? 1, TYPO_RANGES.lineHeight.min, TYPO_RANGES.lineHeight.max, TYPO_RANGES.lineHeight.step),
  };
}

/** Step one axis up/down by its configured step, clamped. */
export function stepTypography(p: TypographyPref, axis: keyof TypographyPref, dir: 1 | -1): TypographyPref {
  const r = TYPO_RANGES[axis];
  return clampTypography({ ...p, [axis]: p[axis] + dir * r.step });
}

/** CSS variable map applied to the document root. */
export function typographyCssVars(p: TypographyPref): Record<string, string> {
  return {
    '--type-letter-spacing': `${p.letterSpacing}px`,
    '--type-char-scale': `${p.charScaleX}`,
    '--type-line-height': `${p.lineHeight}`,
  };
}
export function applyTypography(p: TypographyPref) {
  const vars = typographyCssVars(p);
  for (const [key, value] of Object.entries(vars)) document.documentElement.style.setProperty(key, value);
}
