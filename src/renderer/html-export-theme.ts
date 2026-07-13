/**
 * html-export-theme.ts — design.md → deterministic theme (G003).
 *
 * Pure module: no DOM, no electron, no node. Given the freeform text of a
 * design.md (prose + lists + YAML-ish frontmatter + code fences), extract a
 * structured DesignTheme, emit deterministic CSS custom properties + component
 * classes, and evaluate a fixed design-compliance checklist.
 *
 * Tolerant by design: design.md authors are inconsistent. Extract what is
 * present; fall back to sensible, slide-safe defaults otherwise. Identical input
 * always produces byte-identical output (no Math.random / Date / Set-order
 * dependence — arrays are sorted before use).
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The seven (+1) palette roles the engine wires to CSS variables. */
type DesignThemeColors = {
  bg: string;
  surface: string;
  ink: string;
  body: string;
  muted: string;
  border: string;
  accent: string;
  onAccent: string;
};

/** Type scale, in px (sizes) / unitless (weight, lineHeight). Slide-safe clamps applied. */
type DesignTypeScale = {
  titleSize: number;
  headingSize: number;
  bodySize: number;
  captionSize: number;
  titleWeight: number;
  bodyWeight: number;
  lineHeight: number;
};

/** Spacing rhythm in px. `scale` is an ascending list of distinct step values. */
type DesignSpacing = {
  unit: number;
  scale: number[];
  rhythm: number;
};

/** Corner radii in px. `full` is the pill radius (>= 1000 when present). */
type DesignRadii = {
  sm: number;
  md: number;
  lg: number;
  full: number;
};

type DesignBorders = {
  width: number;
  style: 'solid' | 'dashed' | 'dotted';
};

type DesignDensity = 'compact' | 'comfortable' | 'spacious';
type DesignContrast = 'low' | 'normal' | 'high';
type DesignCorner = 'sharp' | 'soft' | 'round';
type DesignDivider = 'none' | 'hairline' | 'rule';
type DesignMotion = 'restrained' | 'standard';

/** Tone — adjectives detected in the prose, mapped to concrete design knobs. */
type DesignTone = {
  adjectives: string[];
  density: DesignDensity;
  contrast: DesignContrast;
  corner: DesignCorner;
  divider: DesignDivider;
  motion: DesignMotion;
  dark: boolean;
};

/** Which signature elements the design.md actually mentions. */
type DesignSignature = {
  kicker: boolean;
  divider: boolean;
  sectionHeader: boolean;
  card: boolean;
  callout: boolean;
  footerCounter: boolean;
};

export type DesignTheme = {
  source: { hash: string; length: number };
  colors: DesignThemeColors;
  type: DesignTypeScale;
  spacing: DesignSpacing;
  radii: DesignRadii;
  borders: DesignBorders;
  shadows: string[];
  tone: DesignTone;
  signature: DesignSignature;
};

export type ChecklistItem = { id: string; label: string; ok: boolean; detail: string };
/** User-selected presentation controls. They override design tone where applicable. */
export type HtmlExportPresentation = {
  density?: 'compact' | 'normal' | 'roomy';
  readableWidth?: 'narrow' | 'normal' | 'wide';
};

/** Resolved slide geometry shared by the planner and rendered deck CSS. */
export type HtmlExportSlideGeometry = {
  padding: number;
  navReserve: number;
};

export type ChecklistResult = { passed: boolean; items: ChecklistItem[] };

// ---------------------------------------------------------------------------
// Defaults (light, neutral, slide-safe)
// ---------------------------------------------------------------------------

const DEFAULT_COLORS: DesignThemeColors = {
  bg: '#ffffff',
  surface: '#f5f6f8',
  ink: '#18181b',
  body: '#3f3f46',
  muted: '#71717a',
  border: '#e4e4e7',
  accent: '#2563eb',
  onAccent: '#ffffff',
};

const DEFAULT_TYPE: DesignTypeScale = {
  titleSize: 48,
  headingSize: 28,
  bodySize: 16,
  captionSize: 12,
  titleWeight: 700,
  bodyWeight: 400,
  lineHeight: 1.5,
};

const DEFAULT_SPACING_SCALE = [4, 8, 12, 16, 24, 32, 48, 64];

// Slide-safe bounds — a theme rule must never be able to overflow a slide.
const TITLE_MIN = 24;
const TITLE_MAX = 96;
const HEADING_MIN = 16;
const HEADING_MAX = 48;
const BODY_MIN = 12;
const BODY_MAX = 24;
const CAPTION_MIN = 10;
const CAPTION_MAX = 18;
const RHYTHM_MIN = 16;
const RHYTHM_MAX = 160;

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function clamp(n: number, min: number, max: number): number {
  return n < min ? min : n > max ? max : n;
}

/** Format a number for CSS: integers bare, otherwise 2dp without trailing zeros. */
function cssNum(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 100) / 100);
}

/** Stable 32-bit FNV-1a hash → 8-char hex. Deterministic, no crypto/node. */
export function stableHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // h *= 16777619, kept in 32-bit space via Math.imul
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Lower median (deterministic for even-length inputs). Empty → NaN. */
function lowerMedian(nums: number[]): number {
  if (nums.length === 0) return NaN;
  const sorted = [...nums].sort((a, b) => a - b);
  return sorted[(sorted.length - 1) >> 1];
}

function uniqAsc(nums: number[]): number[] {
  return [...new Set(nums)].sort((a, b) => a - b);
}

const COLOR_RE = /(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\))/;
const COLOR_RE_G = /(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\))/g;

function isValidColorToken(tok: string): boolean {
  if (tok.startsWith('#')) {
    const len = tok.length - 1;
    return len === 3 || len === 4 || len === 6 || len === 8;
  }
  return /^(?:rgba?|hsla?)\(/i.test(tok);
}

// ---------------------------------------------------------------------------
// Colour parsing + WCAG-ish contrast
// ---------------------------------------------------------------------------

const NAMED_RGB: Record<string, [number, number, number]> = {
  white: [255, 255, 255],
  black: [0, 0, 0],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  red: [255, 0, 0],
  green: [0, 128, 0],
  blue: [0, 0, 255],
};

/** Parse a hex / rgb()/rgba() / hsl()/hsla() / basic named colour to [r,g,b] 0..255. */
export function parseColorToRgb(input: string): [number, number, number] | null {
  const c = input.trim().toLowerCase();
  if (NAMED_RGB[c]) return NAMED_RGB[c];

  if (c.startsWith('#')) {
    const hex = c.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const r = parseInt(hex[0] + hex[0], 16);
      const g = parseInt(hex[1] + hex[1], 16);
      const b = parseInt(hex[2] + hex[2], 16);
      return [r, g, b];
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      return [r, g, b];
    }
    return null;
  }

  const rgbM = c.match(/^rgba?\(([^)]*)\)$/);
  if (rgbM) {
    const parts = rgbM[1].split(/[,/\s]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const ch = (p: string): number => {
      if (p.endsWith('%')) return clamp(Math.round((parseFloat(p) / 100) * 255), 0, 255);
      return clamp(Math.round(parseFloat(p)), 0, 255);
    };
    const r = ch(parts[0]);
    const g = ch(parts[1]);
    const b = ch(parts[2]);
    if ([r, g, b].some((n) => Number.isNaN(n))) return null;
    return [r, g, b];
  }

  const hslM = c.match(/^hsla?\(([^)]*)\)$/);
  if (hslM) {
    const parts = hslM[1].split(/[,/\s]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const h = parseFloat(parts[0]);
    const s = parseFloat(parts[1]) / 100;
    const l = parseFloat(parts[2]) / 100;
    if ([h, s, l].some((n) => Number.isNaN(n))) return null;
    return hslToRgb(h, s, l);
  }

  return null;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hh = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hh < 60) [r, g, b] = [c, x, 0];
  else if (hh < 120) [r, g, b] = [x, c, 0];
  else if (hh < 180) [r, g, b] = [0, c, x];
  else if (hh < 240) [r, g, b] = [0, x, c];
  else if (hh < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [
    clamp(Math.round((r + m) * 255), 0, 255),
    clamp(Math.round((g + m) * 255), 0, 255),
    clamp(Math.round((b + m) * 255), 0, 255),
  ];
}

function relLuminance([r, g, b]: [number, number, number]): number {
  const lin = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio (1..21). Returns null if either colour is unparseable. */
export function contrastRatio(a: string, b: string): number | null {
  const ca = parseColorToRgb(a);
  const cb = parseColorToRgb(b);
  if (!ca || !cb) return null;
  const la = relLuminance(ca);
  const lb = relLuminance(cb);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Extraction — colours
// ---------------------------------------------------------------------------

type ColorSlot = keyof DesignThemeColors;

// Ordered: first matching slot wins per line. onAccent before accent so
// "on-primary" is not eaten by the accent "primary" keyword.
const ROLE_PATTERNS: { slot: ColorSlot; re: RegExp }[] = [
  { slot: 'onAccent', re: /\b(?:on[-\s]?(?:primary|accent|brand|cta|dark)|text[-\s]?on[-\s]?(?:dark|primary|accent))\b/i },
  { slot: 'bg', re: /\b(?:background|canvas|page[-\s]?bg|backdrop|base[-\s]?bg|body[-\s]?bg)\b/i },
  { slot: 'surface', re: /\b(?:surface|card|panel|sheet|paper|well|tile)\b/i },
  { slot: 'border', re: /\b(?:border|hairline|divider|rule|outline|stroke|separator)\b/i },
  { slot: 'accent', re: /\b(?:accent|primary|brand|cta|highlight|link|hero|action)\b/i },
  { slot: 'muted', re: /\b(?:muted|mute|secondary|subtle|caption|ash|charcoal|stone|meta|tertiary|placeholder)\b/i },
  { slot: 'ink', re: /\b(?:ink|heading|headline|foreground|fg|title|on[-\s]?light|text[-\s]?(?:strong|primary))\b/i },
  { slot: 'body', re: /\b(?:body|text|copy|prose|content|paragraph)\b/i },
];

function extractColors(lines: string[]): DesignThemeColors {
  const found: Partial<Record<ColorSlot, string>> = {};
  for (const raw of lines) {
    const m = raw.match(COLOR_RE);
    if (!m) continue;
    const color = m[1];
    if (!isValidColorToken(color)) continue;
    for (const { slot, re } of ROLE_PATTERNS) {
      if (found[slot]) continue;
      if (re.test(raw)) {
        found[slot] = color;
        break;
      }
    }
  }
  return { ...DEFAULT_COLORS, ...found };
}

// ---------------------------------------------------------------------------
// Extraction — type scale
// ---------------------------------------------------------------------------

function pxOnLines(lines: string[], re: RegExp): number[] {
  const out: number[] = [];
  for (const ln of lines) {
    if (!re.test(ln)) continue;
    for (const m of ln.matchAll(/(\d+(?:\.\d+)?)\s*px/gi)) out.push(parseFloat(m[1]));
  }
  return out;
}

function allMatches(text: string, re: RegExp): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(re)) out.push(parseFloat(m[1]));
  return out;
}

/**
 * Attribute indented YAML-ish values to their block header so that, e.g.,
 * `sm: 6px` under a bare `rounded:` line is recognised as a radius. Each output
 * line is prefixed with the current block keyword (from a bare `key:` line or a
 * markdown heading). Deterministic — order-preserving single pass.
 */
function augmentLines(lines: string[]): string[] {
  let block = '';
  const out: string[] = [];
  for (const ln of lines) {
    if (/^\s*$/.test(ln)) {
      block = '';
      out.push(ln);
      continue;
    }
    const bareKey = ln.match(/^\s*([A-Za-z][\w-]*)\s*:\s*$/);
    const mdHead = ln.match(/^\s{0,3}#{1,6}\s+(.*\S)\s*$/);
    if (bareKey) block = bareKey[1].toLowerCase();
    else if (mdHead) block = mdHead[1].toLowerCase();
    out.push(block ? `${block} ${ln}` : ln);
  }
  return out;
}

function extractType(text: string, lines: string[]): DesignTypeScale {
  const titlePx = pxOnLines(lines, /\b(?:display|hero|h1|title|headline)\b/i);
  const headingPx = pxOnLines(lines, /\b(?:heading|h2|h3|subtitle|sub-title)\b/i);
  const bodyPx = pxOnLines(lines, /\b(?:body|paragraph|prose|copy)\b/i).filter((n) => n >= 10 && n <= 28);
  const captionPx = pxOnLines(lines, /\b(?:caption|small|footnote|meta|label)\b/i).filter((n) => n >= 8);

  const titleSize = clamp(titlePx.length ? Math.max(...titlePx) : DEFAULT_TYPE.titleSize, TITLE_MIN, TITLE_MAX);
  const headingSize = clamp(
    headingPx.length ? Math.max(...headingPx) : Math.round(titleSize * 0.5),
    HEADING_MIN,
    HEADING_MAX,
  );
  const bodySize = clamp(bodyPx.length ? lowerMedian(bodyPx) : DEFAULT_TYPE.bodySize, BODY_MIN, BODY_MAX);
  const captionSize = clamp(
    captionPx.length ? Math.min(...captionPx) : DEFAULT_TYPE.captionSize,
    CAPTION_MIN,
    CAPTION_MAX,
  );

  const weights = allMatches(text, /(?:font-?weight|fontweight|weight)\s*:?\s*(\d{3})/gi).filter(
    (n) => n >= 100 && n <= 900,
  );
  const titleWeight = weights.length ? Math.max(...weights) : DEFAULT_TYPE.titleWeight;
  const bodyWeight = weights.length ? Math.min(...weights) : DEFAULT_TYPE.bodyWeight;

  const lineHeights = allMatches(text, /(?:line-?height|lineheight)\s*:?\s*([0-9]+(?:\.[0-9]+)?)\b/gi).filter(
    (n) => n >= 0.8 && n <= 2.4,
  );
  const inBand = lineHeights.filter((n) => n >= 1.2 && n <= 1.8);
  let lineHeight = DEFAULT_TYPE.lineHeight;
  if (inBand.length) {
    inBand.sort((a, b) => Math.abs(a - 1.5) - Math.abs(b - 1.5) || a - b);
    lineHeight = inBand[0];
  }

  return { titleSize, headingSize, bodySize, captionSize, titleWeight, bodyWeight, lineHeight };
}

// ---------------------------------------------------------------------------
// Extraction — spacing, radii, borders, shadows
// ---------------------------------------------------------------------------

function extractSpacing(lines: string[]): DesignSpacing {
  const spacingPx = pxOnLines(
    lines,
    /\b(?:spacing|space|padding|margin|gap|rhythm|base[-\s]?unit|whitespace|section|band|gutter)\b/i,
  ).filter((n) => n > 0 && n <= 400);

  const baseUnitPx = pxOnLines(lines, /\bbase[-\s]?unit\b/i).filter((n) => n > 0);
  let unit = 4;
  if (baseUnitPx.length) unit = Math.min(...baseUnitPx);
  else {
    const small = spacingPx.filter((n) => n >= 4).sort((a, b) => a - b);
    if (small.length) unit = small[0];
  }
  unit = clamp(unit, 2, 16);

  const scale = spacingPx.length ? uniqAsc(spacingPx).slice(0, 8) : [...DEFAULT_SPACING_SCALE];

  const rhythmPx = pxOnLines(lines, /\b(?:section|band|rhythm|whitespace)\b/i).filter((n) => n > 0);
  const rhythm = clamp(rhythmPx.length ? Math.max(...rhythmPx) : 48, RHYTHM_MIN, RHYTHM_MAX);

  return { unit, scale, rhythm };
}

function extractRadii(lines: string[]): DesignRadii {
  const px = pxOnLines(lines, /\b(?:radius|rounded|corner|border-radius|pill)\b/i).filter((n) => n >= 0);
  const all = uniqAsc(px);
  const big = all.filter((n) => n >= 1000);
  const small = all.filter((n) => n > 0 && n < 1000);

  const full = big.length ? big[big.length - 1] : /\b(?:full|pill|9999)\b/.test(lines.join('\n')) ? 9999 : 9999;
  const sm = small.length ? small[0] : 4;
  const lg = small.length ? small[small.length - 1] : 16;
  const md = small.length ? small[(small.length - 1) >> 1] : 8;

  return { sm, md, lg, full };
}

function extractBorders(lines: string[]): DesignBorders {
  const widths = pxOnLines(lines, /\b(?:border|hairline|stroke|rule|divider|outline)\b/i).filter((n) => n > 0);
  const width = widths.length ? clamp(Math.min(...widths), 0.5, 4) : 1;
  const joined = lines.join('\n');
  const style: DesignBorders['style'] = /\bdashed\b/i.test(joined)
    ? 'dashed'
    : /\bdotted\b/i.test(joined)
      ? 'dotted'
      : 'solid';
  return { width, style };
}

function extractShadows(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(\d+px\s+\d+px(?:\s+\d+px)?(?:\s+-?\d+px)?\s+rgba?\([^)]*\))/gi)) {
    const s = m[1].trim().replace(/\s+/g, ' ');
    if (!out.includes(s)) out.push(s);
    if (out.length >= 3) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Extraction — tone + signature
// ---------------------------------------------------------------------------

const TONE_VOCAB = [
  'minimal',
  'editorial',
  'playful',
  'enterprise',
  'warm',
  'technical',
  'dark',
  'bold',
  'elegant',
  'modern',
  'classic',
  'clean',
  'dense',
  'compact',
  'spacious',
  'airy',
  'friendly',
  'serious',
  'corporate',
  'vibrant',
  'muted',
  'monochrome',
  'brutalist',
  'retro',
  'futuristic',
  'luxurious',
  'professional',
  'geometric',
  'organic',
  'precise',
];

function extractTone(text: string, colors: DesignThemeColors): DesignTone {
  const lower = text.toLowerCase();
  const has = (w: string): boolean => new RegExp(`\\b${w}\\b`, 'i').test(lower);
  const adjectives = TONE_VOCAB.filter((w) => has(w));

  const density: DesignDensity = has('compact') || has('dense')
    ? 'compact'
    : has('spacious') || has('airy') || has('editorial') || has('generous')
      ? 'spacious'
      : 'comfortable';

  const contrast: DesignContrast = has('bold') || has('vibrant') || has('brutalist')
    ? 'high'
    : has('muted') || has('subtle') || has('minimal')
      ? 'low'
      : 'normal';

  const corner: DesignCorner = has('sharp') || has('geometric') || has('brutalist')
    ? 'sharp'
    : has('round') || has('rounded') || has('pill') || has('friendly') || has('soft')
      ? 'round'
      : 'soft';

  const divider: DesignDivider = /\b(?:borderless|no divider|no rule)\b/i.test(lower)
    ? 'none'
    : has('hairline')
      ? 'hairline'
      : has('divider') || has('rule')
        ? 'rule'
        : 'hairline';

  const motion: DesignMotion = has('playful') || has('animated') || has('motion') || has('lively')
    ? 'standard'
    : 'restrained';

  const bgRgb = parseColorToRgb(colors.bg);
  const dark = has('dark') || (bgRgb ? relLuminance(bgRgb) < 0.2 : false);

  return { adjectives, density, contrast, corner, divider, motion, dark };
}

function extractSignature(text: string): DesignSignature {
  const has = (re: RegExp): boolean => re.test(text);
  return {
    kicker: has(/\b(?:kicker|eyebrow|overline|tagline)\b/i),
    divider: has(/\b(?:dividers?|hairlines?|rules?|separators?)\b/i),
    sectionHeader: has(/\bsection[-\s]?(?:header|title|heading|opener)s?\b/i) || /(^|\n)\s{0,3}#{2,}\s/.test(text),
    card: has(/\b(?:cards?|tiles?|panels?|wells?)\b/i),
    callout: has(/\b(?:callouts?|admonitions?|asides?|note box|banners?)\b/i),
    footerCounter: has(/\b(?:footer|counter|page number|pagination|slide number)\b/i),
  };
}

// ---------------------------------------------------------------------------
// parseDesignTheme
// ---------------------------------------------------------------------------

/** Parse the freeform text of a design.md into a structured, deterministic theme. */
export function parseDesignTheme(designMd: string): DesignTheme {
  const text = typeof designMd === 'string' ? designMd : '';
  const lines = text.split(/\r?\n/);
  const aug = augmentLines(lines);

  const colors = extractColors(lines);
  const type = extractType(text, aug);
  const spacing = extractSpacing(aug);
  const radii = extractRadii(aug);
  const borders = extractBorders(aug);
  const shadows = extractShadows(text);
  const tone = extractTone(text, colors);
  const signature = extractSignature(text);

  return {
    source: { hash: stableHash(text), length: text.length },
    colors,
    type,
    spacing,
    radii,
    borders,
    shadows,
    tone,
    signature,
  };
}

// ---------------------------------------------------------------------------
// toCssVariables
// ---------------------------------------------------------------------------

function densityFactor(density: DesignDensity, presentation?: HtmlExportPresentation): number {
  const userDensity = presentation?.density;
  if (userDensity === 'compact') return 0.6;
  if (userDensity === 'normal') return 0.8;
  if (userDensity === 'roomy') return 1;
  return density === 'compact' ? 0.6 : density === 'spacious' ? 1 : 0.8;
}

function readableWidth(width: HtmlExportPresentation['readableWidth']): string {
  if (width === 'narrow') return 'clamp(640px, 72vw, 860px)';
  if (width === 'wide') return 'clamp(820px, 88vw, 1280px)';
  return 'clamp(720px, 80vw, 1040px)';
}

function resolvedShadow(theme: DesignTheme): string {
  if (theme.shadows.length) return theme.shadows[0];
  if (theme.tone.dark) return '0 8px 24px rgba(0, 0, 0, 0.32)';
  if (theme.tone.contrast === 'high') return '0 2px 0 rgba(24, 24, 27, 0.18)';
  return '0 8px 24px rgba(24, 24, 27, 0.12)';
}

function headingUsesAccent(theme: DesignTheme): boolean {
  const bgContrast = contrastRatio(theme.colors.accent, theme.colors.bg);
  const surfaceContrast = contrastRatio(theme.colors.accent, theme.colors.surface);
  return bgContrast !== null && surfaceContrast !== null && bgContrast >= HEADING_ACCENT_CONTRAST_MIN && surfaceContrast >= HEADING_ACCENT_CONTRAST_MIN;
}

export function resolveHtmlExportSlideGeometry(
  theme: DesignTheme,
  presentation?: HtmlExportPresentation,
): HtmlExportSlideGeometry {
  const rhythm = Math.round(clamp(theme.spacing.rhythm * densityFactor(theme.tone.density, presentation), RHYTHM_MIN, RHYTHM_MAX));
  return {
    padding: rhythm,
    navReserve: 80 + Math.round(rhythm / 2) * 2,



  };
}

function toneRadius(theme: DesignTheme): number {
  const { corner } = theme.tone;
  if (corner === 'sharp') return 0;
  if (corner === 'round') return theme.radii.lg;
  return theme.radii.md;
}

function dividerWidth(theme: DesignTheme): number {
  const { divider } = theme.tone;
  if (divider === 'none') return 0;
  if (divider === 'rule') return Math.max(theme.borders.width, 2);
  return theme.borders.width;
}

/**
 * Emit deterministic `:root` CSS custom properties. Only custom properties are
 * emitted here — never `width`/`height` declarations — so this can never cause
 * slide overflow. Identical theme → identical string.
 */
export function toCssVariables(theme: DesignTheme, presentation?: HtmlExportPresentation): string {
  const c = theme.colors;
  const t = theme.type;
  const rhythm = resolveHtmlExportSlideGeometry(theme, presentation).padding;

  const radius = toneRadius(theme);
  const bw = dividerWidth(theme);
  const headingWeight = theme.tone.contrast === 'high' ? Math.min(900, t.titleWeight + 100) : t.titleWeight;
  const headingTracking = theme.tone.contrast === 'high' ? '-0.02em' : theme.tone.contrast === 'low' ? '0.01em' : '0';
  const headingColor = headingUsesAccent(theme) ? c.accent : c.ink;

  const out: string[] = [];
  out.push(':root {');
  out.push('  /* palette */');
  out.push(`  --he-bg: ${c.bg};`);
  out.push(`  --he-surface: ${c.surface};`);
  out.push(`  --he-ink: ${c.ink};`);
  out.push(`  --he-body: ${c.body};`);
  out.push(`  --he-muted: ${c.muted};`);
  out.push(`  --he-border: ${c.border};`);
  out.push(`  --he-accent: ${c.accent};`);
  out.push(`  --he-on-accent: ${c.onAccent};`);
  out.push(`  --he-accent-tint: color-mix(in srgb, ${c.accent} 12%, ${c.surface});`);
  out.push(`  --he-heading-color: ${headingColor};`);
  out.push(`  --he-shadow: ${resolvedShadow(theme)};`);
  out.push('  /* type scale */');
  out.push(`  --he-title-size: ${cssNum(t.titleSize)}px;`);
  out.push(`  --he-heading-size: ${cssNum(t.headingSize)}px;`);
  out.push(`  --he-body-size: ${cssNum(t.bodySize)}px;`);
  out.push(`  --he-caption-size: ${cssNum(t.captionSize)}px;`);
  out.push(`  --he-title-weight: ${cssNum(t.titleWeight)};`);
  out.push(`  --he-heading-weight: ${cssNum(headingWeight)};`);
  out.push(`  --he-heading-tracking: ${headingTracking};`);
  out.push(`  --he-body-weight: ${cssNum(t.bodyWeight)};`);
  out.push(`  --he-line-height: ${cssNum(t.lineHeight)};`);
  out.push('  /* spacing scale */');
  theme.spacing.scale.forEach((step, i) => {
    out.push(`  --he-space-${i + 1}: ${cssNum(step)}px;`);
  });
  out.push(`  --he-rhythm: ${cssNum(rhythm)}px;`);
  out.push(`  --he-rhythm-sm: ${cssNum(Math.round(rhythm / 2))}px;`);
  out.push(`  --he-rhythm-lg: ${cssNum(Math.round(rhythm * 1.5))}px;`);
  out.push(`  --he-component-padding: ${cssNum(Math.round(rhythm / 3))}px;`);
  out.push(`  --he-readable-width: ${readableWidth(presentation?.readableWidth)};`);
  out.push(`  --he-slide-pad: ${cssNum(rhythm)}px;`);
  out.push(`  --he-nav-reserve: ${cssNum(80 + Math.round(rhythm / 2) * 2)}px;`);


  out.push('  /* shape + tone */');
  out.push(`  --he-radius: ${cssNum(radius)}px;`);
  out.push(`  --he-radius-sm: ${cssNum(theme.radii.sm)}px;`);
  out.push(`  --he-radius-md: ${cssNum(theme.radii.md)}px;`);
  out.push(`  --he-radius-lg: ${cssNum(theme.radii.lg)}px;`);
  out.push(`  --he-radius-full: ${cssNum(theme.radii.full)}px;`);
  out.push(`  --he-border-width: ${cssNum(bw)}px;`);
  out.push('}');
  return out.join('\n');
}


// ---------------------------------------------------------------------------
// themeComponentClasses
// ---------------------------------------------------------------------------

/**
 * Emit deterministic component classes for the slide/scroll signature elements,
 * wired to the CSS variables above. No fixed px width/height is ever emitted
 * (only `max-width:100%` + percentages + var-based spacing) so these rules are
 * containment-safe and cannot overflow a slide.
 */
export function themeComponentClasses(theme: DesignTheme): string {
  const dividerStyle = theme.tone.divider === 'none' ? 'none' : theme.borders.style;
  const kickerWeight = theme.tone.contrast === 'high' ? 700 : 600;
  return [
    '.he-kicker {',
    '  display: inline-block;',
    '  font-size: max(16px, var(--he-caption-size));',



    `  font-weight: ${kickerWeight};`,
    '  letter-spacing: var(--he-heading-tracking);',
    '  text-transform: uppercase;',
    '  color: var(--he-muted);',
    '  margin-bottom: var(--he-rhythm-sm);',
    '}',
    '.he-divider {',
    '  border: 0;',
    `  border-top: var(--he-border-width) ${dividerStyle} var(--he-border);`,
    '  margin: var(--he-rhythm-sm) 0;',
    '  max-width: 100%;',
    '}',
    '.he-section-header {',
    '  font-size: var(--he-heading-size);',
    '  font-weight: var(--he-heading-weight);',
    '  letter-spacing: var(--he-heading-tracking);',
    '  line-height: var(--he-line-height);',
    '  color: var(--he-heading-color);',
    '  margin-bottom: var(--he-rhythm-sm);',
    '  max-width: 100%;',
    '}',
    '.he-card {',
    '  background: var(--he-surface);',
    '  color: var(--he-body);',
    '  border: var(--he-border-width) solid var(--he-border);',
    '  border-radius: var(--he-radius);',
    '  box-shadow: var(--he-shadow);',
    '  padding: var(--he-component-padding);',
    '  max-width: 100%;',
    '  box-sizing: border-box;',
    '}',
    '.he-callout {',
    '  background: var(--he-surface);',
    '  background: var(--he-accent-tint);',
    '  color: var(--he-body);',
    '  border-left: 3px solid var(--he-accent);',
    '  border-radius: var(--he-radius-sm);',
    '  box-shadow: var(--he-shadow);',
    '  padding: var(--he-component-padding);',
    '  max-width: 100%;',
    '  box-sizing: border-box;',
    '}',
    '.he-footer-counter {',
    '  font-size: max(16px, var(--he-caption-size));',
    '  color: var(--he-muted);',
    '}',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// evaluateDesignChecklist
// ---------------------------------------------------------------------------

const REQUIRED_COLOR_VARS = [
  '--he-bg',
  '--he-surface',
  '--he-ink',
  '--he-body',
  '--he-muted',
  '--he-border',
  '--he-accent',
];

const SIGNATURE_CLASS: Record<keyof DesignSignature, string> = {
  kicker: '.he-kicker',
  divider: '.he-divider',
  sectionHeader: '.he-section-header',
  card: '.he-card',
  callout: '.he-callout',
  footerCounter: '.he-footer-counter',
};

// AA normal-text contrast for body, UI-component contrast for the accent chip,
// and accent-colored headings against every surface they can occupy.
const BODY_CONTRAST_MIN = 4.5;
const ACCENT_CONTRAST_MIN = 3;
const HEADING_ACCENT_CONTRAST_MIN = 4.5;


// A slide is at most this big; a fixed px width/height beyond it overflows.
const SLIDE_MAX_W = 1280;
const SLIDE_MAX_H = 720;

/** Scan CSS for fixed `width`/`height` px declarations that would overflow a slide. */
function findOverflowDims(css: string): string[] {
  const bad: string[] = [];
  for (const m of css.matchAll(/(?:^|[\s;{])(max-|min-)?(width|height)\s*:\s*(\d+(?:\.\d+)?)px/gi)) {
    const prefix = m[1];
    const prop = m[2].toLowerCase();
    const val = parseFloat(m[3]);
    if (prefix) {
      // max-/min- constraints are fine unless absurdly large.
      if (val > 5000) bad.push(`${prefix}${prop}:${val}px`);
      continue;
    }
    if (prop === 'width' && val > SLIDE_MAX_W) bad.push(`width:${val}px`);
    if (prop === 'height' && val > SLIDE_MAX_H) bad.push(`height:${val}px`);
  }
  return bad;
}

/** Scan CSS for external / remote font + asset references. */
function findExternalAssets(css: string): string[] {
  const bad: string[] = [];
  if (/@import\b/i.test(css)) bad.push('@import');
  if (/url\(\s*['"]?https?:/i.test(css)) bad.push('url(http…)');
  if (/url\(\s*['"]?\/\//i.test(css)) bad.push('url(//…)');
  if (/src\s*:\s*url\(\s*['"]?https?:/i.test(css)) bad.push('src:url(http…)');
  return bad;
}

/**
 * Evaluate the fixed 8-point design-compliance checklist against a design.md,
 * its parsed theme, and the CSS produced from that theme. Pure + deterministic.
 */
export function evaluateDesignChecklist(args: {
  designMd: string;
  theme: DesignTheme;
  css: string;
}): ChecklistResult {
  const { designMd, theme, css } = args;
  const items: ChecklistItem[] = [];

  // 1 — design source / hash recorded.
  const recomputed = stableHash(typeof designMd === 'string' ? designMd : '');
  const hashOk = !!theme.source.hash && theme.source.hash === recomputed;
  items.push({
    id: 'source-recorded',
    label: 'Design source recorded (stable hash)',
    ok: hashOk,
    detail: hashOk
      ? `hash ${theme.source.hash} (${theme.source.length} chars)`
      : `recorded ${theme.source.hash || '∅'} ≠ recomputed ${recomputed}`,
  });

  // 2 — palette tokens mapped + body/accent contrast checked.
  const varsMapped = REQUIRED_COLOR_VARS.filter((v) => !css.includes(v));
  const bodyContrast = contrastRatio(theme.colors.body, theme.colors.bg);
  const accentContrast = contrastRatio(theme.colors.onAccent, theme.colors.accent);
  const contrastOk =
    bodyContrast !== null &&
    accentContrast !== null &&
    bodyContrast >= BODY_CONTRAST_MIN &&
    accentContrast >= ACCENT_CONTRAST_MIN;
  const paletteOk = varsMapped.length === 0 && contrastOk;
  items.push({
    id: 'palette-contrast',
    label: 'Palette mapped + body/accent contrast',
    ok: paletteOk,
    detail:
      varsMapped.length > 0
        ? `unmapped vars: ${varsMapped.join(', ')}`
        : `body/bg ${bodyContrast ?? '?'} (≥${BODY_CONTRAST_MIN}), on-accent/accent ${accentContrast ?? '?'} (≥${ACCENT_CONTRAST_MIN})`,
  });
  // 3 — heading accent is usable on both canvas and component surfaces, or falls back to ink.
  const headingUsesThemeAccent = headingUsesAccent(theme);
  const headingColor = headingUsesThemeAccent ? theme.colors.accent : theme.colors.ink;
  const headingColorMapped = css.includes(`--he-heading-color: ${headingColor};`);
  const headingBgContrast = contrastRatio(theme.colors.accent, theme.colors.bg);
  const headingSurfaceContrast = contrastRatio(theme.colors.accent, theme.colors.surface);
  const headingContrastOk =
    headingColorMapped &&
    (!headingUsesThemeAccent ||
      (headingBgContrast !== null &&
        headingSurfaceContrast !== null &&
        headingBgContrast >= HEADING_ACCENT_CONTRAST_MIN &&
        headingSurfaceContrast >= HEADING_ACCENT_CONTRAST_MIN));
  items.push({
    id: 'heading-accent-contrast',
    label: 'Heading accent contrast or ink fallback',
    ok: headingContrastOk,
    detail: headingUsesThemeAccent
      ? `accent/bg ${headingBgContrast ?? '?'} and accent/surface ${headingSurfaceContrast ?? '?'} (≥${HEADING_ACCENT_CONTRAST_MIN})`
      : `ink fallback (accent/bg ${headingBgContrast ?? '?'}, accent/surface ${headingSurfaceContrast ?? '?'})`,
  });


  // 4 — type scale applied to title/heading/body/caption.

  const typeVars = ['--he-title-size', '--he-heading-size', '--he-body-size', '--he-caption-size'];
  const missingType = typeVars.filter((v) => !css.includes(v));
  const monotonic =
    theme.type.titleSize >= theme.type.headingSize &&
    theme.type.headingSize >= theme.type.bodySize &&
    theme.type.bodySize >= theme.type.captionSize;
  const typeOk = missingType.length === 0 && monotonic;
  items.push({
    id: 'type-scale',
    label: 'Type scale applied (title→caption)',
    ok: typeOk,
    detail: missingType.length
      ? `missing vars: ${missingType.join(', ')}`
      : `${theme.type.titleSize}/${theme.type.headingSize}/${theme.type.bodySize}/${theme.type.captionSize}px${monotonic ? '' : ' (not monotonic)'}`,
  });

  // 5 — spacing scale applied.

  const spacingOk = /--he-space-1\b/.test(css) && css.includes('--he-rhythm');
  items.push({
    id: 'spacing-scale',
    label: 'Spacing scale applied',
    ok: spacingOk,
    detail: spacingOk ? `unit ${theme.spacing.unit}px, rhythm ${theme.spacing.rhythm}px` : 'missing --he-space-*/--he-rhythm',
  });

  // 6 — required signature elements present when design.md mentions them.

  const sig = theme.signature;
  const required = (Object.keys(SIGNATURE_CLASS) as (keyof DesignSignature)[]).filter((k) => sig[k]);
  const missingSig = required.filter((k) => !css.includes(SIGNATURE_CLASS[k]));
  const sigOk = missingSig.length === 0;
  items.push({
    id: 'signature-elements',
    label: 'Signature elements present when mentioned',
    ok: sigOk,
    detail: missingSig.length
      ? `mentioned but missing: ${missingSig.map((k) => SIGNATURE_CLASS[k]).join(', ')}`
      : required.length
        ? `present: ${required.map((k) => SIGNATURE_CLASS[k]).join(', ')}`
        : 'none mentioned',
  });

  // 7 — tone traits mapped to concrete vars/classes.

  const toneVars = ['--he-radius', '--he-rhythm', '--he-border-width'];
  const missingTone = toneVars.filter((v) => !css.includes(v));
  const toneOk = missingTone.length === 0;
  items.push({
    id: 'tone-mapped',
    label: 'Tone mapped to concrete vars',
    ok: toneOk,
    detail: toneOk
      ? `corner=${theme.tone.corner}, density=${theme.tone.density}, divider=${theme.tone.divider}`
      : `missing vars: ${missingTone.join(', ')}`,
  });

  // 8 — no theme rule can cause overflow (no oversize fixed px dims).

  const overflow = findOverflowDims(css);
  const overflowOk = overflow.length === 0;
  items.push({
    id: 'no-overflow',
    label: 'No fixed oversize width/height',
    ok: overflowOk,
    detail: overflowOk ? 'no fixed oversize dimensions' : `offending: ${overflow.join(', ')}`,
  });

  // 9 — no external fonts/assets referenced.
  const external = findExternalAssets(css);
  const externalOk = external.length === 0;
  items.push({
    id: 'no-external-assets',
    label: 'No external fonts/assets',
    ok: externalOk,
    detail: externalOk ? 'offline-safe (no @import/remote url)' : `offending: ${external.join(', ')}`,
  });

  return { passed: items.every((i) => i.ok), items };
}
