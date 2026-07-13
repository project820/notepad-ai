/**
 * he-harness.ts — the BROWSER-SIDE driver for the containment runner (G006).
 *
 * esbuild bundles this (+ the html-export pipeline + the REAL DOM measure
 * adapter) into a single IIFE that the Electron offscreen runner injects into
 * the hidden window. It exposes `window.__heHarness` with:
 *
 *   - bundleDoc(md, opts)   → { html, manifest, validate, sectionCount }  (PURE)
 *   - assertSlides(md, opts) → real-DOM slide containment verdict          (DOM)
 *   - assertScroll(md, opts) → real-DOM scroll containment verdict         (DOM)
 *
 * The runner calls bundleDoc on any page (it is pure), loads the returned HTML
 * into the window at a target viewport, re-injects this bundle, then calls
 * assertSlides / assertScroll — which measure with the REAL DOM adapter, apply
 * the engine's plan, and read back live geometry.
 *
 * This file is intentionally OUT of the tsconfig typecheck surface (it is build
 * input for esbuild only); the type-sensitive logic lives in the typechecked
 * renderer modules it imports.
 */

import {
  planSlides,
  planScrollContainment,
  slideDimsFor,
  MIN_SCALE,
} from '../src/renderer/html-export-layout';
import type { SlideDims } from '../src/renderer/html-export-layout';
import { renderBlocks } from '../src/renderer/html-export-renderer';
import { bundleHtml, buildExportStyle } from '../src/renderer/html-export-bundle';
import { validateSelfContainedHtml } from '../src/renderer/html-export-validate';
import {
  parseDesignTheme,
  toCssVariables,
  themeComponentClasses,
  evaluateDesignChecklist,
} from '../src/renderer/html-export-theme';
import { createDomMeasure, domFontsReady } from '../src/renderer/html-export-measure-dom';
import { corpusToModel } from '../src/renderer/__fixtures__/html-export/corpus-to-model';
import type { ContentBlock, ContentModel } from '../src/renderer/html-export-model';
import type { LayoutKind, Orientation } from '../src/renderer/html-export-state';

const DESIGN_MD = `# Corpus Theme
colors:
  background: #ffffff
  ink: #111827
  body: #374151
  primary: #2563eb
  on-primary: #ffffff
`;
const theme = parseDesignTheme(DESIGN_MD);
const themeCss = toCssVariables(theme);
const componentCss = themeComponentClasses(theme);
const checklist = evaluateDesignChecklist({ designMd: DESIGN_MD, theme, css: `${themeCss}\n${componentCss}` });

const TOL = 1.5; // sub-pixel tolerance for geometry comparisons

type CellOpts = { orientation: Orientation; layout?: LayoutKind; title?: string };

function buildModel(md: string, title?: string): ContentModel {
  return corpusToModel(md, title || 'Untitled');
}

/** PURE: build the self-contained document + manifest for a fixture cell. */
function bundleDoc(md: string, opts: CellOpts) {
  const model = buildModel(md, opts.title);
  const { html, manifest } = bundleHtml({
    model,
    theme,
    themeCss,
    componentCss,
    orientation: opts.orientation,
    layout: opts.layout || 'slides',
    summaryChartMode: 'B',
    designSource: 'default',
    designMd: DESIGN_MD,
    freeRequirement: 'containment runner',
    checklist,
  });
  const verdict = validateSelfContainedHtml(html);
  return { html, manifest, validate: verdict, sectionCount: model.sections.length };
}

/** The synthetic header blocks the engine prepended when it measured a slide. */
function headerThenBlocks(slide: { blocks: ContentBlock[]; sectionTitle?: string; kicker?: string }): ContentBlock[] {
  const hb: ContentBlock[] = [];
  if (slide.kicker) hb.push({ kind: 'kicker', text: slide.kicker });
  if (slide.sectionTitle) hb.push({ kind: 'heading', level: 2, text: slide.sectionTitle });
  return [...hb, ...slide.blocks];
}

function reflowRoot(): HTMLElement | null {
  return document.querySelector('[data-he-reflow-root]');
}

/**
 * DOM: measure with the real adapter, plan slides, apply the plan (split blocks
 * + uniform scale) into a fixed slide-canvas box using the ENGINE's safe-area
 * geometry, and assert containment of every planned slide one at a time.
 */
async function assertSlides(md: string, opts: CellOpts) {
  const orientation = opts.orientation;
  const dims: SlideDims = slideDimsFor(orientation);
  const model = buildModel(md, opts.title);
  const measure = createDomMeasure({ doc: document, styleCss: buildExportStyle(theme, opts.orientation, 'slides') });
  const fontsReady = domFontsReady(document);

  const plan = await planSlides({ model, orientation, dims, measure, fontsReady });
  const failures: string[] = [];
  if (!plan.ok) {
    return {
      ok: false,
      failures: [`planSlides failed: ${plan.diagnostics.reason || 'no contained plan'}`],
      slideCount: 0,
      minScale: plan.diagnostics.minScale,
      splits: plan.diagnostics.splits,
      sectionCount: model.sections.length,
    };
  }

  const root = reflowRoot();
  if (!root) {
    return { ok: false, failures: ['no [data-he-reflow-root] in document'], slideCount: plan.slides.length, minScale: plan.diagnostics.minScale, splits: plan.diagnostics.splits, sectionCount: model.sections.length };
  }
  const navButtons = Array.from(document.querySelectorAll('.he-nav-btn')) as HTMLElement[];
  const navMinWidth = navButtons.length ? Math.min(...navButtons.map((button) => button.getBoundingClientRect().width)) : 0;
  const navMinHeight = navButtons.length ? Math.min(...navButtons.map((button) => button.getBoundingClientRect().height)) : 0;
  if (navMinWidth < 44 - TOL || navMinHeight < 44 - TOL) {
    failures.push(`navigation controls below 44px (${navMinWidth.toFixed(1)}×${navMinHeight.toFixed(1)})`);
  }
  let maxTopOffset = 0;

  // Strip the bundle's per-section slides; we render the PLANNED deck instead,
  // reusing the SHIPPED slide CSS so the harness layout cannot drift from what
  // users actually get.
  Array.from(document.querySelectorAll('.slide')).forEach((s) => s.remove());

  // Mount the planned deck inside a REAL `.he-slides` container so the shipped
  // `.slide.active` flex contract (display:flex; flex-direction:column;
  // justify-content:center; align-items:stretch; padding; overflow:hidden — from
  // html-export-bundle.ts COMMON_CSS + SLIDES_CSS) applies VERBATIM. The
  // container is PINNED to the design canvas (overriding the bundle's
  // 100vw/100vh) so containment is asserted against the SLIDE CANVAS, never the
  // (possibly oversized) browser window.
  const deck = document.createElement('div');
  deck.className = 'he-slides';
  Object.assign(deck.style, {
    position: 'fixed',
    left: '0px',
    top: '0px',
    width: `${dims.width}px`,
    height: `${dims.height}px`,
    overflow: 'hidden',
    background: 'var(--he-bg)',
  });
  document.body.appendChild(deck);

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  for (let idx = 0; idx < plan.slides.length && failures.length === 0; idx++) {
    const slide = plan.slides[idx];
    // Real shipped slide: ALL of the flex/centering/padding/overflow layout comes
    // from the bundle stylesheet via the `.slide.active` class — NO display:block.
    const sec = document.createElement('section');
    sec.className = 'slide active he-assert-slide';
    const inner = document.createElement('div');
    inner.className = 'he-slide-inner';
    // `host` carries the engine's uniform scale. Its LAYOUT box is sized to the
    // SCALED footprint so the shipped flex centering positions the scaled content
    // exactly (a bare transform:scale leaves layout at scale 1, which mis-centers
    // — and would falsely overflow — any slide the engine scaled below 1).
    // `scaler` is a flow-root so block margins are contained (matching the
    // shipped flex item), making the scaled-footprint measurement accurate.
    const host = document.createElement('div');
    host.style.position = 'relative';
    const scaler = document.createElement('div');
    Object.assign(scaler.style, {
      width: `${dims.safeW}px`,
      display: 'flow-root',
      transformOrigin: '0 0',
      transform: `scale(${slide.scale})`,
    });
    scaler.innerHTML = renderBlocks(headerThenBlocks(slide));
    host.appendChild(scaler);
    inner.appendChild(host);
    sec.appendChild(inner);
    deck.appendChild(sec);
    void deck.offsetHeight; // initial layout
    host.style.width = `${scaler.offsetWidth * slide.scale}px`;
    host.style.height = `${scaler.offsetHeight * slide.scale}px`;
    void deck.offsetHeight; // settle centering against the scaled footprint

    // The SLIDE safe-area box = the slide element's CONTENT box (its own screen
    // rect minus its REAL padding). Content must stay inside THIS box — not the
    // browser viewport.
    const cs = getComputedStyle(sec);
    const sr = sec.getBoundingClientRect();
    const safeLeft = sr.left + (parseFloat(cs.paddingLeft) || 0);
    const safeTop = sr.top + (parseFloat(cs.paddingTop) || 0);
    const safeRight = sr.right - (parseFloat(cs.paddingRight) || 0);
    const safeBottom = sr.bottom - (parseFloat(cs.paddingBottom) || 0);
    const topOffset = inner.getBoundingClientRect().top - safeTop;
    maxTopOffset = Math.max(maxTopOffset, topOffset);
    if (topOffset > TOL) {
      failures.push(`slide ${idx}: content drifts ${topOffset.toFixed(1)}px below safe-area top`);
    }


    // (1) scale floor respected.
    if (slide.scale < MIN_SCALE - 1e-9) failures.push(`slide ${idx}: scale ${slide.scale.toFixed(3)} < MIN_SCALE ${MIN_SCALE.toFixed(3)}`);

    // (2) every rendered element's rect stays inside the SLIDE safe-area box.
    //     Catches content (overflow:visible) that escapes the slide canvas on any
    //     edge — horizontal escape included.
    const contentEls = [scaler, ...Array.from(scaler.querySelectorAll('*'))] as HTMLElement[];
    for (const el of contentEls) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.left < safeLeft - TOL || r.top < safeTop - TOL || r.right > safeRight + TOL || r.bottom > safeBottom + TOL) {
        failures.push(
          `slide ${idx}: <${el.tagName.toLowerCase()}> escapes safe area rect=[${r.left.toFixed(0)},${r.top.toFixed(0)},${r.right.toFixed(0)},${r.bottom.toFixed(0)}] safe=[${safeLeft.toFixed(0)},${safeTop.toFixed(0)},${safeRight.toFixed(0)},${safeBottom.toFixed(0)}]`,
        );
        break;
      }
    }

    // (3) NO internal layout overflow. A clipping wrapper (computed overflow !=
    //     visible — e.g. `.he-table-wrap`/`.he-code` with overflow-x:auto) whose
    //     scroll size exceeds its client box HIDES content inside the slide (an
    //     unbreakable wide table / long code line behind an auto-scrollbar).
    //     scrollWidth/clientWidth are layout px in the scaler's own pre-scale
    //     coordinate space, so the ratio is scale-invariant — it catches overflow
    //     the visual transform merely shrinks but can NEVER un-clip. Horizontal
    //     internal overflow is a hard containment failure.
    for (const el of contentEls) {
      const ecs = getComputedStyle(el);
      const tag = (el.getAttribute('class') || el.tagName).toString().split(' ')[0];
      if (ecs.overflowX !== 'visible' && el.scrollWidth - el.clientWidth > TOL) {
        failures.push(`slide ${idx}: <${tag}> internal horizontal overflow (scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth})`);
        break;
      }
      if (ecs.overflowY !== 'visible' && el.scrollHeight - el.clientHeight > TOL) {
        failures.push(`slide ${idx}: <${tag}> internal vertical overflow (scrollHeight ${el.scrollHeight} > clientHeight ${el.clientHeight})`);
        break;
      }
    }

    // (4) top-level blocks do not overlap (vertical column).
    const tops = Array.from(scaler.children) as HTMLElement[];
    for (let k = 1; k < tops.length; k++) {
      const a = tops[k - 1].getBoundingClientRect();
      const b = tops[k].getBoundingClientRect();
      if (b.top < a.bottom - TOL) {
        failures.push(`slide ${idx}: blocks ${k - 1}/${k} overlap (${a.bottom.toFixed(1)} > ${b.top.toFixed(1)})`);
        break;
      }
    }

    // (5) the page itself never scrolls in a deck.
    const de = document.documentElement;
    if (de.scrollWidth > vw + TOL) failures.push(`slide ${idx}: page scrolls horizontally (${de.scrollWidth} > ${vw})`);
    if (de.scrollHeight > vh + TOL) failures.push(`slide ${idx}: page scrolls vertically (${de.scrollHeight} > ${vh})`);

    sec.remove();
  }

  deck.remove();

  return {
    ok: failures.length === 0,
    failures,
    slideCount: plan.slides.length,
    minScale: plan.diagnostics.minScale,
    splits: plan.diagnostics.splits,
    sectionCount: model.sections.length,
    navMinWidth,
    navMinHeight,
    maxTopOffset,

  };
}

/**
 * DOM: assert the loaded SCROLL document needs only vertical scroll — no
 * horizontal page overflow, and every major block stays within the viewport
 * width. Vertical height may exceed the viewport (scrolling is allowed).
 */
async function assertScroll(md: string, opts: CellOpts) {
  const orientation = opts.orientation;
  const dims: SlideDims = slideDimsFor(orientation);
  const model = buildModel(md, opts.title);
  const measure = createDomMeasure({ doc: document, styleCss: buildExportStyle(theme, opts.orientation, 'scroll') });
  const fontsReady = domFontsReady(document);
  const scroll = await planScrollContainment({ model, orientation, dims, measure, fontsReady });

  const failures: string[] = [];
  const vw = window.innerWidth;
  const de = document.documentElement;
  const body = document.body;
  const pageW = Math.max(de.scrollWidth, body.scrollWidth);
  if (pageW > vw + TOL) failures.push(`page scrolls horizontally (${pageW} > ${vw})`);
  const scrollRoot = document.querySelector('.he-scroll') as HTMLElement | null;
  const readingWidthRatio = scrollRoot ? scrollRoot.getBoundingClientRect().width / vw : 0;
  if (readingWidthRatio < 0.7) {
    failures.push(`reading column underfills viewport (${readingWidthRatio.toFixed(3)} < 0.700)`);
  }


  const selector = [
    '.he-scroll .he-doc-title',
    '.he-scroll .he-section-header',
    '.he-scroll .he-heading',
    '.he-scroll .he-paragraph',
    '.he-scroll .he-list',
    '.he-scroll .he-table-wrap',
    '.he-scroll .he-code',
    '.he-scroll .he-chart',
    '.he-scroll .he-quote',
    '.he-scroll .he-callout',
  ].join(',');
  const blocks = Array.from(document.querySelectorAll(selector)) as HTMLElement[];
  for (const el of blocks) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.right > vw + TOL || r.left < -TOL) {
      failures.push(`block <${(el.className || el.tagName).toString().split(' ')[0]}> exceeds width (right=${r.right.toFixed(0)} vw=${vw})`);
      break;
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    horizontalOverflowEngine: scroll.horizontalOverflow,
    contentW: scroll.contentW,
    contentH: scroll.contentH,
    safeW: scroll.safeW,
    readingWidthRatio,
  };
}

/** DIAGNOSTIC: per-block real-DOM footprint vs the slide safe area. */
async function probe(md: string, opts: CellOpts) {
  const dims: SlideDims = slideDimsFor(opts.orientation);
  const model = buildModel(md, opts.title);
  const measure = createDomMeasure({ doc: document, styleCss: buildExportStyle(theme, opts.orientation, 'slides') });
  await domFontsReady(document)();
  const out: Array<Record<string, number | string>> = [];
  for (const s of model.sections) {
    const hb: ContentBlock[] = [];
    if (s.kicker) hb.push({ kind: 'kicker', text: s.kicker });
    if (s.title) hb.push({ kind: 'heading', level: 2, text: s.title });
    for (const b of s.blocks) {
      const m = measure([...hb, b], dims, 1);
      out.push({ section: s.title || '(intro)', kind: b.kind, contentW: m.contentW, contentH: m.contentH, safeW: dims.safeW, safeH: dims.safeH });
    }
  }
  return out;
}

(window as unknown as { __heHarness: unknown }).__heHarness = {
  bundleDoc,
  assertSlides,
  assertScroll,
  probe,
  MIN_SCALE,
};
