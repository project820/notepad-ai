/**
 * sanitize-html.ts — strict DOMPurify policy for converted-document HTML (Phase 1).
 *
 * kordoc-produced HTML (from attacker-influenceable DOCX/HWP/PDF/XLSX) is rendered
 * into the privileged preview DOM. Previously it was assigned via raw innerHTML,
 * which — combined with the (now closed) navigation gap — was a real compromise
 * path. This module returns a sanitized DocumentFragment that callers insert via
 * `replaceChildren`, never raw innerHTML.
 *
 * Policy (intentionally aggressive; P0 favors safety over visual fidelity — full
 * WebContents isolation that restores links/resources is the P1 follow-up):
 *   - forbid active/structural tags (script/style/form/base/object/iframe/embed/svg/math)
 *   - strip every event handler (on*), srcdoc, and every URL-bearing attribute,
 *     so converted HTML can neither navigate, submit, nor load any resource.
 */

import DOMPurify from 'dompurify';

const FORBID_TAGS = ['svg', 'math', 'form', 'base', 'object', 'iframe', 'embed', 'script', 'style'];

/** Attributes that can trigger navigation or a resource load — removed wholesale. */
const URL_BEARING_ATTRS = new Set([
  'href',
  'src',
  'srcset',
  'action',
  'formaction',
  'poster',
  'background',
  'cite',
  'data',
  'codebase',
  'ping',
  'longdesc',
  'xlink:href',
]);

let hookInstalled = false;
function ensureHook(): void {
  if (hookInstalled) return;
  DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
    const name = (data.attrName ?? '').toLowerCase();
    if (name.startsWith('on') || name === 'srcdoc' || URL_BEARING_ATTRS.has(name)) {
      data.keepAttr = false;
    }
  });
  hookInstalled = true;
}

/** Sanitize converted-document HTML into an inert DocumentFragment. */
export function sanitizeConvertedHtml(html: string): DocumentFragment {
  ensureHook();
  return DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS,
  }) as unknown as DocumentFragment;
}

/** Serialize the sanitized fragment to an HTML string for srcdoc embedding. */
function sanitizedHtmlString(html: string): string {
  const holder = document.createElement('div');
  holder.appendChild(sanitizeConvertedHtml(html));
  return holder.innerHTML;
}

const CONVERTED_FRAME_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";

/**
 * Render converted-document HTML inside an isolated, script-free, opaque-origin
 * `<iframe sandbox>` (G006). Even if a DOMPurify rule were ever bypassed, the
 * content runs in a separate browsing context: no script execution, no access to
 * the privileged renderer (`window.api`), and an enforced inert CSP. The HTML is
 * still DOMPurify-sanitized first (defense in depth). The sandbox token is left
 * empty on purpose — NEVER add `allow-scripts` or `allow-same-origin`.
 */
export function buildConvertedHtmlFrame(html: string): HTMLIFrameElement {
  const frame = document.createElement('iframe');
  frame.className = 'converted-html-frame';
  frame.setAttribute('sandbox', '');
  frame.srcdoc =
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${CONVERTED_FRAME_CSP}">` +
    `</head><body>${sanitizedHtmlString(html)}</body></html>`;
  return frame;
}
