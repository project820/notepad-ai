/**
 * Lightweight popover dropdown — used by header icon buttons.
 * Items render as menu rows with optional check-mark for current selection.
 */

export type MenuItem<T extends string = string> = {
  value: T;
  label: string;
  hint?: string;
  selected?: boolean;
};

export type OpenMenuOptions<T extends string = string> = {
  anchor: HTMLElement;
  items: MenuItem<T>[];
  onSelect: (value: T) => void;
  minWidth?: number;
  align?: 'start' | 'end'; // align to anchor's left or right edge
};

let activeMenu: HTMLElement | null = null;
let activeAnchor: HTMLElement | null = null;
let activeOutsideHandler: ((e: MouseEvent) => void) | null = null;
let activeEscHandler: ((e: KeyboardEvent) => void) | null = null;

export function closeOpenMenu() {
  activeMenu?.remove();
  activeMenu = null;
  activeAnchor = null;
  document.body.classList.remove('menu-open');
  if (activeOutsideHandler) {
    document.removeEventListener('mousedown', activeOutsideHandler, true);
    activeOutsideHandler = null;
  }
  if (activeEscHandler) {
    document.removeEventListener('keydown', activeEscHandler);
    activeEscHandler = null;
  }
}

export function openMenu<T extends string>(opts: OpenMenuOptions<T>): void {
  // Toggle: if this exact anchor already owns an open menu, just close it.
  const sameAnchor = activeAnchor === opts.anchor;
  closeOpenMenu();
  if (sameAnchor) return;
  activeAnchor = opts.anchor;

  const menu = document.createElement('div');
  menu.className = 'pm-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = opts.items
    .map(
      (it) => `
        <button class="pm-item ${it.selected ? 'pm-item-selected' : ''}" role="menuitemradio" aria-checked="${it.selected ? 'true' : 'false'}" tabindex="-1" data-value="${it.value}">
          <span class="pm-check" aria-hidden="true">${it.selected ? '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="2.5,6.5 5,9 9.5,3.5"/></svg>' : ''}</span>
          <span class="pm-label">${escape(it.label)}</span>
          ${it.hint ? `<span class="pm-hint">${escape(it.hint)}</span>` : ''}
        </button>`,
    )
    .join('');

  if (opts.minWidth) menu.style.minWidth = `${opts.minWidth}px`;

  document.body.appendChild(menu);
  activeMenu = menu;
  document.body.classList.add('menu-open');

  // Position next to anchor with viewport clamping
  const rect = opts.anchor.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;
  const align = opts.align ?? 'end';

  let top = rect.bottom + 6;
  let left = align === 'end' ? rect.right - menuRect.width : rect.left;

  // Clamp horizontally
  if (left + menuRect.width > viewportW - 8) left = viewportW - menuRect.width - 8;
  if (left < 8) left = 8;
  // Flip vertically if it would overflow
  if (top + menuRect.height > viewportH - 8) {
    top = rect.top - menuRect.height - 6;
    if (top < 8) top = 8;
  }

  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('.pm-item'));
  items.forEach((btn) => {
    btn.addEventListener('click', () => {
      const value = btn.dataset.value as T;
      closeOpenMenu();
      opts.onSelect(value);
    });
  });

  // Keyboard operability (WAI-ARIA menu): focus the selected item (or the first)
  // on open, move with Arrow/Home/End, activate with Enter/Space.
  const focusItem = (i: number) => {
    if (items.length === 0) return;
    const idx = ((i % items.length) + items.length) % items.length;
    items[idx].focus();
  };
  const selectedIdx = items.findIndex((b) => b.classList.contains('pm-item-selected'));
  setTimeout(() => focusItem(selectedIdx >= 0 ? selectedIdx : 0), 0);
  menu.addEventListener('keydown', (e) => {
    const cur = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusItem(cur < 0 ? 0 : cur + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusItem(cur < 0 ? items.length - 1 : cur - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusItem(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      focusItem(items.length - 1);
    } else if ((e.key === 'Enter' || e.key === ' ') && cur >= 0) {
      e.preventDefault();
      items[cur].click();
    }
  });

  const onOutside = (e: MouseEvent) => {
    const t = e.target as Node;
    // Ignore clicks on the anchor itself — its own handler will toggle.
    if (opts.anchor.contains(t) || opts.anchor === t) return;
    if (menu.contains(t)) return;
    closeOpenMenu();
  };
  const onEsc = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeOpenMenu();
  };
  activeOutsideHandler = onOutside;
  activeEscHandler = onEsc;
  setTimeout(() => {
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onEsc);
  }, 0);
}

export type OpenPanelOptions = {
  anchor: HTMLElement;
  /** Caller-built panel contents (already wired). Appended into the popover. */
  content: HTMLElement;
  minWidth?: number;
  align?: 'start' | 'end';
};

/**
 * Like {@link openMenu}, but hosts arbitrary caller-built content (steppers,
 * segmented controls, …) instead of a flat item list. Shares the same
 * single-popover state, viewport clamping, and outside-click / Esc dismissal.
 */
export function openPanel(opts: OpenPanelOptions): void {
  const sameAnchor = activeAnchor === opts.anchor;
  closeOpenMenu();
  if (sameAnchor) return;
  activeAnchor = opts.anchor;

  const menu = document.createElement('div');
  menu.className = 'pm-menu pm-panel';
  menu.setAttribute('role', 'dialog');
  menu.appendChild(opts.content);
  if (opts.minWidth) menu.style.minWidth = `${opts.minWidth}px`;
  document.body.appendChild(menu);
  activeMenu = menu;
  document.body.classList.add('menu-open');

  const rect = opts.anchor.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const align = opts.align ?? 'end';
  let top = rect.bottom + 6;
  let left = align === 'end' ? rect.right - menuRect.width : rect.left;
  if (left + menuRect.width > window.innerWidth - 8) left = window.innerWidth - menuRect.width - 8;
  if (left < 8) left = 8;
  if (top + menuRect.height > window.innerHeight - 8) {
    top = rect.top - menuRect.height - 6;
    if (top < 8) top = 8;
  }
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  const onOutside = (e: MouseEvent) => {
    const node = e.target as Node;
    if (opts.anchor.contains(node) || opts.anchor === node) return;
    if (menu.contains(node)) return;
    closeOpenMenu();
  };
  const onEsc = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeOpenMenu();
  };
  activeOutsideHandler = onOutside;
  activeEscHandler = onEsc;
  setTimeout(() => {
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onEsc);
  }, 0);
}
function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}
