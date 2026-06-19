import { t } from './i18n';
import {
  columnHasData,
  deleteColumn,
  deleteRow,
  insertColumn,
  insertRow,
  replaceCell,
  rowHasData,
} from './table-md';

/**
 * Wire contenteditable cells in the rendered preview, syncing back to the MD
 * source through the pure `table-md` helpers (MD is the source of truth).
 *
 * UX (v1.1): select a cell (left-click), then RIGHT-CLICK it for an Excel-style
 * context menu (insert/delete rows & columns relative to that cell). No more
 * always-visible toolbar.
 *
 * Turndown isolation (HARD requirement)
 * -------------------------------------
 *   - the table WRAPPER is `contenteditable="false"` (a non-editable island),
 *   - only individual CELLS are `contenteditable="true"`,
 *   - cell input/keydown/paste events `stopPropagation()` so the global preview
 *     input handler never serializes table edits.
 *
 * Cell formatting (AC4): a cell's inline HTML (bold/italic/code) is converted to
 * inline Markdown on blur so formatting persists into the MD source instead of
 * being flattened to plain text.
 */

type GetDoc = () => string;
type SetDoc = (newDoc: string) => void;
type PatchResult = { doc: string; changed: boolean };

/** Convert a cell's inline HTML to inline Markdown (bold/italic/code), DOM-walked
 *  so it survives <b>/<strong>, <i>/<em>, <code>, and span style-based formatting. */
export function cellHtmlToInlineMarkdown(cell: HTMLElement): string {
  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();
    if (tag === 'br') return ' ';
    let inner = '';
    el.childNodes.forEach((child) => {
      inner += walk(child);
    });
    const style = (el.getAttribute('style') ?? '').toLowerCase();
    const bold = tag === 'b' || tag === 'strong' || /font-weight:\s*(bold|[6-9]00)/.test(style);
    const italic = tag === 'em' || tag === 'i' || /font-style:\s*italic/.test(style);
    const code = tag === 'code';
    let s = inner;
    if (code) s = '`' + s + '`';
    if (italic && s.trim()) s = '*' + s + '*';
    if (bold && s.trim()) s = '**' + s + '**';
    return s;
  };
  let out = '';
  cell.childNodes.forEach((n) => {
    out += walk(n);
  });
  return out.replace(/\s+/g, ' ').trim();
}

let openMenuEl: HTMLElement | null = null;
function closeCellMenu() {
  openMenuEl?.remove();
  openMenuEl = null;
}

export function wirePreviewTables(root: HTMLElement, getDoc: GetDoc, setDoc: SetDoc) {
  function apply(res: PatchResult) {
    if (res.changed && res.doc !== getDoc()) setDoc(res.doc);
  }

  const tables = root.querySelectorAll<HTMLTableElement>('table');
  tables.forEach((table, tableIdx) => {
    if (table.dataset.wired === '1') return;
    table.dataset.wired = '1';
    table.dataset.tableIdx = String(tableIdx);

    const wrap = document.createElement('div');
    wrap.className = 'preview-table-wrap';
    wrap.contentEditable = 'false';
    const parent = table.parentElement;
    if (parent) {
      parent.insertBefore(wrap, table);
      wrap.appendChild(table);
    }

    const allRows = Array.from(table.querySelectorAll<HTMLTableRowElement>('tr'));
    const cells: HTMLTableCellElement[] = [];
    allRows.forEach((tr, rIdx) => {
      Array.from(tr.querySelectorAll<HTMLTableCellElement>('th,td')).forEach((cell, cIdx) => {
        cell.contentEditable = 'true';
        cell.spellcheck = false;
        cell.dataset.row = String(rIdx);
        cell.dataset.col = String(cIdx);
        cells.push(cell);

        const stop = (e: Event) => e.stopPropagation();
        cell.addEventListener('input', stop);
        cell.addEventListener('paste', stop);
        cell.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            cell.blur();
          } else if (e.key === 'Escape') {
            cell.blur();
          }
        });
        cell.addEventListener('blur', () => {
          // AC4: persist inline formatting (bold/italic/code), not just text.
          apply(replaceCell(getDoc(), tableIdx, rIdx, cIdx, cellHtmlToInlineMarkdown(cell)));
        });
      });
    });

    let lastFocused = { r: 0, c: 0 };
    const clearHighlight = () => {
      for (const c of cells) c.classList.remove('tb-selected', 'tb-row-selected', 'tb-col-selected');
    };
    const selectCell = (td: HTMLTableCellElement) => {
      const r = Number(td.dataset.row);
      const c = Number(td.dataset.col);
      lastFocused = { r, c };
      clearHighlight();
      td.classList.add('tb-selected');
      for (const cell of cells) {
        if (Number(cell.dataset.row) === r) cell.classList.add('tb-row-selected');
        if (Number(cell.dataset.col) === c) cell.classList.add('tb-col-selected');
      }
    };
    wrap.addEventListener('focusin', (e) => {
      const td = (e.target as HTMLElement).closest('th,td') as HTMLTableCellElement | null;
      if (td) selectCell(td);
    });

    // Right-click → Excel-style context menu acting on the clicked cell.
    wrap.addEventListener('contextmenu', (e) => {
      const td = (e.target as HTMLElement).closest('th,td') as HTMLTableCellElement | null;
      if (!td) return;
      e.preventDefault();
      selectCell(td);
      openCellMenu(e.clientX, e.clientY, tableIdx, lastFocused.r, lastFocused.c, getDoc, apply);
    });
  });
}

function openCellMenu(
  x: number,
  y: number,
  tableIdx: number,
  r: number,
  c: number,
  getDoc: GetDoc,
  apply: (res: PatchResult) => void,
) {
  closeCellMenu();
  const menu = document.createElement('div');
  menu.className = 'table-ctx-menu';
  menu.contentEditable = 'false';
  const item = (act: string, label: string, danger = false) =>
    `<button type="button" data-act="${act}"${danger ? ' class="danger"' : ''}>${label}</button>`;
  menu.innerHTML =
    item('row-above', t('table.rowAbove')) +
    item('row-below', t('table.rowBelow')) +
    item('col-left', t('table.colLeft')) +
    item('col-right', t('table.colRight')) +
    `<div class="table-ctx-sep"></div>` +
    item('row-del', t('table.delRow'), true) +
    item('col-del', t('table.delCol'), true);
  document.body.appendChild(menu);
  openMenuEl = menu;

  // Position within the viewport.
  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;

  menu.addEventListener('mousedown', (e) => e.preventDefault());
  menu.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button[data-act]') as HTMLButtonElement | null;
    if (!btn) return;
    const act = btn.dataset.act!;
    const doc = getDoc();
    closeCellMenu();
    switch (act) {
      case 'row-above':
        return apply(insertRow(doc, tableIdx, r, 'above'));
      case 'row-below':
        return apply(insertRow(doc, tableIdx, r, 'below'));
      case 'col-left':
        return apply(insertColumn(doc, tableIdx, c, 'left'));
      case 'col-right':
        return apply(insertColumn(doc, tableIdx, c, 'right'));
      case 'row-del':
        if (rowHasData(doc, tableIdx, r) && !confirm(t('table.confirmDeleteRow'))) return;
        return apply(deleteRow(doc, tableIdx, r));
      case 'col-del':
        if (columnHasData(doc, tableIdx, c) && !confirm(t('table.confirmDeleteCol'))) return;
        return apply(deleteColumn(doc, tableIdx, c));
    }
  });

  const onAway = (e: Event) => {
    if (openMenuEl && !openMenuEl.contains(e.target as Node)) closeCellMenu();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeCellMenu();
  };
  setTimeout(() => {
    document.addEventListener('mousedown', onAway, { once: true });
    document.addEventListener('keydown', onKey, { once: true });
    window.addEventListener('scroll', closeCellMenu, { once: true, capture: true });
  }, 0);
}
