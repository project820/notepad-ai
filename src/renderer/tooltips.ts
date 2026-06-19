/**
 * Body-level tooltip overlay (AC2 / AC7).
 *
 * The legacy `[data-tooltip]::after` pseudo renders the tooltip *inside* the
 * anchor's own box, so `overflow:hidden` ancestors (the toolbar row, side
 * panels) clip it — the "cut-off black chip" artifact — and it can be left
 * orphaned when the anchor is removed (dropdown close, locale re-render). This
 * installs a single fixed `.app-tooltip` node on <body>, positioned from the
 * target's bounding rect with viewport clamping, and tears it down the instant
 * the pointer leaves, focus moves away, a menu opens, or the target detaches
 * from the DOM.
 *
 * `[data-tooltip]` stays the source of truth — this module only reads it. While
 * installed, `body.app-tooltips-on` suppresses the CSS pseudo so a tooltip is
 * never rendered twice.
 *
 * Delegation note: pointer "enter" is delegated via the bubbling `pointerover`
 * / `pointerout` pair (with a `relatedTarget` containment guard) because the
 * non-bubbling `pointerenter` / `pointerleave` cannot be delegated from a
 * single document-level listener. The user-visible behaviour is identical.
 */

const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 6;

let tipEl: HTMLDivElement | null = null;
let currentTarget: HTMLElement | null = null;
let observer: MutationObserver | null = null;
let installed = false;

function tooltipTargetFrom(node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  const el = node.closest('[data-tooltip]');
  return el instanceof HTMLElement ? el : null;
}

function menuIsOpen(): boolean {
  return document.body.classList.contains('menu-open') || document.querySelector('.pm-menu') != null;
}

function hideTooltip(): void {
  currentTarget = null;
  if (tipEl) {
    tipEl.remove();
    tipEl = null;
  }
}

function positionTooltip(target: HTMLElement): void {
  if (!tipEl) return;
  const rect = target.getBoundingClientRect();
  const tipRect = tipEl.getBoundingClientRect();
  const vw = window.innerWidth || document.documentElement.clientWidth || 0;
  const vh = window.innerHeight || document.documentElement.clientHeight || 0;

  let top = rect.bottom + ANCHOR_GAP;
  // Flip above the target if it would overflow the viewport bottom edge.
  if (vh && top + tipRect.height > vh - VIEWPORT_MARGIN) {
    const above = rect.top - tipRect.height - ANCHOR_GAP;
    if (above >= VIEWPORT_MARGIN) top = above;
  }
  if (top < VIEWPORT_MARGIN) top = VIEWPORT_MARGIN;

  let left = rect.left + rect.width / 2 - tipRect.width / 2;
  if (vw && left + tipRect.width > vw - VIEWPORT_MARGIN) left = vw - tipRect.width - VIEWPORT_MARGIN;
  if (left < VIEWPORT_MARGIN) left = VIEWPORT_MARGIN;

  tipEl.style.left = `${Math.round(left)}px`;
  tipEl.style.top = `${Math.round(top)}px`;
}

function showTooltip(target: HTMLElement): void {
  const label = target.getAttribute('data-tooltip');
  if (!label || menuIsOpen()) return;
  hideTooltip();
  currentTarget = target;
  const el = document.createElement('div');
  el.className = 'app-tooltip';
  el.setAttribute('role', 'tooltip');
  el.textContent = label;
  document.body.appendChild(el);
  tipEl = el;
  positionTooltip(target);
}

/**
 * Install the overlay once. Returns an uninstall function (used by tests; the
 * app installs once for its lifetime and never tears down).
 */
export function installTooltips(): () => void {
  if (installed) return () => {};
  installed = true;
  document.body.classList.add('app-tooltips-on');

  const onPointerOver = (e: Event) => {
    const target = tooltipTargetFrom(e.target);
    if (target) showTooltip(target);
  };
  const onPointerOut = (e: Event) => {
    const target = tooltipTargetFrom(e.target);
    if (!target || target !== currentTarget) return;
    // Ignore moves *within* the same anchor (e.g. across the inner <svg>).
    const related = (e as PointerEvent).relatedTarget;
    if (related instanceof Node && target.contains(related)) return;
    hideTooltip();
  };
  const onFocusIn = (e: Event) => {
    const target = tooltipTargetFrom(e.target);
    if (target) showTooltip(target);
  };
  const onFocusOut = (e: Event) => {
    const target = tooltipTargetFrom(e.target);
    if (target && target === currentTarget) hideTooltip();
  };
  const onMouseDown = () => hideTooltip();
  const onScroll = () => hideTooltip();
  const onResize = () => hideTooltip();

  document.addEventListener('pointerover', onPointerOver, true);
  document.addEventListener('pointerout', onPointerOut, true);
  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('focusout', onFocusOut, true);
  document.addEventListener('mousedown', onMouseDown, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onResize);

  // Orphan guard: if the anchored target detaches (dropdown close / locale
  // re-render / any mutation) or a menu opens, kill the floating tooltip now.
  observer = new MutationObserver(() => {
    if (!currentTarget) return;
    if (!currentTarget.isConnected || menuIsOpen()) hideTooltip();
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class'],
  });

  return function uninstall() {
    document.removeEventListener('pointerover', onPointerOver, true);
    document.removeEventListener('pointerout', onPointerOut, true);
    document.removeEventListener('focusin', onFocusIn, true);
    document.removeEventListener('focusout', onFocusOut, true);
    document.removeEventListener('mousedown', onMouseDown, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onResize);
    observer?.disconnect();
    observer = null;
    hideTooltip();
    document.body.classList.remove('app-tooltips-on');
    installed = false;
  };
}
