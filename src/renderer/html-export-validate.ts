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

type LayoutContainmentInvariant = { id: string; description: string };

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

// ---------------------------------------------------------------------------
// validateExportDom — structural allowlist validator (G006).
//
// The regex `validateSelfContainedHtml` above is a denylist of known-bad
// substrings. This complements it with a DOM walk that STRUCTURALLY rejects:
//   - forbidden embedding/redirect tags (iframe/object/embed/base/frame…),
//   - any on* event-handler attribute on any element,
//   - any URL-bearing attribute whose value escapes the self-contained,
//     no-script-scheme allowlist (only data:, #fragment, or relative paths),
//   - <meta http-equiv="refresh"> redirects.
// Parsing the real DOM catches obfuscated attribute spellings/placements a
// flat regex misses. Pure + injectable parser → unit-testable under jsdom.
// ---------------------------------------------------------------------------

export type DomParse = (html: string) => Document;

const FORBIDDEN_TAGS = new Set(['iframe', 'object', 'embed', 'base', 'frame', 'frameset', 'applet']);

const URL_ATTRS = [
  'src',
  'href',
  'xlink:href',
  'poster',
  'data',
  'action',
  'formaction',
  'background',
  'cite',
  'longdesc',
  'manifest',
  'codebase',
];

/** Allowed only: empty, #fragment, data: URI, or a scheme-less relative path. */
function isAllowedExportUrl(raw: string): boolean {
  const v = raw.trim();
  if (v === '') return true;
  if (v.startsWith('#')) return true;
  if (/^data:/i.test(v)) return true;
  if (v.startsWith('//')) return false; // protocol-relative → remote
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return false; // any explicit scheme (http/blob/javascript/file…)
  return true; // scheme-less relative path
}

/** Every URL candidate in a srcset must satisfy the allowlist. */
function srcsetAllowed(value: string): boolean {
  return value
    .split(',')
    .map((c) => c.trim().split(/\s+/)[0] ?? '')
    .every((u) => isAllowedExportUrl(u));
}

function defaultDomParse(html: string): Document {
  if (typeof DOMParser === 'undefined') {
    throw new Error('validateExportDom requires a DOMParser (pass one explicitly outside a DOM env)');
  }
  return new DOMParser().parseFromString(html, 'text/html');
}

export function validateExportDom(html: string, parse: DomParse = defaultDomParse): SelfContainedVerdict {
  const violations: string[] = [];
  const src = typeof html === 'string' ? html : '';
  let doc: Document;
  try {
    doc = parse(src);
  } catch {
    return { ok: false, violations: ['unparseable export HTML'] };
  }
  const seen = new Set<string>();
  const flag = (msg: string) => {
    if (!seen.has(msg)) {
      seen.add(msg);
      violations.push(msg);
    }
  };

  for (const el of Array.from(doc.querySelectorAll('*'))) {
    const tag = el.tagName.toLowerCase();
    if (FORBIDDEN_TAGS.has(tag)) flag(`forbidden <${tag}>`);
    if (tag === 'meta') {
      const equiv = (el.getAttribute('http-equiv') ?? '').trim().toLowerCase();
      if (equiv === 'refresh') flag('<meta http-equiv="refresh"> redirect');
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value ?? '';
      if (name.startsWith('on')) {
        flag(`event-handler attribute ${name}`);
        continue;
      }
      if (name === 'srcset') {
        if (!srcsetAllowed(value)) flag('remote srcset');
        continue;
      }
      if (name === 'style') {
        const urls = value.match(/url\(\s*['"]?([^'")]*)['"]?\s*\)/gi) ?? [];
        for (const u of urls) {
          const inner = u.replace(/^url\(\s*['"]?/i, '').replace(/['"]?\s*\)$/, '');
          if (!isAllowedExportUrl(inner)) flag('remote url() in inline style');
        }
        continue;
      }
      if (URL_ATTRS.includes(name) && !isAllowedExportUrl(value)) {
        flag(`disallowed URL in ${name}=`);
      }
    }
  }

  return { ok: violations.length === 0, violations };
}
