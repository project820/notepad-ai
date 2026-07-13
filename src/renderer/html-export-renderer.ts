/**
 * html-export-renderer.ts — deterministic ContentModel → safe HTML (G004).
 *
 * Pure + offline-safe. Turns a *validated* ContentModel into the static markup
 * the bundle embeds: every model string is XML-escaped (the model never authors
 * markup), charts go through the inline-SVG generator, and the emitted elements
 * carry the deterministic theme component classes (`.he-kicker`,
 * `.he-section-header`, `.he-callout`, `.he-card`, `.he-divider`, …).
 *
 * Two layout builders:
 *  - SCROLL: a single vertical document (header + sections flowing top→bottom).
 *    Horizontal overflow is clamped by the bundle CSS; this module emits only
 *    structure.
 *  - SLIDES: a cover slide + one `<section class="slide">` per content section,
 *    plus the nav footer and the `data-he-*` hooks the G005
 *    measure→paginate→scale engine drives. The real fit/pagination is G005 —
 *    here we only emit the static slide structure and data hooks.
 *
 * NO DOM measurement happens here (G005). Model text is rendered with strict
 * escaping — never piped through an HTML-trusting markdown renderer — so no
 * model-authored tag, remote image, or script can survive into the document.
 */

import type { ContentBlock, ContentModel, ContentSection } from './html-export-model';
import type { LayoutKind, Orientation } from './html-export-state';
import { renderChartSvg } from './html-export-charts';
import { slideDimsFor, type PlannedSlide, type SlideDims } from './html-export-layout';


export type RenderContext = {
  layout: LayoutKind;
  orientation: Orientation;
  /**
   * The engine's measure→paginate→scale plan (G005). When present for the
   * `slides` layout the renderer emits the PLANNED deck (cover + one `.slide`
   * per planned slide, each wrapped in a uniform-scale box) instead of a naive
   * one-slide-per-section deck — so the shipped document applies the exact same
   * containment the layout engine guarantees. Omitted → legacy section deck.
   */
  plan?: readonly PlannedSlide[];
  /** Resolved geometry used by the planner for this export. */
  dims?: SlideDims;

};

export type RenderResult = {
  /** Content-derived head markup (the `<title>`). The bundle owns meta/style/script. */
  headHtml: string;
  /** The rendered `<main>` document body. */
  bodyHtml: string;
  /** Number of charts rendered — fed to the manifest. */
  chartCount: number;
  /** Number of `.slide` containers emitted (0 for scroll) — fed to the manifest. */
  slideCount: number;
};

/** XML-escape model text for safe inclusion in element content + attributes. */
function esc(input: unknown): string {
  const s = typeof input === 'string' ? input : String(input ?? '');
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

type Counters = { charts: number };

/** Render a single ContentBlock to safe HTML. All text is escaped. */
function renderBlock(block: ContentBlock, idPrefix: string, counters: Counters): string {
  switch (block.kind) {
    case 'kicker':
      return `<p class="he-kicker">${esc(block.text)}</p>`;
    case 'heading': {
      const lvl = Math.min(4, Math.max(1, Number(block.level) || 1));
      return `<h${lvl} class="he-heading he-h${lvl}">${esc(block.text)}</h${lvl}>`;
    }
    case 'paragraph':
      return `<p class="he-paragraph">${esc(block.text)}</p>`;
    case 'list': {
      const tag = block.ordered ? 'ol' : 'ul';
      const items = (Array.isArray(block.items) ? block.items : [])
        .map((it) => `<li>${esc(it)}</li>`)
        .join('');
      return `<${tag} class="he-list">${items}</${tag}>`;
    }
    case 'table': {
      const headers = Array.isArray(block.headers) ? block.headers : [];
      const rows = Array.isArray(block.rows) ? block.rows : [];
      const thead = headers.length
        ? `<thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>`
        : '';
      const tbody = `<tbody>${rows
        .map((r) => `<tr>${(Array.isArray(r) ? r : []).map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
        .join('')}</tbody>`;
      return `<div class="he-card he-table-wrap"><table class="he-table">${thead}${tbody}</table></div>`;
    }
    case 'code': {
      const lang = block.language ? ` data-lang="${esc(block.language)}"` : '';
      return `<pre class="he-card he-code"${lang}><code>${esc(block.code)}</code></pre>`;
    }
    case 'quote':
      return `<blockquote class="he-quote">${esc(block.text)}</blockquote>`;
    case 'callout': {
      const tone = block.tone ? ` data-tone="${esc(block.tone)}"` : '';
      return `<aside class="he-callout"${tone}>${esc(block.text)}</aside>`;
    }
    case 'chart': {
      const svg = renderChartSvg(block.chart, { idPrefix: `${idPrefix}-chart-${counters.charts}` });
      counters.charts += 1;
      const note =
        block.chart && typeof block.chart.note === 'string' && block.chart.note
          ? `<figcaption class="he-chart-note">${esc(block.chart.note)}</figcaption>`
          : '';
      return `<figure class="he-chart" role="group">${svg}${note}</figure>`;
    }
    default:
      return '';
  }
}

/**
 * Render a FLAT list of blocks to safe HTML — no section/slide/document chrome.
 * Shared with the G006 real-DOM measurement adapter so the markup it measures is
 * byte-for-byte the markup the document renders (same escaping, same component
 * classes, same chart SVG path). Pure: no DOM, no measurement.
 */
export function renderBlocks(blocks: ContentBlock[], idPrefix = 'he-measure'): string {
  const counters: Counters = { charts: 0 };
  return (Array.isArray(blocks) ? blocks : [])
    .map((b, i) => renderBlock(b, `${idPrefix}-b${i}`, counters))
    .join('\n');
}

/** Render a section's inner markup (kicker + title + blocks). Shared by both layouts. */
function renderSectionInner(section: ContentSection, sectionIdx: number, counters: Counters): string {
  const parts: string[] = [];
  if (section.kicker) parts.push(`<p class="he-kicker">${esc(section.kicker)}</p>`);
  if (section.title) parts.push(`<h2 class="he-section-header">${esc(section.title)}</h2>`);
  const blocks = Array.isArray(section.blocks) ? section.blocks : [];
  for (let b = 0; b < blocks.length; b++) {
    parts.push(renderBlock(blocks[b], `he-s${sectionIdx}-b${b}`, counters));
  }
  return parts.join('\n');
}

/** SCROLL: one vertical document — header then sections, top→bottom. */
function buildScroll(model: ContentModel, ctx: RenderContext, counters: Counters): {
  bodyHtml: string;
  slideCount: number;
} {
  const sections = Array.isArray(model.sections) ? model.sections : [];
  const parts: string[] = [];
  parts.push(`<header class="he-doc-header"><h1 class="he-doc-title">${esc(model.title)}</h1></header>`);
  sections.forEach((section, i) => {
    if (i > 0) parts.push('<hr class="he-divider" />');
    parts.push(
      `<section class="he-section" data-he-section-index="${i}">\n${renderSectionInner(section, i, counters)}\n</section>`,
    );
  });
  const bodyHtml =
    `<main class="he-doc he-scroll" data-he-reflow-root data-he-layout="scroll" data-he-orientation="${esc(
      ctx.orientation,
    )}">\n` +
    parts.join('\n') +
    `\n</main>`;
  return { bodyHtml, slideCount: 0 };
}

/** SLIDES: a cover slide + one `.slide` per section, plus the nav footer hooks. */
function buildSlides(model: ContentModel, ctx: RenderContext, counters: Counters): {
  bodyHtml: string;
  slideCount: number;
} {
  const sections = Array.isArray(model.sections) ? model.sections : [];
  const slides: string[] = [];
  // Cover slide (index 0) — the only `.slide.active` at build time.
  slides.push(
    `<section class="slide active he-cover" data-he-slide-index="0" aria-roledescription="slide">` +
      `<div class="he-slide-inner"><h1 class="he-doc-title">${esc(model.title)}</h1></div>` +
      `</section>`,
  );
  sections.forEach((section, i) => {
    const idx = i + 1;
    slides.push(
      `<section class="slide" data-he-slide-index="${idx}" aria-roledescription="slide">` +
        `<div class="he-slide-inner">\n${renderSectionInner(section, i, counters)}\n</div>` +
        `</section>`,
    );
  });
  const slideCount = slides.length;
  const nav =
    `<footer class="he-slide-nav" data-he-nav>` +
    `<button type="button" class="he-nav-btn" data-he-prev aria-label="Previous slide">&lsaquo;</button>` +
    `<span class="he-footer-counter"><span data-he-current>1</span> / <span data-he-total>${slideCount}</span></span>` +
    `<button type="button" class="he-nav-btn" data-he-next aria-label="Next slide">&rsaquo;</button>` +
    `</footer>`;
  const bodyHtml =
    `<main class="he-doc he-slides" data-he-reflow-root data-he-layout="slides" data-he-orientation="${esc(
      ctx.orientation,
    )}">\n` +
    slides.join('\n') +
    `\n${nav}\n</main>`;
  return { bodyHtml, slideCount };
}

/** Wrap a planned slide's inner markup in the engine's uniform-scale box.
 *  The runtime (html-export-bundle RUNTIME_JS) sizes `.he-scale-host` to the
 *  SCALED footprint so the shipped flex centering positions the scaled content
 *  exactly and `overflow:hidden` can never clip it (footprint <= safe area). */
function scalerHtml(inner: string, scale: number, safeW: number): string {
  const s = typeof scale === 'number' && scale > 0 && scale <= 1 ? scale : 1;
  const transform = s < 1 ? `;transform:scale(${s})` : '';
  return (
    `<div class="he-slide-inner"><div class="he-scale-host">` +
    `<div class="he-scaler" data-he-scale="${s}" style="width:${safeW}px${transform}">${inner}</div>` +
    `</div></div>`
  );
}

/** SLIDES (engine-planned): a cover slide + one `.slide` per PLANNED slide, each
 *  at the engine's uniform scale, plus the nav footer hooks. Mirrors exactly the
 *  markup the G006 containment gate validates (renderBlocks of header+blocks in a
 *  `width:safeW` scaler at `scale`), so the shipped artifact IS what was proven. */
function buildPlannedSlides(
  model: ContentModel,
  plan: readonly PlannedSlide[],
  ctx: RenderContext,
  counters: Counters,
): { bodyHtml: string; slideCount: number } {
  const safeW = (ctx.dims ?? slideDimsFor(ctx.orientation)).safeW;
  const slides: string[] = [];
  if (!plan.some((slide) => slide.cover)) {
    slides.push(
      `<section class="slide active he-cover" data-he-slide-index="0" aria-roledescription="slide">` +
        scalerHtml(`<h1 class="he-heading he-h1">${esc(model.title)}</h1>`, 1, safeW) +
        `</section>`,
    );
  }

  const planHasCover = plan.some((slide) => slide.cover);
  const indexOffset = planHasCover ? 0 : 1;

  plan.forEach((s, i) => {
    const idx = i + indexOffset;

    const parts: string[] = [];
    if (s.cover) {
      parts.push(renderBlock(s.blocks[0] ?? { kind: 'heading', level: 1, text: model.title }, `he-p${idx}-cover`, counters));
    } else {
      if (s.kicker) parts.push(`<p class="he-kicker">${esc(s.kicker)}</p>`);
      if (s.sectionTitle) parts.push(`<h2 class="he-heading he-h2">${esc(s.sectionTitle)}</h2>`);
      const blocks = Array.isArray(s.blocks) ? s.blocks : [];
      for (let b = 0; b < blocks.length; b++) parts.push(renderBlock(blocks[b], `he-p${idx}-b${b}`, counters));
    }
    slides.push(
      `<section class="slide${i === 0 && planHasCover ? ' active' : ''}" data-he-slide-index="${idx}"${s.continued ? ' data-he-continued' : ''} aria-roledescription="slide">` +
        scalerHtml(parts.join('\n'), s.scale, safeW) +
        `</section>`,
    );
  });
  const slideCount = slides.length;
  const nav =
    `<footer class="he-slide-nav" data-he-nav>` +
    `<button type="button" class="he-nav-btn" data-he-prev aria-label="Previous slide">&lsaquo;</button>` +
    `<span class="he-footer-counter"><span data-he-current>1</span> / <span data-he-total>${slideCount}</span></span>` +
    `<button type="button" class="he-nav-btn" data-he-next aria-label="Next slide">&rsaquo;</button>` +
    `</footer>`;
  const bodyHtml =
    `<main class="he-doc he-slides" data-he-reflow-root data-he-layout="slides" data-he-orientation="${esc(
      ctx.orientation,
    )}">\n` +
    slides.join('\n') +
    `\n${nav}\n</main>`;
  return { bodyHtml, slideCount };
}

/**
 * Render a validated ContentModel to safe, deterministic HTML for the chosen
 * layout. Pure: identical inputs → identical output. No DOM, no measurement.
 */
export function renderContent(model: ContentModel, ctx: RenderContext): RenderResult {
  const counters: Counters = { charts: 0 };
  const safeModel: ContentModel = {
    title: typeof model?.title === 'string' ? model.title : '',
    sections: Array.isArray(model?.sections) ? model.sections : [],
  };
  const built =
    ctx.layout === 'slides'
      ? ctx.plan
        ? buildPlannedSlides(safeModel, ctx.plan, ctx, counters)
        : buildSlides(safeModel, ctx, counters)
      : buildScroll(safeModel, ctx, counters);
  return {
    headHtml: `<title>${esc(safeModel.title)}</title>`,
    bodyHtml: built.bodyHtml,
    chartCount: counters.charts,
    slideCount: built.slideCount,
  };
}
