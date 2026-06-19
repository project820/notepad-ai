// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { wirePreviewTables, cellHtmlToInlineMarkdown } from '../preview-table-edit';

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
  document.querySelectorAll('.table-ctx-menu').forEach((m) => m.remove());
  vi.restoreAllMocks();
});

function cells(root: HTMLElement): HTMLTableCellElement[] {
  return Array.from(root.querySelectorAll<HTMLTableCellElement>('th,td'));
}
/** Right-click a cell to open the context menu, then click the given action. */
function ctxAct(cell: HTMLTableCellElement, act: string) {
  cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
  const menu = document.querySelector('.table-ctx-menu')!;
  menu.querySelector<HTMLButtonElement>(`button[data-act="${act}"]`)!.click();
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
    const cell = cells(root)[2];
    cell.dispatchEvent(new Event('input', { bubbles: true }));
    cell.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a' }));
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not render an always-visible toolbar (right-click only)', () => {
    const { root } = buildPreview();
    expect(root.querySelector('.table-toolbar')).toBeNull();
    expect(document.querySelector('.table-ctx-menu')).toBeNull();
  });
});

describe('cellHtmlToInlineMarkdown (AC4: formatting persists)', () => {
  it('converts bold/italic/code to inline markdown', () => {
    const cell = document.createElement('td');
    cell.innerHTML = 'plain <strong>bold</strong> <em>it</em> <code>x</code>';
    expect(cellHtmlToInlineMarkdown(cell)).toBe('plain **bold** *it* `x`');
  });
  it('handles <b>/<i> and span style-based formatting', () => {
    const cell = document.createElement('td');
    cell.innerHTML = '<b>B</b> <span style="font-style: italic">I</span> <span style="font-weight:700">W</span>';
    expect(cellHtmlToInlineMarkdown(cell)).toBe('**B** *I* **W**');
  });
  it('flattens to plain text when there is no formatting', () => {
    const cell = document.createElement('td');
    cell.textContent = 'just text';
    expect(cellHtmlToInlineMarkdown(cell)).toBe('just text');
  });
});

describe('wirePreviewTables — cell edit syncs to MD source (with formatting)', () => {
  it('patches the correct cell on blur', () => {
    const { root, getDoc } = buildPreview();
    const bodyCell = cells(root).find((c) => c.textContent === '1')!;
    bodyCell.textContent = '9';
    bodyCell.dispatchEvent(new Event('blur', { bubbles: false }));
    expect(getDoc().split('\n')[2]).toBe('| 9 | 2 |');
  });

  it('persists inline bold formatting into the MD cell', () => {
    const { root, getDoc } = buildPreview();
    const bodyCell = cells(root).find((c) => c.textContent === '1')!;
    bodyCell.innerHTML = '<strong>9</strong>';
    bodyCell.dispatchEvent(new Event('blur', { bubbles: false }));
    expect(getDoc().split('\n')[2]).toBe('| **9** | 2 |');
  });
});

describe('wirePreviewTables — right-click context menu', () => {
  it('row-below inserts a blank row after the right-clicked body row', () => {
    const { root, getDoc } = buildPreview();
    ctxAct(cells(root).find((c) => c.textContent === '1')!, 'row-below');
    const lines = getDoc().split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[3]).toBe('|    |    |');
  });

  it('col-right inserts a blank column to the right of the right-clicked column', () => {
    const { root, getDoc } = buildPreview();
    ctxAct(cells(root).find((c) => c.textContent === 'a')!, 'col-right');
    expect(getDoc().split('\n')[0]).toBe('| a |  | b |');
    expect(getDoc().split('\n')[1]).toBe('| --- | --- | --- |');
  });

  it('row-del removes a data row after confirm', () => {
    const { root, getDoc } = buildPreview();
    ctxAct(cells(root).find((c) => c.textContent === '1')!, 'row-del');
    expect(getDoc().split('\n')).toHaveLength(3);
  });

  it('row-del is cancelled when confirm returns false (data-loss guard)', () => {
    (globalThis as { confirm?: () => boolean }).confirm = () => false;
    const { root, getDoc } = buildPreview();
    ctxAct(cells(root).find((c) => c.textContent === '1')!, 'row-del');
    expect(getDoc().split('\n')).toHaveLength(4);
  });

  it('closes the menu after an action', () => {
    const { root } = buildPreview();
    ctxAct(cells(root).find((c) => c.textContent === '1')!, 'row-below');
    expect(document.querySelector('.table-ctx-menu')).toBeNull();
  });
});
