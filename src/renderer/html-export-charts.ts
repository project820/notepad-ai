/**
 * html-export-charts.ts — deterministic inline-SVG chart generator (G003).
 *
 * Pure module: no DOM, no electron, no node. Renders a ChartSpec to an inline
 * `<svg role="img">` string for embedding directly in the exported HTML.
 *
 * HARD guarantees (offline-safe + injection-safe):
 *   - Output is pure inline SVG markup. NO `<canvas>`, NO raster `<image>` /
 *     `data:` URIs, NO `<script>`, NO remote `url(http…)`, NO external fetch.
 *   - The SVG root carries NO `xmlns` (valid for inline-in-HTML SVG) so the
 *     output never contains the substring `http`.
 *   - All text (titles, notes, labels, series names, units) is XML-escaped.
 *   - Colours use CSS variables with deterministic hex fallbacks; supplied
 *     palette colours are validated and unsafe tokens are dropped.
 *   - Element ids are deterministic (`idPrefix` + index) — no Math.random / Date.
 *   - Invalid specs return a small inline error placeholder SVG; never throws.
 */

import { CHART_TYPES, type ChartSpec, type ChartType } from './html-export-model';

export type RenderChartOpts = {
  idPrefix?: string;
  palette?: string[];
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Default deterministic palette — CSS variables with offline hex fallbacks.
// Contains no `http`, no `url(`, no `data:`.
const DEFAULT_PALETTE = [
  'var(--he-accent, #2563eb)',
  'var(--he-chart-2, #16a34a)',
  'var(--he-chart-3, #f59e0b)',
  'var(--he-chart-4, #db2777)',
  'var(--he-chart-5, #7c3aed)',
  'var(--he-chart-6, #0891b2)',
  'var(--he-chart-7, #ca8a04)',
  'var(--he-chart-8, #dc2626)',
];

const SURFACE = 'var(--he-surface, #f5f6f8)';
const BORDER = 'var(--he-border, #e4e4e7)';
const MUTED = 'var(--he-muted, #71717a)';
const INK = 'var(--he-ink, #18181b)';
const FONT = 'system-ui, -apple-system, Segoe UI, sans-serif';

// Wide canvas for bar / line / timeline; square (+ legend) for pie / donut.
const W = 640;
const H = 360;
const M = { top: 28, right: 20, bottom: 44, left: 48 };

// Size caps so a malformed/hostile spec can't generate a multi-MB SVG (G006).
const MAX_LABELS = 200;
const MAX_SERIES = 24;

// Only these colour shapes are accepted from caller-supplied palettes.
const SAFE_COLOR_RE =
  /^(?:#[0-9a-fA-F]{3,8}|rgba?\([\d.,\s%/]+\)|hsla?\([\d.,\s%/deg]+\)|var\(\s*--[a-z0-9-]+\s*(?:,\s*#[0-9a-fA-F]{3,8}\s*)?\))$/i;

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** XML-escape text for safe inclusion in element content and attributes. */
function escapeXml(input: unknown): string {
  const s = typeof input === 'string' ? input : String(input ?? '');
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Round to 2dp, normalising -0 → 0, for stable coordinate strings. */
function n2(x: number): string {
  if (!Number.isFinite(x)) return '0';
  const r = Math.round(x * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
}

/** Sanitise an id prefix to a valid, deterministic SVG id stem. */
function sanitizeId(prefix: string | undefined): string {
  let s = (typeof prefix === 'string' ? prefix : '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!s) s = 'hechart';
  if (/^[0-9-]/.test(s)) s = `c${s}`;
  return s;
}

/** Validate + normalise a palette, dropping unsafe tokens. Falls back to default. */
function resolvePalette(palette: string[] | undefined): string[] {
  if (!Array.isArray(palette)) return DEFAULT_PALETTE;
  const safe = palette.filter(
    (c) =>
      typeof c === 'string' &&
      SAFE_COLOR_RE.test(c.trim()) &&
      !/https?:|url\(|data:|<|>/i.test(c),
  );
  return safe.length ? safe : DEFAULT_PALETTE;
}

function colorAt(palette: string[], i: number): string {
  return palette[i % palette.length];
}

function polar(cx: number, cy: number, r: number, angleDeg: number): [number, number] {
  const a = ((angleDeg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

// ---------------------------------------------------------------------------
// Validation (local guard — validateChart is not exported from the model)
// ---------------------------------------------------------------------------

function validateSpec(spec: unknown): { ok: true; spec: ChartSpec } | { ok: false; reason: string } {
  if (typeof spec !== 'object' || spec === null) return { ok: false, reason: 'chart must be an object' };
  const c = spec as Record<string, unknown>;
  if (!CHART_TYPES.includes(c.type as ChartType)) return { ok: false, reason: 'unknown chart type' };
  if (!Array.isArray(c.labels) || !c.labels.every((l) => typeof l === 'string')) {
    return { ok: false, reason: 'labels must be strings' };
  }
  if (c.labels.length === 0) return { ok: false, reason: 'labels required' };
  if (c.labels.length > MAX_LABELS) return { ok: false, reason: 'too many labels' };
  if (!Array.isArray(c.series) || c.series.length === 0) return { ok: false, reason: 'series required' };
  if (c.series.length > MAX_SERIES) return { ok: false, reason: 'too many series' };
  for (const s of c.series) {
    if (typeof s !== 'object' || s === null) return { ok: false, reason: 'series entry invalid' };
    const sr = s as Record<string, unknown>;
    if (sr.name !== undefined && typeof sr.name !== 'string') return { ok: false, reason: 'series name invalid' };
    if (!Array.isArray(sr.values) || !sr.values.every((v) => typeof v === 'number' && Number.isFinite(v))) {
      return { ok: false, reason: 'series values must be finite numbers' };
    }
    // Every series must supply exactly one value per label — a mismatch means
    // missing/extra data that would misalign axes or leak NaN coordinates (G006).
    if (sr.values.length !== c.labels.length) {
      return { ok: false, reason: 'series/labels length mismatch' };
    }
  }
  if (c.title !== undefined && typeof c.title !== 'string') return { ok: false, reason: 'title invalid' };
  if (c.note !== undefined && typeof c.note !== 'string') return { ok: false, reason: 'note invalid' };
  if (c.unit !== undefined && typeof c.unit !== 'string') return { ok: false, reason: 'unit invalid' };
  return { ok: true, spec: c as unknown as ChartSpec };
}

// ---------------------------------------------------------------------------
// SVG envelope
// ---------------------------------------------------------------------------

function openSvg(id: string, type: string, vbW: number, vbH: number): string {
  return (
    `<svg role="img" viewBox="0 0 ${n2(vbW)} ${n2(vbH)}" preserveAspectRatio="xMidYMid meet" ` +
    `style="max-width:100%;height:auto" class="he-chart he-chart--${type}" ` +
    `aria-labelledby="${id}-title ${id}-desc">`
  );
}

function titleDesc(id: string, title: string, desc: string): string {
  return `<title id="${id}-title">${escapeXml(title)}</title><desc id="${id}-desc">${escapeXml(desc)}</desc>`;
}

function defaultTitle(spec: ChartSpec): string {
  if (spec.title) return spec.title;
  return `${spec.type.charAt(0).toUpperCase()}${spec.type.slice(1)} chart`;
}

function defaultDesc(spec: ChartSpec): string {
  if (spec.note) return spec.note;
  const unit = spec.unit ? ` (${spec.unit})` : '';
  return `${spec.type} chart with ${spec.labels.length} categories and ${spec.series.length} series${unit}`;
}

// ---------------------------------------------------------------------------
// Error placeholder
// ---------------------------------------------------------------------------

function errorSvg(idPrefix: string | undefined, message: string): string {
  const id = sanitizeId(idPrefix);
  return (
    openSvg(id, 'error', 640, 120) +
    titleDesc(id, 'Invalid chart', message) +
    `<rect x="1" y="1" width="638" height="118" rx="6" fill="${SURFACE}" stroke="${BORDER}"></rect>` +
    `<text x="320" y="64" text-anchor="middle" font-family="${FONT}" font-size="14" fill="${MUTED}">` +
    `${escapeXml(message)}</text>` +
    `</svg>`
  );
}

// ---------------------------------------------------------------------------
// Cartesian helpers (bar / line / timeline)
// ---------------------------------------------------------------------------

function plotBox() {
  return { left: M.left, top: M.top, w: W - M.left - M.right, h: H - M.top - M.bottom };
}

function yScaler(values: number[]) {
  const finite = values.filter((v) => Number.isFinite(v));
  let domainMax = Math.max(0, ...finite);
  let domainMin = Math.min(0, ...finite);
  if (domainMax === domainMin) domainMax = domainMin + 1;
  const box = plotBox();
  const y = (v: number): number => box.top + ((domainMax - v) / (domainMax - domainMin)) * box.h;
  return { y, baseline: y(0) };
}

function xAxisLabels(labels: string[]): string {
  const box = plotBox();
  const groupW = box.w / Math.max(labels.length, 1);
  return labels
    .map((label, i) => {
      const cx = box.left + groupW * i + groupW / 2;
      return (
        `<text x="${n2(cx)}" y="${n2(H - 16)}" text-anchor="middle" font-family="${FONT}" ` +
        `font-size="11" fill="${MUTED}">${escapeXml(label)}</text>`
      );
    })
    .join('');
}

function baselineRule(baseline: number): string {
  const box = plotBox();
  return (
    `<line x1="${n2(box.left)}" y1="${n2(baseline)}" x2="${n2(box.left + box.w)}" y2="${n2(baseline)}" ` +
    `stroke="${BORDER}" stroke-width="1"></line>`
  );
}

// ---------------------------------------------------------------------------
// Renderers per type
// ---------------------------------------------------------------------------

function renderBar(spec: ChartSpec, palette: string[]): string {
  const labels = spec.labels.length ? spec.labels : spec.series[0].values.map((_, i) => `#${i + 1}`);
  const all = spec.series.flatMap((s) => s.values);
  const { y, baseline } = yScaler(all);
  const box = plotBox();
  const groupW = box.w / Math.max(labels.length, 1);
  const innerW = groupW * 0.8;
  const barW = innerW / Math.max(spec.series.length, 1);

  const bars: string[] = [];
  labels.forEach((_, gi) => {
    spec.series.forEach((s, si) => {
      const v = Number.isFinite(s.values[gi]) ? s.values[gi] : 0;
      const yv = y(v);
      const top = Math.min(yv, baseline);
      const height = Math.abs(yv - baseline);
      const x = box.left + groupW * gi + (groupW - innerW) / 2 + barW * si;
      bars.push(
        `<rect x="${n2(x)}" y="${n2(top)}" width="${n2(Math.max(barW - 1, 0.5))}" height="${n2(height)}" ` +
          `fill="${colorAt(palette, si)}"><title>${escapeXml(`${s.name ? `${s.name}: ` : ''}${v}${spec.unit ? ` ${spec.unit}` : ''}`)}</title></rect>`,
      );
    });
  });

  return baselineRule(baseline) + bars.join('') + xAxisLabels(labels) + legend(spec, palette);
}

function renderLine(spec: ChartSpec, palette: string[]): string {
  const labels = spec.labels.length ? spec.labels : spec.series[0].values.map((_, i) => `#${i + 1}`);
  const all = spec.series.flatMap((s) => s.values);
  const { y, baseline } = yScaler(all);
  const box = plotBox();
  const xAt = (i: number): number =>
    labels.length > 1 ? box.left + (box.w / (labels.length - 1)) * i : box.left + box.w / 2;

  const paths: string[] = [];
  spec.series.forEach((s, si) => {
    const color = colorAt(palette, si);
    const pts = labels.map((_, i) => `${n2(xAt(i))},${n2(y(Number.isFinite(s.values[i]) ? s.values[i] : 0))}`);
    paths.push(
      `<polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="2" ` +
        `stroke-linejoin="round" stroke-linecap="round"></polyline>`,
    );
    labels.forEach((_, i) => {
      const v = Number.isFinite(s.values[i]) ? s.values[i] : 0;
      paths.push(
        `<circle cx="${n2(xAt(i))}" cy="${n2(y(v))}" r="2.5" fill="${color}">` +
          `<title>${escapeXml(`${s.name ? `${s.name}: ` : ''}${v}${spec.unit ? ` ${spec.unit}` : ''}`)}</title></circle>`,
      );
    });
  });

  return baselineRule(baseline) + paths.join('') + xAxisLabels(labels) + legend(spec, palette);
}

function legend(spec: ChartSpec, palette: string[]): string {
  const named = spec.series.filter((s) => s.name).length > 0;
  if (spec.series.length <= 1 && !named) return '';
  const items: string[] = [];
  let x = M.left;
  spec.series.forEach((s, si) => {
    const name = s.name || `Series ${si + 1}`;
    items.push(
      `<rect x="${n2(x)}" y="6" width="10" height="10" rx="2" fill="${colorAt(palette, si)}"></rect>` +
        `<text x="${n2(x + 14)}" y="15" font-family="${FONT}" font-size="11" fill="${INK}">${escapeXml(name)}</text>`,
    );
    x += 14 + Math.max(name.length * 6.2, 28) + 16;
  });
  return `<g class="he-chart__legend">${items.join('')}</g>`;
}

function pieSlices(spec: ChartSpec, palette: string[], donut: boolean): string {
  const cx = 180;
  const cy = 170;
  const rOuter = 130;
  const rInner = donut ? 72 : 0;
  const values = spec.series[0]?.values ?? [];
  const labels = spec.labels.length ? spec.labels : values.map((_, i) => `#${i + 1}`);

  const slices = values.map((v, i) => ({
    label: labels[i] ?? `#${i + 1}`,
    value: v,
    pos: Math.max(0, v),
    color: colorAt(palette, i),
  }));
  const total = slices.reduce((acc, s) => acc + s.pos, 0);
  const active = slices.filter((s) => s.pos > 0);

  const shapes: string[] = [];
  if (active.length <= 1) {
    // Single (or empty) slice → full disc / ring (an exact-360° arc won't render).
    const color = active[0]?.color ?? colorAt(palette, 0);
    if (donut) {
      shapes.push(
        `<circle cx="${cx}" cy="${cy}" r="${n2((rOuter + rInner) / 2)}" fill="none" ` +
          `stroke="${color}" stroke-width="${n2(rOuter - rInner)}"></circle>`,
      );
    } else {
      shapes.push(`<circle cx="${cx}" cy="${cy}" r="${rOuter}" fill="${color}"></circle>`);
    }
  } else {
    let angle = 0;
    for (const s of slices) {
      if (s.pos <= 0) continue;
      const sweep = (s.pos / total) * 360;
      const a0 = angle;
      const a1 = angle + sweep;
      angle = a1;
      const large = sweep > 180 ? 1 : 0;
      const [ox0, oy0] = polar(cx, cy, rOuter, a0);
      const [ox1, oy1] = polar(cx, cy, rOuter, a1);
      let d: string;
      if (donut) {
        const [ix1, iy1] = polar(cx, cy, rInner, a1);
        const [ix0, iy0] = polar(cx, cy, rInner, a0);
        d =
          `M ${n2(ox0)} ${n2(oy0)} A ${rOuter} ${rOuter} 0 ${large} 1 ${n2(ox1)} ${n2(oy1)} ` +
          `L ${n2(ix1)} ${n2(iy1)} A ${rInner} ${rInner} 0 ${large} 0 ${n2(ix0)} ${n2(iy0)} Z`;
      } else {
        d = `M ${cx} ${cy} L ${n2(ox0)} ${n2(oy0)} A ${rOuter} ${rOuter} 0 ${large} 1 ${n2(ox1)} ${n2(oy1)} Z`;
      }
      shapes.push(
        `<path d="${d}" fill="${s.color}"><title>${escapeXml(`${s.label}: ${s.value}${spec.unit ? ` ${spec.unit}` : ''}`)}</title></path>`,
      );
    }
  }

  // Legend rows below the disc (viewBox grows to contain them — no overflow).
  const rows = slices.map((s, i) => {
    const ly = 316 + i * 22;
    return (
      `<rect x="24" y="${n2(ly)}" width="12" height="12" rx="2" fill="${s.color}"></rect>` +
      `<text x="44" y="${n2(ly + 10)}" font-family="${FONT}" font-size="12" fill="${INK}">` +
      `${escapeXml(`${s.label} — ${s.value}${spec.unit ? ` ${spec.unit}` : ''}`)}</text>`
    );
  });

  return shapes.join('') + rows.join('');
}

function renderPieLike(spec: ChartSpec, palette: string[], donut: boolean, id: string): string {
  const rowCount = (spec.labels.length ? spec.labels.length : spec.series[0]?.values.length ?? 0) || 1;
  const vbH = 316 + rowCount * 22 + 12;
  return (
    openSvg(id, donut ? 'donut' : 'pie', 360, vbH) +
    titleDesc(id, defaultTitle(spec), defaultDesc(spec)) +
    pieSlices(spec, palette, donut) +
    `</svg>`
  );
}

function renderTimeline(spec: ChartSpec, palette: string[]): string {
  const labels = spec.labels.length ? spec.labels : (spec.series[0]?.values ?? []).map((_, i) => `#${i + 1}`);
  const values = spec.series[0]?.values ?? [];
  const color = colorAt(palette, 0);
  const pad = 56;
  const baseline = 184;
  const xAt = (i: number): number =>
    labels.length > 1 ? pad + ((W - pad * 2) / (labels.length - 1)) * i : W / 2;

  const out: string[] = [];
  out.push(
    `<line x1="${n2(pad)}" y1="${baseline}" x2="${n2(W - pad)}" y2="${baseline}" stroke="${BORDER}" stroke-width="2"></line>`,
  );
  labels.forEach((label, i) => {
    const x = xAt(i);
    out.push(`<circle cx="${n2(x)}" cy="${baseline}" r="6" fill="${color}"></circle>`);
    out.push(
      `<text x="${n2(x)}" y="${baseline + 28}" text-anchor="middle" font-family="${FONT}" font-size="12" fill="${INK}">${escapeXml(label)}</text>`,
    );
    if (Number.isFinite(values[i])) {
      out.push(
        `<text x="${n2(x)}" y="${baseline - 18}" text-anchor="middle" font-family="${FONT}" font-size="11" fill="${MUTED}">${escapeXml(`${values[i]}${spec.unit ? ` ${spec.unit}` : ''}`)}</text>`,
      );
    }
  });
  return out.join('');
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Render a ChartSpec to a deterministic, inline, offline-safe `<svg>` string.
 * Never throws: an invalid spec yields a small inline error placeholder.
 */
export function renderChartSvg(spec: ChartSpec, opts: RenderChartOpts = {}): string {
  const id = sanitizeId(opts.idPrefix);
  const palette = resolvePalette(opts.palette);

  const valid = validateSpec(spec);
  if (!valid.ok) return errorSvg(opts.idPrefix, valid.reason);

  const s = valid.spec;
  try {
    switch (s.type) {
      case 'bar':
        return openSvg(id, 'bar', W, H) + titleDesc(id, defaultTitle(s), defaultDesc(s)) + renderBar(s, palette) + `</svg>`;
      case 'line':
        return (
          openSvg(id, 'line', W, H) + titleDesc(id, defaultTitle(s), defaultDesc(s)) + renderLine(s, palette) + `</svg>`
        );
      case 'pie':
        return renderPieLike(s, palette, false, id);
      case 'donut':
        return renderPieLike(s, palette, true, id);
      case 'timeline':
        return (
          openSvg(id, 'timeline', W, H) +
          titleDesc(id, defaultTitle(s), defaultDesc(s)) +
          renderTimeline(s, palette) +
          `</svg>`
        );
      default:
        return errorSvg(opts.idPrefix, 'unsupported chart type');
    }
  } catch {
    // Defensive: any unexpected failure still returns inline markup, never throws.
    return errorSvg(opts.idPrefix, 'chart render error');
  }
}
