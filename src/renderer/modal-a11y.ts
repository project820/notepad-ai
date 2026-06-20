/**
 * Accessible modal focus management (WCAG 2.1.2 No Keyboard Trap / 2.4.3 Focus
 * Order). A modal overlay must: mark itself `aria-modal`, move focus inside on
 * open, keep Tab/Shift+Tab cycling WITHIN the dialog, close on Escape, and
 * restore focus to the previously-focused element on close.
 *
 * `trapModalFocus` wires all of that and returns a teardown to call on close.
 */

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export type TrapModalOptions = {
  /** The dialog element to confine focus within (gets role/aria-modal). */
  dialog: HTMLElement;
  /** Called when the user presses Escape. */
  onEscape: () => void;
};

/** Visible, focusable descendants of the dialog, in DOM order. */
function focusables(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

/**
 * Install modal focus management. Returns a teardown function that removes the
 * key handler and restores focus to whatever was focused before the modal opened.
 */
export function trapModalFocus({ dialog, onEscape }: TrapModalOptions): () => void {
  const previouslyFocused = document.activeElement as HTMLElement | null;

  dialog.setAttribute('aria-modal', 'true');
  if (!dialog.getAttribute('role')) dialog.setAttribute('role', 'dialog');

  // Move focus inside the dialog so keyboard/screen-reader users start within it.
  const initial = focusables(dialog)[0];
  (initial ?? dialog).focus?.();

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onEscape();
      return;
    }
    if (e.key !== 'Tab') return;
    const f = focusables(dialog);
    if (f.length === 0) {
      // Nothing focusable — keep focus on the dialog itself.
      e.preventDefault();
      dialog.focus?.();
      return;
    }
    const first = f[0];
    const last = f[f.length - 1];
    const active = document.activeElement as HTMLElement | null;
    const outside = !active || !dialog.contains(active);
    if (e.shiftKey && (active === first || outside)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || outside)) {
      e.preventDefault();
      first.focus();
    }
  };

  // Capture phase so we intercept Tab before it reaches background controls.
  document.addEventListener('keydown', onKeyDown, true);

  return () => {
    document.removeEventListener('keydown', onKeyDown, true);
    // Restore focus to the opener (only if it's still in the document).
    if (previouslyFocused && document.contains(previouslyFocused)) {
      previouslyFocused.focus?.();
    }
  };
}
