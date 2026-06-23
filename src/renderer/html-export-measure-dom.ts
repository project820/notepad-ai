/**
 * html-export-measure-dom.ts — the REAL DOM measurement adapter (G006).
 *
 * Supplies the two functions the G005 layout engine
 * (`planSlides` / `planScrollContainment`) takes as INJECTED dependencies, but
 * backed by a LIVE `document` instead of a deterministic fake:
 *
 *   - `domFontsReady(doc?)` → a `FontsReadyFn`: resolves once
 *     `document.fonts.ready` settles AND a layout tick has flushed (double
 *     `requestAnimationFrame`), so every measurement that follows reads a
 *     stable, font-correct layout.
 *   - `createDomMeasure(opts)` → a `MeasureFn`: renders the candidate blocks
 *     into an offscreen measurement root constrained to the slide's safe width,
 *     forces a synchronous layout, and reads back the natural content footprint
 *     (`scrollWidth`/`scrollHeight` + widest descendant). Returns
 *     `{ contentW, contentH }` in CSS px — the exact shape the engine expects.
 *
 * This module is MEASUREMENT ONLY — no pagination, scaling, or layout policy
 * lives here (that is the engine's job). It renders blocks via the renderer's
 * `renderBlocks` so the measured markup is byte-for-byte the document's markup.
 *
 * DOM-GUARDED: outside a real DOM (e.g. the Node/vitest engine unit tests, which
 * inject their own deterministic fake measure) every entry point no-ops cleanly
 * — `createDomMeasure` returns a measure that yields a zero footprint and
 * `domFontsReady` resolves immediately — so importing this module is always
 * safe, even where `document` is undefined.
 */

import type { ContentBlock } from './html-export-model';
import type { FontsReadyFn, MeasureFn, SlideDims } from './html-export-layout';
import { renderBlocks } from './html-export-renderer';

/** True only when a usable DOM (createElement + a live `<body>`) is present. */
export function hasDom(doc?: Document): boolean {
  const d = doc ?? (typeof document !== 'undefined' ? document : undefined);
  return !!d && typeof d.createElement === 'function' && !!d.body;
}

export type DomMeasureOptions = {
  /** The document to measure within. Defaults to the ambient `document`. */
  doc?: Document;
  /**
   * Extra inset (px, per horizontal edge) trimmed from `dims.safeW` before
   * laying content out — use when the render adds padding INSIDE the engine's
   * safe area. Defaults to 0 (SlideDims already nets out the safe-area pad).
   */
  inset?: number;
  /**
   * The bundle's stylesheet (`buildExportStyle(theme, orientation, layout)`).
   * Injected once into the measurement document and the root is scoped with the
   * `.he-doc` class, so the offscreen layout is measured with the SAME theme
   * variables, component classes, and text-wrap rules the shipped document uses.
   * Omitted → the root is measured against whatever styles the document already
   * carries (e.g. the gate, which loads the themed bundle first).
   */
  styleCss?: string;
};

/** The id of the singleton offscreen measurement root appended to `<body>`. */
export const MEASURE_ROOT_ID = 'he-measure-root';
/** The id of the singleton injected measurement stylesheet. */
const MEASURE_STYLE_ID = 'he-measure-style';

/** Create (or reuse) the offscreen, flow-neutral measurement root in `doc`,
 *  optionally injecting the export stylesheet so measurement is fully styled. */
function ensureRoot(doc: Document, styleCss?: string): HTMLElement {
  if (typeof styleCss === 'string' && styleCss) {
    let st = doc.getElementById(MEASURE_STYLE_ID) as HTMLStyleElement | null;
    if (!st) {
      st = doc.createElement('style');
      st.id = MEASURE_STYLE_ID;
      (doc.head ?? doc.documentElement).appendChild(st);
    }
    if (st.textContent !== styleCss) st.textContent = styleCss;
  }
  const existing = doc.getElementById(MEASURE_ROOT_ID);
  if (existing) {
    // `.he-doc` carries the inherited text-wrap rules; scoped class rules
    // (.he-paragraph, .he-code, …) apply directly off the injected stylesheet.
    (existing as HTMLElement).className = 'he-doc';
    return existing as HTMLElement;
  }
  const root = doc.createElement('div');
  root.id = MEASURE_ROOT_ID;
  root.className = 'he-doc';
  root.setAttribute('aria-hidden', 'true');
  root.setAttribute('data-he-measure', '');
  // Absolutely positioned + offscreen so it never contributes to the document's
  // own scroll size or perturbs the layout being asserted.
  const s = root.style;
  s.position = 'absolute';
  s.left = '-100000px';
  s.top = '0';
  s.visibility = 'hidden';
  s.pointerEvents = 'none';
  s.margin = '0';
  s.padding = '0';
  doc.body.appendChild(root);
  return root;
}

/**
 * Build the REAL synchronous `MeasureFn`. The engine awaits the `FontsReadyFn`
 * once up front, then calls this many times per plan — so measurement must be
 * synchronous and side-effect-free (it leaves the root empty after each read).
 *
 * Width is constrained to the slide's usable width so wrapping matches the real
 * slide; height is left natural (unconstrained) so the true content footprint
 * is read. The widest descendant is included so a block whose intrinsic content
 * is wider than the column (a wide table / long code line) is reported as
 * horizontal overflow — letting the engine split / transpose before scaling.
 */
export function createDomMeasure(options: DomMeasureOptions = {}): MeasureFn {
  const doc = options.doc ?? (typeof document !== 'undefined' ? document : undefined);
  const inset = Number.isFinite(options.inset) ? Math.max(0, options.inset as number) : 0;
  const styleCss = typeof options.styleCss === 'string' ? options.styleCss : undefined;

  if (!hasDom(doc)) {
    // No DOM — return a no-op measure. (Engine tests inject their own fake.)
    return () => ({ contentW: 0, contentH: 0 });
  }

  const root = ensureRoot(doc as Document, styleCss);

  return (blocks: ContentBlock[], dims: SlideDims): { contentW: number; contentH: number } => {
    const usableW = Math.max(1, Math.round(dims.safeW - inset * 2));
    root.style.width = `${usableW}px`;
    root.style.maxWidth = `${usableW}px`;
    root.style.height = 'auto';
    root.innerHTML = renderBlocks(Array.isArray(blocks) ? blocks : []);
    // Force a synchronous layout flush before reading geometry.
    void root.offsetHeight;
    const contentW = Math.max(root.scrollWidth, widestDescendant(root));
    const contentH = Math.max(root.scrollHeight, root.offsetHeight);
    // Reset so a later measurement (or the document's own scroll size) is clean.
    root.innerHTML = '';
    root.style.width = '';
    root.style.maxWidth = '';
    return { contentW: Math.ceil(contentW), contentH: Math.ceil(contentH) };
  };
}

/**
 * Widest intrinsic width among the root's children. A block that overflows its
 * column (e.g. a `.he-table-wrap` / `.he-code` with `overflow-x:auto`) keeps the
 * column width itself but exposes the overflow via the wrapper's `scrollWidth`.
 */
function widestDescendant(root: HTMLElement): number {
  let w = 0;
  const kids = root.children;
  for (let i = 0; i < kids.length; i++) {
    const el = kids[i] as HTMLElement;
    w = Math.max(w, el.scrollWidth, Math.ceil(el.getBoundingClientRect().width));
  }
  return w;
}

/** Resolve once the doc's font set is ready, then after a settled layout tick. */
function settleLayout(doc: Document): Promise<void> {
  const win = doc.defaultView;
  const raf =
    win && typeof win.requestAnimationFrame === 'function' ? win.requestAnimationFrame.bind(win) : null;
  if (!raf) return Promise.resolve();
  // Double rAF: first frame applies pending style/layout, second observes it.
  return new Promise<void>((resolve) => raf(() => raf(() => resolve())));
}

/**
 * Build the REAL `FontsReadyFn`. Awaits `document.fonts.ready` (when the Font
 * Loading API is present) then a settled layout tick. DOM-guarded: resolves
 * immediately outside a DOM, or when the fonts API is unavailable.
 */
export function domFontsReady(doc?: Document): FontsReadyFn {
  const d = doc ?? (typeof document !== 'undefined' ? document : undefined);
  return async (): Promise<void> => {
    if (!hasDom(d)) return;
    const ready = (d as Document).fonts?.ready;
    if (ready && typeof (ready as Promise<unknown>).then === 'function') {
      try {
        await ready;
      } catch {
        /* Font loading rejected — proceed; the layout settle below still runs. */
      }
    }
    await settleLayout(d as Document);
  };
}
