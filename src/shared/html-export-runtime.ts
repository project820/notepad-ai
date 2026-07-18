/**
 * Canonical HTML-export runtime + CSP (G007 / PR-S4 §5.10c/§5.11).
 *
 * Single source of truth for the hash-pinned inline runtime and the matching
 * Content-Security-Policy. Extracted VERBATIM from the legacy renderer bundle
 * so `bundleHtml` output stays byte-identical. Swipe handlers / CSP re-pin are
 * later G007 slices — do not alter RUNTIME_JS here without re-pinning.
 */

import { sha256Base64 } from './sha256';

/** Minimal inline runtime — slide nav + resize-reflow + swipe (G005/G007).
 * Contains no remote URL, no fetch/XHR, no `url(` — stays self-contained. */
export const HTML_EXPORT_RUNTIME_JS = [
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
  'if(root.getAttribute("data-he-layout")==="slides"){document.addEventListener("keydown",function(e){if(e.key==="ArrowRight"||e.key==="PageDown"||e.key===" "){next();}else if(e.key==="ArrowLeft"||e.key==="PageUp"){prev();}});show(0);',
  // Touch-swipe navigation: horizontal swipe past a small threshold calls next/prev.
  'var sx=null;root.addEventListener("touchstart",function(e){if(e.touches&&e.touches.length===1)sx=e.touches[0].clientX;}, {passive:true});root.addEventListener("touchend",function(e){if(sx===null)return;var t=e.changedTouches&&e.changedTouches[0];if(!t){sx=null;return;}var dx=t.clientX-sx;sx=null;if(Math.abs(dx)<40)return;if(dx<0)next();else prev();}, {passive:true});}',
  // Size the ACTIVE slide's scale-host to the engine-scaled footprint (an
  // inactive slide is display:none → unmeasurable), and uniformly fit the fixed
  // canvas to the viewport. Pure transforms: no remote URL, stays self-contained.
  'function sizeActive(){var a=slides[cur];if(!a)return;var sc=a.querySelector(".he-scaler");if(!sc)return;var h=sc.parentNode;var s=parseFloat(sc.getAttribute("data-he-scale"))||1;h.style.width=(sc.offsetWidth*s)+"px";h.style.height=(sc.offsetHeight*s)+"px";}',
  'function fitDeck(){if(root.getAttribute("data-he-layout")!=="slides")return;var cw=root.offsetWidth,ch=root.offsetHeight;if(!cw||!ch)return;var f=Math.min(window.innerWidth/cw,window.innerHeight/ch);if(f>0)root.style.transform="translate(-50%,-50%) scale("+f+")";}',
  'function reflow(){sizeActive();fitDeck();}',
  'var t;window.addEventListener("resize",function(){clearTimeout(t);t=setTimeout(reflow,120);});',
  'fitDeck();',
  'window.__heReflow=reflow;',
  '})();',
].join('');

export const HTML_EXPORT_RUNTIME_JS_SHA256 = sha256Base64(HTML_EXPORT_RUNTIME_JS);

// Content-Security-Policy for the exported file (G006 defense-in-depth atop the
// structural allowlist validator). Only the inline runtime — pinned by its
// SHA-256 — may execute; default-src 'none' blocks every network fetch, and
// img/font are limited to inline data: URIs. `style-src 'unsafe-inline'` is kept
// because the document legitimately carries inline style attributes (and the
// allowlist validator already forbids remote url() in styles).
const HTML_EXPORT_CSP =
  [
    "default-src 'none'",
    'img-src data:',
    "style-src 'unsafe-inline'",
    `script-src 'sha256-${HTML_EXPORT_RUNTIME_JS_SHA256}'`,
    'font-src data:',
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ') + ';';

const HTML_EXPORT_CSP_META = `<meta http-equiv="Content-Security-Policy" content="${HTML_EXPORT_CSP}">`;
