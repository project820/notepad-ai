/**
 * html-export-bundle.ts — single self-contained `.html` assembler (G004).
 *
 * Assembles ONE `<!doctype html>` string purely from a validated ContentModel +
 * its deterministic theme — there is NO LLM-authored-HTML path here. The head
 * carries `<meta charset>` + viewport, a single inline `<style>` (theme vars +
 * component classes + layout containment CSS), and an embedded JSON manifest.
 * The body is the rendered content plus a minimal inline runtime for slide
 * navigation and a resize-reflow HOOK that G005 extends with the real
 * measure→paginate→scale loop.
 *
 * Pure + deterministic + offline-safe: no remote/raster assets, no network.
 */

import type { ContentModel, DesignSource, SummaryChartMode } from './html-export-model';
import type { LayoutKind, Orientation } from './html-export-state';
import type { ChecklistResult, DesignTheme, HtmlExportPresentation } from './html-export-theme';
import { stableHash, themeComponentClasses, toCssVariables, resolveHtmlExportSlideGeometry } from './html-export-theme';


import { renderContent } from './html-export-renderer';
import { slideDimsFor, type PlannedSlide } from './html-export-layout';

import { sha256Base64 } from './sha256';

/** Bump when the embedded manifest shape changes. */
export const EXPORT_MANIFEST_SCHEMA_VERSION = 1;

/** The machine-readable provenance block embedded in every exported document. */
type ExportManifest = {
  schemaVersion: number;
  orientation: Orientation;
  layout: LayoutKind;
  designSource: DesignSource;
  designHash: string;
  summaryChartMode: SummaryChartMode;
  requirementHash: string;
  chartCount: number;
  slideCount: number;
  /** Best-fit scale factor — filled by the G005 measure→scale loop, null here. */
  minScale: number | null;
  checklistPassed: boolean;
  /** Optional + injectable so tests stay deterministic; omitted when not given. */
  generatedAt?: string;
};

export type BundleArgs = {
  model: ContentModel;
  theme: DesignTheme;
  orientation: Orientation;
  layout: LayoutKind;
  summaryChartMode: SummaryChartMode;
  designSource: DesignSource;
  designMd: string;
  freeRequirement: string;
  checklist: ChecklistResult;
  /** The engine's measure→paginate→scale plan (G005). REQUIRED for a contained
   *  `slides` export: the renderer emits this exact planned deck (cover + one
   *  `.slide` per planned slide at the engine's uniform scale). Omitted → the
   *  legacy section-per-slide deck (no engine scale — used only by no-plan tests). */
  plan?: readonly PlannedSlide[];
  /** Inject a fixed timestamp; omit for a deterministic (timestamp-free) document. */
  generatedAt?: string;
  /** User presentation controls, resolved from purpose defaults plus explicit wizard knobs. */
  presentation?: HtmlExportPresentation;

};

export type BundleResult = { html: string; manifest: ExportManifest };

// ---------------------------------------------------------------------------
// Base layout CSS — variable-driven containment only (never fixed px w/h).
// ---------------------------------------------------------------------------

const COMMON_CSS = [
  '*,*::before,*::after{box-sizing:border-box;}',
  'html,body{margin:0;padding:0;}',
  'body{background:var(--he-bg);color:var(--he-body);font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:max(20px,var(--he-body-size));line-height:var(--he-line-height);}',


  // Long unbreakable tokens (URLs, IDs, CJK runs, code-y strings) must wrap, never
  // force a wider-than-viewport line — otherwise a SCROLL page gains a horizontal
  // scrollbar at narrow widths (hard containment failure). overflow-wrap/word-break
  // inherit, so this covers every title/heading/paragraph/list/cell descendant.
  '.he-doc{overflow-wrap:break-word;word-break:break-word;}',
  '.he-doc-title{font-size:var(--he-title-size);font-weight:var(--he-title-weight);color:var(--he-heading-color,var(--he-ink));line-height:var(--he-line-height);margin:0 0 var(--he-rhythm);}',
  '.he-heading{color:var(--he-heading-color,var(--he-ink));line-height:var(--he-line-height);margin:var(--he-rhythm) 0 var(--he-rhythm-sm);}',
  '.he-h1{font-size:var(--he-title-size);font-weight:var(--he-title-weight);}',
  '.he-h2{font-size:var(--he-heading-size);font-weight:var(--he-heading-weight);letter-spacing:var(--he-heading-tracking);}',

  '.he-paragraph{margin:0 0 var(--he-rhythm-sm);max-width:100%;}',
  '.he-list{margin:0 0 var(--he-rhythm-sm);padding-left:1.4em;}',
  '.he-quote{margin:0 0 var(--he-rhythm-sm);padding-left:var(--he-space-3,16px);border-left:3px solid var(--he-accent);color:var(--he-muted);}',
  '.he-table-wrap{overflow-x:auto;margin:0 0 var(--he-rhythm-sm);}',
  '.he-table{border-collapse:collapse;width:100%;max-width:100%;}',
  '.he-table th,.he-table td{border:var(--he-border-width) solid var(--he-border);padding:var(--he-space-2,8px);text-align:left;}',
  '.he-code{overflow-x:auto;margin:0 0 var(--he-rhythm-sm);}',
  // Code wraps (never horizontal-scrolls): a slide cannot scroll, and the
  // measure→scale engine's column transform cannot un-clip an overflow-x:auto
  // box, so a non-wrapping line wider than the (esp. vertical) safe area would
  // be hidden behind a scrollbar. pre-wrap keeps indentation; break-word defends
  // against unbreakable tokens. Containment now holds at any scale (G006).
  '.he-code code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:break-word;}',
  '.he-chart{margin:0 0 var(--he-rhythm-sm);max-width:100%;}',
  // Charts stretch to the column width; cap their height to the fixed canvas so
  // a full-width chart can never exceed the slide safe area (G006 containment).
  '.he-chart svg{max-width:100%;height:auto;max-height:calc(var(--he-canvas-h, 720px) * 0.6);}',
  '.he-chart-note{font-size:max(16px,var(--he-caption-size));color:var(--he-muted);margin-top:var(--he-rhythm-sm);}',
  // Slide-component contract (harmless when no `.slide` exists, e.g. scroll docs).
  '.slide{display:none;}',
  '.slide.active{display:flex;flex-direction:column;}',
  '.he-slide-inner{width:100%;max-width:100%;}',
].join('');

const SCROLL_CSS = [
  // Vertical-only: clamp horizontal overflow, scroll the page vertically.
  'html,body{overflow-x:hidden;}',
  '.he-scroll{display:block;max-width:var(--he-readable-width,880px);margin:0 auto;padding:var(--he-rhythm);}',
  '.he-doc-header{margin-bottom:var(--he-rhythm);}',
].join('');

const SLIDES_CSS = [
  // Deck: lock the viewport; exactly one `.slide.active` is shown at a time.
  'html,body{height:100%;overflow:hidden;}',
  // Deck is PINNED to the fixed design canvas (--he-canvas-w/h) and centered;
  // the runtime uniformly scales the whole canvas to fit the viewport
  // (letterbox), so the engine's per-slide plan — computed for THIS canvas — is
  // honored at any window size/orientation without page scroll or clipping.
  '.he-slides{position:fixed;left:50%;top:50%;width:var(--he-canvas-w,1280px);height:var(--he-canvas-h,720px);overflow:hidden;transform:translate(-50%,-50%);transform-origin:center center;}',
  // Keep sparse slides anchored to the safe area's top edge rather than floating
  // in the center of the canvas. The planner still owns containment and scale.
  '.he-slides .slide.active{width:100%;height:100%;padding:var(--he-slide-pad);padding-bottom:calc(var(--he-slide-pad) + var(--he-nav-reserve));overflow:hidden;align-items:stretch;justify-content:flex-start;gap:var(--he-rhythm-sm);}',

  // The scale box: the runtime sizes `.he-scale-host` to the slide's SCALED
  // footprint. Top alignment keeps the scaled content's first line at the safe
  // area edge while the scaler carries the engine's uniform transform.
  '.he-scale-host{position:relative;align-self:flex-start;max-width:100%;max-height:100%;}',
  // flow-root contains child block margins so the runtime's sizeActive() reads a
  // footprint that includes them (matching the containment-gate measurement).
  '.he-scaler{transform-origin:top left;display:flow-root;}',
  '.he-slide-nav{position:fixed;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;gap:var(--he-rhythm-sm);padding:var(--he-rhythm-sm);}',
  '.he-nav-btn{min-width:48px;min-height:48px;padding:8px 14px;background:var(--he-surface);color:var(--he-ink);font-size:16px;border:var(--he-border-width) solid var(--he-border);border-radius:var(--he-radius-sm);cursor:pointer;}',

].join('');

function baseLayoutCss(layout: LayoutKind): string {
  return COMMON_CSS + (layout === 'slides' ? SLIDES_CSS : SCROLL_CSS);
}

/**
 * Orientation-derived design-canvas hints for the G005 measure→scale engine.
 * Custom properties only (never width/height) so they can never cause overflow.
 */
function orientationVars(orientation: Orientation): string {
  const horizontal = orientation !== 'vertical';
  const w = horizontal ? 1280 : 720;
  const h = horizontal ? 720 : 1280;
  return `:root{--he-orientation:${horizontal ? 'horizontal' : 'vertical'};--he-canvas-w:${w}px;--he-canvas-h:${h}px;}`;
}

/**
 * The EXACT stylesheet the bundle embeds (theme vars + component classes +
 * orientation canvas vars + base layout CSS). Exported so the measurement
 * adapter (html-export-measure-dom) can style its offscreen root IDENTICALLY to
 * the shipped document — otherwise the engine would measure UNSTYLED DOM and
 * compute a wrong pagination/scale plan.
 */
export function buildExportStyle(
  theme: DesignTheme,
  orientation: Orientation,
  layout: LayoutKind,
  presentation?: HtmlExportPresentation,
): string {

  return [
    toCssVariables(theme, presentation),

    themeComponentClasses(theme),
    orientationVars(orientation),
    baseLayoutCss(layout),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Minimal inline runtime — slide nav + resize-reflow hook (G005 extends).
// Contains no remote URL, no fetch/XHR, no `url(` — stays self-contained.
// ---------------------------------------------------------------------------

const RUNTIME_JS = [
  '(function(){',
  'var root=document.querySelector("[data-he-reflow-root]");',
  'if(!root)return;',
  'var slides=Array.prototype.slice.call(root.querySelectorAll(".slide"));',
  'var cur=0;',
  'var curEl=root.querySelector("[data-he-current]");',
  'var totEl=root.querySelector("[data-he-total]");',
  'if(totEl)totEl.textContent=String(slides.length);',
  'function show(i){if(!slides.length)return;cur=Math.max(0,Math.min(slides.length-1,i));for(var k=0;k<slides.length;k++){slides[k].classList.toggle("active",k===cur);}if(curEl)curEl.textContent=String(cur+1);sizeActive();}',
  'function next(){show(cur+1);}function prev(){show(cur-1);}',
  'var nb=root.querySelector("[data-he-next]");if(nb)nb.addEventListener("click",next);',
  'var pb=root.querySelector("[data-he-prev]");if(pb)pb.addEventListener("click",prev);',
  'if(root.getAttribute("data-he-layout")==="slides"){document.addEventListener("keydown",function(e){if(e.key==="ArrowRight"||e.key==="PageDown"||e.key===" "){next();}else if(e.key==="ArrowLeft"||e.key==="PageUp"){prev();}});show(0);}',
  // Size the ACTIVE slide's scale-host to the engine-scaled footprint (an
  // inactive slide is display:none → unmeasurable), and uniformly fit the fixed
  // canvas to the viewport. Pure transforms: no remote URL, stays self-contained.
  'function sizeActive(){var a=slides[cur];if(!a)return;var sc=a.querySelector(".he-scaler");if(!sc)return;var h=sc.parentNode;var s=parseFloat(sc.getAttribute("data-he-scale"))||1;h.style.width=(sc.offsetWidth*s)+"px";h.style.height=(sc.offsetHeight*s)+"px";}',
  'function fitDeck(){if(root.getAttribute("data-he-layout")!=="slides")return;var cw=root.offsetWidth,ch=root.offsetHeight;if(!cw||!ch)return;var f=Math.min(window.innerWidth/cw,(window.innerHeight-56)/ch);if(f>0)root.style.transform="translate(-50%,-50%) scale("+f+")";}',
  'function reflow(){sizeActive();fitDeck();}',
  'var t;window.addEventListener("resize",function(){clearTimeout(t);t=setTimeout(reflow,120);});',
  'fitDeck();',
  'window.__heReflow=reflow;',
  '})();',
].join('');

// Content-Security-Policy for the exported file (G006 defense-in-depth atop the
// structural allowlist validator). Only the inline runtime — pinned by its
// SHA-256 — may execute; default-src 'none' blocks every network fetch, and
// img/font are limited to inline data: URIs. `style-src 'unsafe-inline'` is kept
// because the document legitimately carries inline style attributes (and the
// allowlist validator already forbids remote url() in styles).
const RUNTIME_JS_SHA256 = sha256Base64(RUNTIME_JS);
const EXPORT_CSP =
  [
    "default-src 'none'",
    'img-src data:',
    "style-src 'unsafe-inline'",
    `script-src 'sha256-${RUNTIME_JS_SHA256}'`,
    'font-src data:',
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ') + ';';
const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${EXPORT_CSP}">`;

/** Embed the manifest as inline JSON, escaping `<` so it can never break out of the script. */
function embedManifest(manifest: ExportManifest): string {
  const json = JSON.stringify(manifest).replace(/</g, '\\u003c');
  return `<script type="application/json" id="he-manifest">${json}</script>`;
}

/**
 * Assemble a single self-contained offline `.html` document from a validated
 * ContentModel + deterministic theme. Returns the document string and the
 * embedded manifest object (they mirror each other).
 */
export function bundleHtml(args: BundleArgs): BundleResult {
  // Theme CSS is ALWAYS derived from the trusted, deterministic theme — callers
  // can no longer inject arbitrary themeCss/componentCss into the export (G006).
  const themeCss = toCssVariables(args.theme, args.presentation);
  const componentCss = themeComponentClasses(args.theme);
  const slideGeometry = resolveHtmlExportSlideGeometry(args.theme, args.presentation);
  const slideDims = slideDimsFor(args.orientation, slideGeometry);



  const minScale =
    args.plan && args.plan.length
      ? args.plan.reduce((m, s) => Math.min(m, typeof s.scale === 'number' ? s.scale : 1), 1)
      : null;
  const rendered = renderContent(args.model, {
    layout: args.layout,
    orientation: args.orientation,
    plan: args.layout === 'slides' ? args.plan : undefined,
    dims: args.layout === 'slides' ? slideDims : undefined,
  });

  const manifest: ExportManifest = {
    schemaVersion: EXPORT_MANIFEST_SCHEMA_VERSION,
    orientation: args.orientation,
    layout: args.layout,
    designSource: args.designSource,
    designHash: stableHash(typeof args.designMd === 'string' ? args.designMd : ''),
    summaryChartMode: args.summaryChartMode,
    requirementHash: stableHash(typeof args.freeRequirement === 'string' ? args.freeRequirement : ''),
    chartCount: rendered.chartCount,
    slideCount: rendered.slideCount,
    minScale,
    checklistPassed: !!(args.checklist && args.checklist.passed),
  };
  if (typeof args.generatedAt === 'string' && args.generatedAt) {
    manifest.generatedAt = args.generatedAt;
  }

  const style = [themeCss, componentCss, orientationVars(args.orientation), baseLayoutCss(args.layout)].join('\n');

  const head = [
    '<meta charset="utf-8">',
    CSP_META,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    rendered.headHtml,
    `<style>${style}</style>`,
    embedManifest(manifest),
  ].join('\n');

  const html =
    '<!doctype html>\n' +
    `<html data-he-layout="${args.layout}" data-he-orientation="${args.orientation}">\n` +
    `<head>\n${head}\n</head>\n` +
    `<body>\n${rendered.bodyHtml}\n<script>${RUNTIME_JS}</script>\n</body>\n` +
    '</html>\n';

  return { html, manifest };
}
