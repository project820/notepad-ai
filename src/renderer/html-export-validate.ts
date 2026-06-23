/**
 * html-export-validate.ts — strengthened self-contained HTML validator (G004).
 *
 * The NEW home for `validateSelfContainedHtml`. A strict SUPERSET of the legacy
 * copy in html-export-prompt.ts (which G007 removes): in addition to remote
 * `<script src>` / `<link href>` / `<img src>` / `@import` / `url()`, it also
 * catches remote `srcset` / `poster`, embedded `<iframe>`/`<object>`/`<embed>`,
 * remote `<use href="http…">`, CSS `image-set()`, and inline remote
 * `fetch()` / `XMLHttpRequest.open()`. Pure + deterministic.
 *
 * Also exports `layoutDiagnostics()` — a pure description of the containment
 * invariants the G005/G006 gate can assert against a rendered document.
 */

import type { LayoutKind, Orientation } from './html-export-state';

export type SelfContainedVerdict = { ok: boolean; violations: string[] };

/**
 * Detect remote/raster assets and remote network calls that break the
 * self-contained, offline contract. Pure + unit-tested. Never throws.
 */
export function validateSelfContainedHtml(html: string): SelfContainedVerdict {
  const violations: string[] = [];
  const src = typeof html === 'string' ? html : '';
  const add = (msg: string, re: RegExp) => {
    if (re.test(src)) violations.push(msg);
  };

  // --- Legacy vectors (kept identical so this is a strict superset) ---
  add('remote <script src>', /<script\b[^>]*\bsrc\s*=\s*["']?(?:https?:)?\/\//i);
  add('remote stylesheet <link>', /<link\b[^>]*\bhref\s*=\s*["']?(?:https?:)?\/\//i);
  add('remote/raster <img src>', /<img\b[^>]*\bsrc\s*=\s*["']?(?:https?:)?\/\//i);
  add('remote CSS @import', /@import\s+(?:url\()?["']?(?:https?:)?\/\//i);
  add('remote url() asset (web font / image)', /url\(\s*["']?(?:https?:)?\/\//i);

  // --- Strengthened vectors (G004) ---
  add('remote srcset', /\bsrcset\s*=\s*["']?[^"'>]*(?:https?:)?\/\//i);
  add('remote poster', /\bposter\s*=\s*["']?(?:https?:)?\/\//i);
  add('embedded <iframe>', /<iframe\b/i);
  add('embedded <object>', /<object\b/i);
  add('embedded <embed>', /<embed\b/i);
  add('remote <use href>', /<use\b[^>]*\b(?:xlink:href|href)\s*=\s*["']?(?:https?:)?\/\//i);
  add('remote CSS image-set()', /image-set\(\s*[^)]*(?:https?:)?\/\//i);
  add('inline remote fetch()', /fetch\(\s*["'`](?:https?:)?\/\//i);
  add('inline remote XMLHttpRequest', /\.open\s*\(\s*["'][^"']+["']\s*,\s*["'](?:https?:)?\/\//i);

  return { ok: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// layoutDiagnostics — pure containment-invariant description (G005/G006 gate).
// ---------------------------------------------------------------------------

export type LayoutContainmentInvariant = { id: string; description: string };

export type LayoutDiagnostics = {
  layout: LayoutKind;
  orientation: Orientation | null;
  invariants: LayoutContainmentInvariant[];
};

/**
 * Describe the containment invariants a correctly-rendered document of the
 * given layout must satisfy. Pure + deterministic — a stub the G005/G006 fit
 * gate consumes; it asserts shape, it does not measure the DOM.
 */
export function layoutDiagnostics(args: { layout: LayoutKind; orientation?: Orientation }): LayoutDiagnostics {
  const layout = args.layout;
  const invariants: LayoutContainmentInvariant[] =
    layout === 'slides'
      ? [
          { id: 'no-page-scroll', description: 'html,body overflow:hidden — a slide deck never page-scrolls' },
          { id: 'single-active-slide', description: 'exactly one .slide.active (display:flex); all others display:none' },
          {
            id: 'slide-fits-viewport',
            description: 'the active slide fills the viewport without overflow (scale applied by G005)',
          },
        ]
      : [
          { id: 'vertical-only', description: 'overflow-x:hidden — the document scrolls vertically only' },
          { id: 'readable-width', description: 'content is constrained to --he-readable-width and centered' },
        ];
  return { layout, orientation: args.orientation ?? null, invariants };
}
