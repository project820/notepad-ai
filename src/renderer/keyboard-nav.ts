import { t } from './i18n';

/**
 * Left-Option-hold navigation mode.
 *
 * Entry: press ⌥ (LEFT Option) **AND an arrow key** together. Pressing ⌥ alone
 * never activates — that lets Option keep its normal role (CJK IME, etc.).
 *
 * Hold ⌥ + ←/→ to traverse navigable buttons (header + toolbar).
 * Hold ⌥ + ↑/↓ to jump between toolbar row and header row.
 * Enter / Space → activate focused button.
 * Release ⌥ or press Esc → exit; focus returns to whatever had it before.
 */

let active = false;
let items: HTMLElement[] = [];
let toolbarItems: HTMLElement[] = [];
let headerItems: HTMLElement[] = [];
let currentIndex = 0;
let prevFocus: HTMLElement | null = null;
let hintEl: HTMLDivElement | null = null;

function rebuildItems() {
  toolbarItems = Array.from(document.querySelectorAll<HTMLElement>('.toolbar .tb-icbtn'));
  headerItems = Array.from(document.querySelectorAll<HTMLElement>('.navbar .hdr-icbtn'));
  items = [...toolbarItems, ...headerItems];
}

function showHint() {
  if (!hintEl) {
    hintEl = document.createElement('div');
    hintEl.className = 'cmd-nav-hint';
    document.body.appendChild(hintEl);
  }
  hintEl.textContent = t('nav.hint');
  hintEl.classList.add('visible');
}

function hideHint() {
  hintEl?.classList.remove('visible');
}

function enter(initialDir: -1 | 1) {
  if (active) return;
  rebuildItems();
  if (items.length === 0) return;
  active = true;
  prevFocus = (document.activeElement as HTMLElement) ?? null;
  document.body.classList.add('cmd-nav-active');
  currentIndex = initialDir === 1 ? 0 : items.length - 1;
  items[currentIndex]?.focus();
  showHint();
}

function exit() {
  if (!active) return;
  active = false;
  document.body.classList.remove('cmd-nav-active');
  hideHint();
  prevFocus?.focus();
  prevFocus = null;
  items = [];
}

function move(dir: -1 | 1) {
  if (items.length === 0) return;
  currentIndex = (currentIndex + dir + items.length) % items.length;
  items[currentIndex]?.focus();
}

function jumpRow(target: 'header' | 'toolbar') {
  const focused = document.activeElement as HTMLElement;
  if (target === 'header') {
    if (headerItems.length === 0) return;
    const cur = focused?.getBoundingClientRect();
    let best = 0;
    if (cur) {
      let bestDelta = Infinity;
      headerItems.forEach((el, i) => {
        const r = el.getBoundingClientRect();
        const d = Math.abs(r.left + r.width / 2 - (cur.left + cur.width / 2));
        if (d < bestDelta) { bestDelta = d; best = i; }
      });
    }
    currentIndex = toolbarItems.length + best;
    items[currentIndex]?.focus();
  } else {
    if (toolbarItems.length === 0) return;
    const cur = focused?.getBoundingClientRect();
    let best = 0;
    if (cur) {
      let bestDelta = Infinity;
      toolbarItems.forEach((el, i) => {
        const r = el.getBoundingClientRect();
        const d = Math.abs(r.left + r.width / 2 - (cur.left + cur.width / 2));
        if (d < bestDelta) { bestDelta = d; best = i; }
      });
    }
    currentIndex = best;
    items[currentIndex]?.focus();
  }
}

export function installKeyboardNav() {
  document.addEventListener('keydown', (e) => {
    // Entry: Alt+arrow together. Alt-alone never activates.
    if (!active) {
      if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        enter(e.key === 'ArrowRight' ? 1 : -1);
        return;
      }
      return;
    }
    // Active mode handlers
    if (e.key === 'ArrowLeft') { e.preventDefault(); move(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (currentIndex < toolbarItems.length) jumpRow('header');
    }
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (currentIndex >= toolbarItems.length) jumpRow('toolbar');
    }
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      items[currentIndex]?.click();
    }
    else if (e.key === 'Escape') {
      e.preventDefault();
      exit();
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.code === 'AltLeft' && active) exit();
  });
  // Defensive: if Option somehow stuck, hide hint on mousedown outside header/toolbar
  document.addEventListener('mousedown', (e) => {
    if (!active) return;
    const target = e.target as HTMLElement;
    if (!target.closest('.toolbar') && !target.closest('.navbar')) exit();
  });
  window.addEventListener('blur', () => exit());
}
