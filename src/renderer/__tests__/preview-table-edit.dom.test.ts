// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { wirePreviewTables } from '../preview-table-edit';

const MD = ['| a | b |', '| --- | --- |', '| 1 | 2 |', '| 3 | 4 |'].join('\n');

function buildPreview(): { root: HTMLElement; getDoc: () => string; sets: string[] } {
  const root = document.createElement('div');
  root.innerHTML = `<table>
    <thead><tr><th>a</th><th>b</th></tr></thead>
    <tbody><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></tbody>
  </table>`;
  document.body.appendChild(root);
  let doc = MD;
  const sets: string[] = [];
  const getDoc = () => doc;
  const setDoc = (next: string) => {
    doc = next;
    sets.push(next);
  };
  wirePreviewTables(root, getDoc, setDoc);
  return { root, getDoc, sets };
}

beforeEach(() => {
  (globalThis as { confirm?: () => boolean }).confirm = () => true;
});
afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function cells(root: HTMLElement): HTMLTableCellElement[] {
  return Array.from(root.querySelectorAll<HTMLTableCellElement>('th,td'));
}
function clickAct(root: HTMLElement, act: string) {
  root.querySelector<HTMLButtonElement>(`button[data-act="${act}"]`)!.click();
}
function focusCell(cell: HTMLTableCellElement) {
  cell.dispatchEvent(new Event('focusin', { bubbles: true }));
}

describe('wirePreviewTables — DOM integration (Turndown isolation)', () => {
  it('makes the wrapper contenteditable=false and cells contenteditable=true', () => {
    const { root } = buildPreview();
    const wrap = root.querySelector<HTMLElement>('.preview-table-wrap')!;
    expect(wrap.getAttribute('contenteditable')).toBe('false');
    for (const c of cells(root)) expect(c.getAttribute('contenteditable')).toBe('true');
  });

  it('stops cell input/keydown from bubbling to the global preview listener', () => {
    const { root } = buildPreview();
    const spy = vi.fn();
    root.addEventListener('input', spy);
    root.addEventListener('keydown', spy);
    const cell = cells(root)[2]; // first body cell
    cell.dispatchEvent(new Event('input', { bubbles: true }));
    cell.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a' }));
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('wirePreviewTables — cell edit syncs to MD source', () => {
  it('patches the correct cell on blur', () => {
    const { root, getDoc } = buildPreview();
    const bodyCell = cells(root).find((c) => c.textContent === '1')!;
    bodyCell.textContent = '9';
    (bodyCell as unknown as { innerText: string }).innerText = '9';
    bodyCell.dispatchEvent(new Event('blur', { bubbles: false }));
    expect(getDoc().split('\n')[2]).toBe('| 9 | 2 |');
  });
});

describe('wirePreviewTables — cell-relative toolbar', () => {
  it('row-below inserts a blank row after the focused body row', () => {
    const { root, getDoc } = buildPreview();
    focusCell(cells(root).find((c) => c.textContent === '1')!); // row 1
    clickAct(root, 'row-below');
    const lines = getDoc().split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[3]).toBe('|    |    |');
  });

  it('col-right inserts a blank column to the right of the focused column', () => {
    const { root, getDoc } = buildPreview();
    focusCell(cells(root).find((c) => c.textContent === 'a')!); // col 0
    clickAct(root, 'col-right');
    expect(getDoc().split('\n')[0]).toBe('| a |  | b |');
    expect(getDoc().split('\n')[1]).toBe('| --- | --- | --- |');
  });

  it('row-del removes a data row after confirm', () => {
    const { root, getDoc } = buildPreview();
    focusCell(cells(root).find((c) => c.textContent === '1')!);
    clickAct(root, 'row-del');
    expect(getDoc().split('\n')).toHaveLength(3); // header + sep + 1 body
  });

  it('row-del is cancelled when confirm returns false (data-loss guard)', () => {
    (globalThis as { confirm?: () => boolean }).confirm = () => false;
    const { root, getDoc } = buildPreview();
    focusCell(cells(root).find((c) => c.textContent === '1')!);
    clickAct(root, 'row-del');
    expect(getDoc().split('\n')).toHaveLength(4); // unchanged
  });
});
