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
  it('keeps emphasis markers flush against the text (whitespace would break Markdown)', () => {
    const cell = document.createElement('td');
    cell.innerHTML = '<strong> padded </strong>';
    // Old behavior produced "** padded **" — markers padded by spaces render as
    // literal asterisks. Markers must hug the text: "**padded**".
    expect(cellHtmlToInlineMarkdown(cell)).toBe('**padded**');
    const cell2 = document.createElement('td');
    cell2.innerHTML = 'a <em> b </em> c';
    expect(cellHtmlToInlineMarkdown(cell2)).toBe('a *b* c');
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

describe('wirePreviewTables — source-range addressing (G006)', () => {
  it('edits the table the row maps to by source line, not its DOM ordinal', () => {
    // Document has TWO tables; the preview shows only the SECOND one, so its DOM
    // ordinal is 0 — which under the old ordinal scheme would wrongly patch the
    // FIRST source table. The row's data-src-start anchors the edit correctly.
    const TWO = ['| a | b |', '| - | - |', '| 1 | 2 |', '', '| c | d |', '| - | - |', '| 3 | 4 |'].join('\n');
    const root = document.createElement('div');
    root.innerHTML = `<table>
      <thead><tr><th>c</th><th>d</th></tr></thead>
      <tbody><tr><td>3</td><td>4</td></tr></tbody>
    </table>`;
    document.body.appendChild(root);
    let doc = TWO;
    const getDoc = () => doc;
    wirePreviewTables(root, getDoc, (next) => {
      doc = next;
    });
    // Tag the rows with their 1-based source lines (header line 4 → 5; body 6 → 7).
    const trs = Array.from(root.querySelectorAll('tr'));
    trs[0].setAttribute('data-src-start', '5');
    trs[1].setAttribute('data-src-start', '7');

    const headerCell = Array.from(root.querySelectorAll<HTMLTableCellElement>('th,td')).find(
      (c) => c.textContent === 'c',
    )!;
    headerCell.textContent = 'C';
    headerCell.dispatchEvent(new Event('blur', { bubbles: false }));

    const lines = getDoc().split('\n');
    expect(lines[4]).toBe('| C | d |'); // second table edited
    expect(lines[0]).toBe('| a | b |'); // first table untouched
  });
});
