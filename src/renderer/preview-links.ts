import { classifyLinkHref } from './link-policy';
/**
 * Preview link & footnote interactions (#2):
 *  - web URLs (http/https) open in the external browser (via injected opener),
 *  - footnote citations jump to the definition and show a floating
 *    "← back" overlay to return to the prior scroll position,
 *  - hovering a footnote citation previews the footnote content.
 *
 * DOM-wired but the opener is injected so it is unit-testable.
 */

/** Escape a value for safe use inside an [id="…"] attribute selector. */
function attrEsc(s: string): string {
  return s.replace(/["\\]/g, '\\$&');
}
export type WirePreviewLinksOptions = {
  /** Open an http/https URL externally (main process allowlists the scheme). */
  openExternal: (url: string) => void;
  /** Label for the "return to previous position" overlay button. */
  backLabel?: string;
  /** Scroll container (defaults to the preview's parent). */
  scroller?: HTMLElement;
};

export function wirePreviewLinks(root: HTMLElement, opts: WirePreviewLinksOptions): () => void {
  const openExternal = opts.openExternal;
  const backLabel = opts.backLabel ?? '← back';
  const getScroller = () => opts.scroller ?? (root.parentElement as HTMLElement | null) ?? root;

  let backBtn: HTMLButtonElement | null = null;
  let returnTo: number | null = null;

  function clearBack() {
    backBtn?.remove();
    backBtn = null;
    returnTo = null;
  }

  function showBack() {
    const scroller = getScroller();
    if (backBtn) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'preview-back-btn';
    btn.textContent = backLabel;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (returnTo != null) scroller.scrollTop = returnTo;
      clearBack();
    });
    document.body.appendChild(btn);
    backBtn = btn;
  }

  const onClick = (e: Event) => {
    const a = (e.target as HTMLElement).closest('a');
    if (!a || !root.contains(a)) return;
    const href = a.getAttribute('href') ?? '';
    if (/^https?:/i.test(href)) {
      e.preventDefault();
      openExternal(href);
      return;
    }
    if (href.startsWith('#') && href.length > 1) {
      e.preventDefault();
      const id = href.slice(1);
      const target = root.querySelector<HTMLElement>(`[id="${attrEsc(id)}"]`);
      if (target) {
        returnTo = getScroller().scrollTop;
        target.scrollIntoView({ block: 'center' });
        showBack();
      }
    }
  };

  // Footnote hover preview.
  let tip: HTMLElement | null = null;
  const hideTip = () => {
    tip?.remove();
    tip = null;
  };
  const onOver = (e: Event) => {
    const ref = (e.target as HTMLElement).closest('.footnote-ref a, a.footnote-ref') as HTMLElement | null;
    if (!ref || !root.contains(ref)) return;
    const href = ref.getAttribute('href') ?? '';
    if (!href.startsWith('#')) return;
    const def = root.querySelector<HTMLElement>(`[id="${attrEsc(href.slice(1))}"]`);
    if (!def) return;
    hideTip();
    const t = document.createElement('div');
    t.className = 'footnote-tip';
    t.textContent = (def.textContent ?? '').replace(/↩\uFE0E?/g, '').trim();
    document.body.appendChild(t);
    const r = ref.getBoundingClientRect();
    t.style.left = `${Math.min(r.left, window.innerWidth - t.offsetWidth - 12)}px`;
    t.style.top = `${r.bottom + 6}px`;
    tip = t;
  };
  const onOut = (e: Event) => {
    const ref = (e.target as HTMLElement).closest('.footnote-ref a, a.footnote-ref');
    if (ref) hideTip();
  };

  root.addEventListener('click', onClick);
  root.addEventListener('mouseover', onOver);
  root.addEventListener('mouseout', onOut);

  return () => {
    root.removeEventListener('click', onClick);
    root.removeEventListener('mouseover', onOver);
    root.removeEventListener('mouseout', onOut);
    clearBack();
    hideTip();
  };
}
export function installDocumentLinkBackstop(previewEl: HTMLElement, openExternal: (url: string) => void) {
  document.addEventListener('submit', (e) => e.preventDefault(), true);
  document.addEventListener(
    'click',
    (e) => {
      const anchor = (e.target as Element | null)?.closest?.('a');
      if (!anchor || previewEl.contains(anchor)) return;
      const decision = classifyLinkHref(anchor.getAttribute('href'));
      if (decision.action === 'external') {
        e.preventDefault();
        openExternal(decision.url);
      } else if (decision.action === 'deny') {
        e.preventDefault();
      }
    },
    true,
  );
}
