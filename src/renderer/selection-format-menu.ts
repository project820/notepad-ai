import { t } from './i18n';
import type { FormatAction } from './formatting';

/**
 * Right-click formatting menu for a non-empty text selection (#5 · AC6).
 *
 * Intercepts `contextmenu` on the two editing surfaces (CodeMirror source +
 * contenteditable preview) and, when there is a non-empty selection, shows a
 * compact menu with the same formatting subset the toolbar dispatches. The
 * chosen action is routed through the shared `dispatchFormat` so MD stays the
 * source of truth.
 *
 * Coexistence / conflict rules (HARD):
 *   - Inside a table cell (`.preview-table-wrap`) the existing Excel-style table
 *     context menu wins — this menu does NOT open.
 *   - Inside the Block AI pill/popup (`.ba-pill` / `.ba-popup`) or the AI
 *     consultant panel (`.uc-host`) it never opens (those own their own UX).
 *   - With no selection it does nothing, so the native context menu is left
 *     untouched.
 *   - It only suppresses the selection (mousedown preventDefault) — it never
 *     mutates it — so the Block AI selection-capture / pill flow is preserved.
 */

type Surface = 'editor' | 'preview';

export type SelectionFormatMenuDeps = {
  /** Host element that contains the CodeMirror editor. */
  editorEl: HTMLElement;
  /** The contenteditable preview root. */
  previewEl: HTMLElement;
  /** True when the CodeMirror editor currently has a non-empty selection. */
  hasEditorSelection: () => boolean;
  /** Apply a formatting action to the given surface (same path as the toolbar). */
  dispatchFormat: (action: FormatAction, surface: Surface) => void;
};

type CtxItem = { action: FormatAction; labelKey: string };

/** Toolbar-parity subset: bold/italic/strike/highlight/code/link/quote/list/heading/footnote. */
const ITEMS: CtxItem[] = [
  { action: 'bold', labelKey: 'ctx.bold' },
  { action: 'italic', labelKey: 'ctx.italic' },
  { action: 'strike', labelKey: 'ctx.strike' },
  { action: 'highlight', labelKey: 'ctx.highlight' },
  { action: 'code', labelKey: 'ctx.code' },
  { action: 'link', labelKey: 'ctx.link' },
  { action: 'quote', labelKey: 'ctx.quote' },
  { action: 'ul', labelKey: 'ctx.list' },
  { action: 'h2', labelKey: 'ctx.heading' },
  { action: 'footnote', labelKey: 'ctx.footnote' },
];

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

export function installSelectionFormatMenu(deps: SelectionFormatMenuDeps): () => void {
  let menuEl: HTMLElement | null = null;

  function closeMenu() {
    menuEl?.remove();
    menuEl = null;
  }

  /** Decide which surface (if any) owns a non-empty selection for this target. */
  function selectionSurface(target: HTMLElement): Surface | null {
    if (deps.previewEl.contains(target)) {
      const sel = window.getSelection();
      if (
        sel &&
        !sel.isCollapsed &&
        sel.toString().trim().length > 0 &&
        sel.anchorNode &&
        deps.previewEl.contains(sel.anchorNode)
      ) {
        return 'preview';
      }
      return null;
    }
    if (deps.editorEl.contains(target)) {
      return deps.hasEditorSelection() ? 'editor' : null;
    }
    return null;
  }

  function openMenu(x: number, y: number, surface: Surface) {
    closeMenu();
    const menu = document.createElement('div');
    // Reuse the table context-menu visual; the extra class is the test/query hook.
    menu.className = 'selection-ctx-menu table-ctx-menu';
    menu.setAttribute('role', 'menu');
    menu.contentEditable = 'false';
    menu.innerHTML = ITEMS.map(
      (it) => `<button type="button" role="menuitem" data-action="${it.action}">${escapeHtml(t(it.labelKey))}</button>`,
    ).join('');
    document.body.appendChild(menu);
    menuEl = menu;

    // Position within the viewport (anchored at the cursor coordinates).
    const rect = menu.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 8);
    const top = Math.min(y, window.innerHeight - rect.height - 8);
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${Math.max(8, top)}px`;

    // Keep the selection alive — clicking the menu must not collapse it.
    menu.addEventListener('mousedown', (e) => e.preventDefault());
    menu.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button[data-action]') as HTMLButtonElement | null;
      if (!btn) return;
      const action = btn.dataset.action as FormatAction;
      closeMenu();
      deps.dispatchFormat(action, surface);
    });

    const onAway = (e: Event) => {
      if (menuEl && !menuEl.contains(e.target as Node)) closeMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu();
    };
    setTimeout(() => {
      document.addEventListener('mousedown', onAway, { once: true });
      document.addEventListener('keydown', onKey, { once: true });
      window.addEventListener('scroll', closeMenu, { once: true, capture: true });
    }, 0);
  }

  function onContextMenu(e: MouseEvent) {
    const target = e.target as HTMLElement | null;
    if (!target || typeof target.closest !== 'function') return;
    // Table cells keep their own Excel-style menu.
    if (target.closest('.preview-table-wrap')) return;
    // Block AI surfaces + the AI consultant panel own their own UX.
    if (target.closest('.ba-pill') || target.closest('.ba-popup') || target.closest('.uc-host')) return;

    const surface = selectionSurface(target);
    if (!surface) return; // no selection on a known surface → leave the native menu

    e.preventDefault();
    openMenu(e.clientX, e.clientY, surface);
  }

  document.addEventListener('contextmenu', onContextMenu);
  return () => {
    document.removeEventListener('contextmenu', onContextMenu);
    closeMenu();
  };
}
