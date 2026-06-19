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
 * Turndown isolation (HARD requirement)
 * -------------------------------------
 * The preview root is globally contenteditable, which means a naive table edit
 * can race the global Turndown sync and corrupt the document. We hard-isolate:
 *   - the table WRAPPER is `contenteditable="false"` (a non-editable island),
 *   - only individual CELLS are `contenteditable="true"`,
 *   - cell input/keydown/paste events `stopPropagation()` so the global preview
 *     input handler never serializes table edits.
 * All structural mutations go through `table-md` patch functions, so they are
 * pure, alignment-safe, and unit tested.
 */

type GetDoc = () => string;
type SetDoc = (newDoc: string) => void;

type PatchResult = { doc: string; changed: boolean };

export function wirePreviewTables(root: HTMLElement, getDoc: GetDoc, setDoc: SetDoc) {
  const tables = root.querySelectorAll<HTMLTableElement>('table');
  tables.forEach((table, tableIdx) => {
    if (table.dataset.wired === '1') return;
    table.dataset.wired = '1';
    table.dataset.tableIdx = String(tableIdx);

    // Wrap the table in a non-editable island to isolate it from the global
    // contenteditable preview + its Turndown sync.
    const wrap = document.createElement('div');
    wrap.className = 'preview-table-wrap';
    wrap.contentEditable = 'false';
    const parent = table.parentElement;
    if (parent) {
      parent.insertBefore(wrap, table);
      wrap.appendChild(table);
    }

    // Rows in document order (header tr first, then body trs). Using
    // querySelectorAll (rather than tHead.rows/tBodies) is robust to tables
    // with or without explicit thead/tbody sections.
    const allRows = Array.from(table.querySelectorAll<HTMLTableRowElement>('tr'));

    const cells: HTMLTableCellElement[] = [];
    allRows.forEach((tr, rIdx) => {
      Array.from(tr.querySelectorAll<HTMLTableCellElement>('th,td')).forEach((cell, cIdx) => {
        cell.contentEditable = 'true';
        cell.spellcheck = false;
        cell.dataset.row = String(rIdx);
        cell.dataset.col = String(cIdx);
        cells.push(cell);

        // Keep table edits out of the global preview Turndown sync.
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
          apply(replaceCell(getDoc(), tableIdx, rIdx, cIdx, cell.innerText));
        });
      });
    });

    let lastFocused = { r: 0, c: 0 };
    const clearHighlight = () => {
      for (const c of cells) c.classList.remove('tb-selected', 'tb-row-selected', 'tb-col-selected');
    };
    wrap.addEventListener('focusin', (e) => {
      const td = (e.target as HTMLElement).closest('th,td') as HTMLTableCellElement | null;
      if (!td) return;
      const r = Number(td.dataset.row);
      const c = Number(td.dataset.col);
      lastFocused = { r, c };
      clearHighlight();
      td.classList.add('tb-selected');
      for (const cell of cells) {
        if (Number(cell.dataset.row) === r) cell.classList.add('tb-row-selected');
        if (Number(cell.dataset.col) === c) cell.classList.add('tb-col-selected');
      }
    });

    const toolbar = document.createElement('div');
    toolbar.className = 'table-toolbar';
    toolbar.contentEditable = 'false';
    toolbar.innerHTML = `
      <button type="button" data-act="row-above" data-tooltip="${t('table.rowAboveTitle')}">${t('table.rowAbove')}</button>
      <button type="button" data-act="row-below" data-tooltip="${t('table.rowBelowTitle')}">${t('table.rowBelow')}</button>
      <button type="button" data-act="col-left" data-tooltip="${t('table.colLeftTitle')}">${t('table.colLeft')}</button>
      <button type="button" data-act="col-right" data-tooltip="${t('table.colRightTitle')}">${t('table.colRight')}</button>
      <button type="button" data-act="row-del" data-tooltip="${t('table.delRowTitle')}">${t('table.delRow')}</button>
      <button type="button" data-act="col-del" data-tooltip="${t('table.delColTitle')}">${t('table.delCol')}</button>
    `;
    wrap.appendChild(toolbar);

    function apply(res: PatchResult) {
      if (res.changed && res.doc !== getDoc()) setDoc(res.doc);
    }

    toolbar.addEventListener('mousedown', (e) => e.preventDefault()); // keep cell focus
    toolbar.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button[data-act]') as HTMLButtonElement | null;
      if (!btn) return;
      const act = btn.dataset.act!;
      const { r, c } = lastFocused;
      const doc = getDoc();
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
  });
}
