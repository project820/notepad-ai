import { describe, it, expect } from 'vitest';
import {
  parseDesignTheme,
  toCssVariables,
  themeComponentClasses,
  evaluateDesignChecklist,
  contrastRatio,
  parseColorToRgb,
  stableHash,
  type DesignTheme,
  type ChecklistItem,
} from '../renderer/html-export-theme';

// A compliant, representative design.md: YAML-ish frontmatter (colors / type /
// spacing / radii) + prose tone words + signature-element mentions.
const SAMPLE = `# Acme — design system

A minimal, editorial, warm brand identity. Generous whitespace with hairline dividers.

colors:
  background: #f8f5ef
  surface: #ffffff
  ink: #161616
  body: #2e2e2e
  muted: #6b6b6b
  border: #e2ddd2
  primary: #c2410c
  on-primary: #ffffff

typography:
  display title: 64px, weight 700
  heading: 32px, weight 600
  body text: 16px, weight 400, line-height 1.6
  caption: 12px, weight 400

spacing:
  base unit: 4px
  spacing scale: 4px 8px 12px 16px 24px 32px
  section rhythm: 72px

rounded:
  sm: 6px
  md: 12px
  lg: 20px
  full: 9999px

borders: 1px hairline

Signature elements: a kicker / eyebrow above each section header, a hairline
divider / rule between bands, content cards, and a callout box. The footer shows
a page counter.
`;

const item = (items: ChecklistItem[], id: string): ChecklistItem => {
  const found = items.find((i) => i.id === id);
  if (!found) throw new Error(`missing checklist item ${id}`);
  return found;
};

const compliantCss = (theme: DesignTheme): string =>
  `${toCssVariables(theme)}\n${themeComponentClasses(theme)}`;

describe('parseDesignTheme — token / type / spacing extraction', () => {
  const theme = parseDesignTheme(SAMPLE);

  it('maps colour roles from frontmatter', () => {
    expect(theme.colors).toEqual({
      bg: '#f8f5ef',
      surface: '#ffffff',
      ink: '#161616',
      body: '#2e2e2e',
      muted: '#6b6b6b',
      border: '#e2ddd2',
      accent: '#c2410c',
      onAccent: '#ffffff',
    });
  });

  it('extracts the type scale (title/heading/body/caption + weight + line-height)', () => {
    expect(theme.type.titleSize).toBe(64);
    expect(theme.type.headingSize).toBe(32);
    expect(theme.type.bodySize).toBe(16);
    expect(theme.type.captionSize).toBe(12);
    expect(theme.type.titleWeight).toBe(700);
    expect(theme.type.bodyWeight).toBe(400);
    expect(theme.type.lineHeight).toBe(1.6);
  });

  it('extracts the spacing scale + base unit + section rhythm', () => {
    expect(theme.spacing.unit).toBe(4);
    expect(theme.spacing.rhythm).toBe(72);
    expect(theme.spacing.scale).toEqual([4, 8, 12, 16, 24, 32, 72]);
  });

  it('extracts the radius scale (with pill = full)', () => {
    expect(theme.radii).toEqual({ sm: 6, md: 12, lg: 20, full: 9999 });
  });

  it('detects border width', () => {
    expect(theme.borders.width).toBe(1);
    expect(theme.borders.style).toBe('solid');
  });

  it('detects tone adjectives + derived knobs', () => {
    expect(theme.tone.adjectives).toEqual(expect.arrayContaining(['minimal', 'editorial', 'warm']));
    expect(theme.tone.density).toBe('spacious'); // editorial / generous
    expect(theme.tone.contrast).toBe('low'); // minimal
    expect(theme.tone.divider).toBe('hairline');
    expect(theme.tone.dark).toBe(false);
  });

  it('detects mentioned signature elements', () => {
    expect(theme.signature).toEqual({
      kicker: true,
      divider: true,
      sectionHeader: true,
      card: true,
      callout: true,
      footerCounter: true,
    });
  });

  it('records a stable source hash + length', () => {
    expect(theme.source.hash).toBe(stableHash(SAMPLE));
    expect(theme.source.length).toBe(SAMPLE.length);
  });

  it('clamps an oversize display size to a slide-safe maximum', () => {
    const big = parseDesignTheme('typography:\n  display hero: 128px\n');
    expect(big.type.titleSize).toBe(96); // clamped from 128
  });

  it('falls back to sensible defaults for an empty design.md', () => {
    const empty = parseDesignTheme('');
    expect(empty.colors.bg).toBe('#ffffff');
    expect(empty.colors.accent).toBe('#2563eb');
    expect(empty.type.titleSize).toBeGreaterThan(empty.type.bodySize);
    expect(empty.spacing.scale.length).toBeGreaterThan(0);
  });
});

describe('colour helpers', () => {
  it('parses hex / rgb / hsl', () => {
    expect(parseColorToRgb('#fff')).toEqual([255, 255, 255]);
    expect(parseColorToRgb('#000000')).toEqual([0, 0, 0]);
    expect(parseColorToRgb('rgb(255, 0, 0)')).toEqual([255, 0, 0]);
    expect(parseColorToRgb('hsl(0, 100%, 50%)')).toEqual([255, 0, 0]);
    expect(parseColorToRgb('not-a-color')).toBeNull();
  });

  it('computes WCAG contrast ratio', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBe(21);
    expect(contrastRatio('#777777', '#777777')).toBe(1);
  });
});

describe('toCssVariables — required --he-* vars + determinism', () => {
  const theme = parseDesignTheme(SAMPLE);
  const css = toCssVariables(theme);

  it('emits every required CSS variable', () => {
    for (const v of [
      '--he-bg',
      '--he-surface',
      '--he-ink',
      '--he-body',
      '--he-muted',
      '--he-border',
      '--he-accent',
      '--he-on-accent',
      '--he-title-size',
      '--he-space-1',
      '--he-rhythm',
      '--he-radius',
      '--he-border-width',
    ]) {
      expect(css).toContain(v);
    }
  });
  it('emits presentation-readable width and makes every density selection observable', () => {
    const narrow = toCssVariables(theme, { readableWidth: 'narrow', density: 'compact' });
    const normal = toCssVariables(theme, { readableWidth: 'normal', density: 'normal' });
    const wide = toCssVariables(theme, { readableWidth: 'wide', density: 'roomy' });

    expect(narrow).toContain('--he-readable-width: clamp(640px, 72vw, 860px);');
    expect(normal).toContain('--he-readable-width: clamp(720px, 80vw, 1040px);');
    expect(wide).toContain('--he-readable-width: clamp(820px, 88vw, 1280px);');
    expect(narrow.match(/--he-rhythm: (\d+)px;/)?.[1]).not.toBe(normal.match(/--he-rhythm: (\d+)px;/)?.[1]);
    expect(normal.match(/--he-rhythm: (\d+)px;/)?.[1]).not.toBe(wide.match(/--he-rhythm: (\d+)px;/)?.[1]);
  });


  it('binds variables to the extracted palette + sizes', () => {
    expect(css).toContain('--he-bg: #f8f5ef;');
    expect(css).toContain('--he-accent: #c2410c;');
    expect(css).toContain('--he-title-size: 64px;');
  });

  it('is deterministic for the same input', () => {
    const a = toCssVariables(parseDesignTheme(SAMPLE));
    const b = toCssVariables(parseDesignTheme(SAMPLE));
    expect(a).toBe(b);
  });

  it('never emits a fixed oversize width/height', () => {
    // Only declaration-boundary width/height count (not custom props like
    // --he-border-width); toCssVariables emits no such declarations at all.
    expect(/(?:^|[\s;{])width\s*:\s*\d+px/.test(css)).toBe(false);
    expect(/(?:^|[\s;{])height\s*:\s*\d+px/.test(css)).toBe(false);
  });
});

describe('themeComponentClasses', () => {
  const theme = parseDesignTheme(SAMPLE);
  const classes = themeComponentClasses(theme);

  it('emits each signature component class wired to vars', () => {
    for (const cls of [
      '.he-kicker',
      '.he-divider',
      '.he-section-header',
      '.he-card',
      '.he-callout',
      '.he-footer-counter',
    ]) {
      expect(classes).toContain(cls);
    }
    expect(classes).toContain('var(--he-accent)');
    expect(classes).toContain('var(--he-border)');
  });

  it('uses only containment-safe sizing (max-width:100%, no fixed px dims)', () => {
    expect(classes).toContain('max-width: 100%');
    expect(/(?:^|[\s;{])(?:width|height)\s*:\s*\d+px/.test(classes)).toBe(false);
  });
  it('consumes tone tokens for shadows, tint, and heading hierarchy', () => {
    const highContrast = parseDesignTheme('bold, brutalist.\nbackground: #ffffff\nsurface: #ffffff\naccent: #111111');
    const soft = parseDesignTheme('minimal, warm.\nbackground: #ffffff\nsurface: #ffffff\naccent: #111111');
    const highCss = `${toCssVariables(highContrast)}\n${themeComponentClasses(highContrast)}`;
    const softCss = `${toCssVariables(soft)}\n${themeComponentClasses(soft)}`;

    expect(highCss).toContain('--he-shadow:');
    expect(highCss).toContain('--he-accent-tint:');
    expect(highCss).toContain('box-shadow: var(--he-shadow);');
    expect(highCss).toContain('color: var(--he-heading-color);');
    expect(highCss).not.toBe(softCss);
  });

});

describe('evaluateDesignChecklist', () => {
  it('passes for a compliant design.md', () => {
    const theme = parseDesignTheme(SAMPLE);
    const res = evaluateDesignChecklist({ designMd: SAMPLE, theme, css: compliantCss(theme) });
    expect(res.items).toHaveLength(9);

    expect(res.passed).toBe(true);
    for (const i of res.items) expect(i.ok).toBe(true);
  });

  it('FAILS when a mentioned signature element has no component class', () => {
    const theme = parseDesignTheme(SAMPLE);
    // Variables only — the component classes (incl. .he-kicker) are missing.
    const res = evaluateDesignChecklist({ designMd: SAMPLE, theme, css: toCssVariables(theme) });
    expect(res.passed).toBe(false);
    expect(item(res.items, 'signature-elements').ok).toBe(false);
    expect(item(res.items, 'signature-elements').detail).toContain('.he-kicker');
  });

  it('FAILS when a remote font/asset is referenced', () => {
    const theme = parseDesignTheme(SAMPLE);
    const css = `${compliantCss(theme)}\n@import url('https://fonts.example.com/f.css');`;
    const res = evaluateDesignChecklist({ designMd: SAMPLE, theme, css });
    expect(res.passed).toBe(false);
    expect(item(res.items, 'no-external-assets').ok).toBe(false);
  });

  it('FAILS when body/accent contrast is too low', () => {
    const LOW = [
      'colors:',
      '  background: #ffffff',
      '  body: #cccccc',
      '  ink: #dddddd',
      '  primary: #eeeeee',
      '  on-primary: #ffffff',
      '',
    ].join('\n');
    const theme = parseDesignTheme(LOW);
    const res = evaluateDesignChecklist({ designMd: LOW, theme, css: compliantCss(theme) });
    expect(res.passed).toBe(false);
    expect(item(res.items, 'palette-contrast').ok).toBe(false);
  });
  it('falls back to ink when accent text lacks canvas or surface contrast', () => {
    const LOW_HEADING = [
      'colors:',
      '  background: #ffffff',
      '  surface: #fefefe',
      '  ink: #18181b',
      '  body: #3f3f46',
      '  primary: #eeeeee',
      '  on-primary: #111111',
      '',
    ].join('\n');
    const theme = parseDesignTheme(LOW_HEADING);
    const css = compliantCss(theme);
    const res = evaluateDesignChecklist({ designMd: LOW_HEADING, theme, css });

    expect(css).toContain('--he-heading-color: #18181b;');
    expect(item(res.items, 'heading-accent-contrast').ok).toBe(true);
    expect(item(res.items, 'heading-accent-contrast').detail).toContain('ink fallback');
  });

  it('FAILS when a theme rule introduces a fixed oversize dimension', () => {
    const theme = parseDesignTheme(SAMPLE);
    const css = `${compliantCss(theme)}\n.he-rogue { width: 4000px; }`;
    const res = evaluateDesignChecklist({ designMd: SAMPLE, theme, css });
    expect(res.passed).toBe(false);
    expect(item(res.items, 'no-overflow').ok).toBe(false);
  });

  it('FAILS when the recorded source hash does not match the design.md', () => {
    const theme = parseDesignTheme(SAMPLE);
    const tampered: DesignTheme = { ...theme, source: { hash: 'deadbeef', length: 1 } };
    const res = evaluateDesignChecklist({ designMd: SAMPLE, theme: tampered, css: compliantCss(tampered) });
    expect(res.passed).toBe(false);
    expect(item(res.items, 'source-recorded').ok).toBe(false);
  });
});
