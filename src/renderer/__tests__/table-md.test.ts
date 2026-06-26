import { describe, expect, it } from 'vitest';

import {
  buildMarkdownTable,
  columnHasData,
  deleteColumn,
  deleteRow,
  escapeCellValue,
  insertColumn,
  insertRow,
  joinTableRow,
  parseTables,
  replaceCell,
  resolveTableCellAtLine,
  rowHasData,
  splitTableRow,
} from '../table-md';

const TABLE = ['| a | b |', '| --- | --- |', '| 1 | 2 |', '| 3 | 4 |'].join('\n');

describe('splitTableRow / joinTableRow', () => {
  it('splits a simple row into trimmed cells', () => {
    expect(splitTableRow('| a | b |').cells).toEqual(['a', 'b']);
  });
  it('preserves escaped pipes inside a cell (no over-split)', () => {
    const parts = splitTableRow('| a \\| b | c |');
    expect(parts.cells).toEqual(['a \\| b', 'c']);
  });
  it('round-trips lead/trail whitespace', () => {
    const parts = splitTableRow('  | x | y |  ');
    expect(joinTableRow(parts.lead, parts.cells, parts.trail)).toBe('  | x | y |  ');
  });
});

describe('escapeCellValue', () => {
  it('escapes raw pipes and collapses newlines', () => {
    expect(escapeCellValue('a|b\nc')).toBe('a\\|b c');
  });
  it('does not double-escape already-escaped pipes', () => {
    expect(escapeCellValue('a\\|b')).toBe('a\\|b');
  });
});

describe('parseTables', () => {
  it('parses a single table with correct line indices and column count', () => {
    const [t] = parseTables(TABLE);
    expect(t.headerLine).toBe(0);
    expect(t.separatorLine).toBe(1);
    expect(t.rowLines).toEqual([0, 2, 3]);
    expect(t.colCount).toBe(2);
  });
  it('parses two duplicate-content tables independently', () => {
    const doc = [TABLE, '', TABLE].join('\n');
    const tables = parseTables(doc);
    expect(tables).toHaveLength(2);
    expect(tables[1].headerLine).toBeGreaterThan(tables[0].rowLines[tables[0].rowLines.length - 1]);
  });
  it('ignores non-table text', () => {
    expect(parseTables('just a paragraph\nwith | a pipe')).toHaveLength(0);
  });
});

describe('buildMarkdownTable', () => {
  it('builds localized headers and an aligned separator', () => {
    const en = buildMarkdownTable(2, 3, 'en');
    expect(en.split('\n')[0]).toBe('| col1 | col2 | col3 |');
    expect(en.split('\n')[1]).toBe('| --- | --- | --- |');
    expect(buildMarkdownTable(2, 2, 'ko').split('\n')[0]).toBe('| 열1 | 열2 |');
  });
  it('parses back to a valid table (single builder round-trip)', () => {
    const built = buildMarkdownTable(3, 2, 'en');
    const [t] = parseTables(built);
    expect(t.colCount).toBe(2);
    expect(t.rowLines).toHaveLength(3); // header + 2 body
  });
});

describe('replaceCell', () => {
  it('replaces a body cell and escapes the value', () => {
    const { doc, changed } = replaceCell(TABLE, 0, 1, 0, 'x|y');
    expect(changed).toBe(true);
    expect(doc.split('\n')[2]).toBe('| x\\|y | 2 |');
  });
  it('is a no-op when the value is unchanged', () => {
    expect(replaceCell(TABLE, 0, 1, 0, '1').changed).toBe(false);
  });
  it('keeps the table count stable after a replace', () => {
    const { doc } = replaceCell(TABLE, 0, 0, 1, 'B');
    expect(parseTables(doc)).toHaveLength(1);
  });
});

describe('insertRow (cell-relative)', () => {
  it('inserts a blank row below a body row', () => {
    const { doc } = insertRow(TABLE, 0, 1, 'below');
    const lines = doc.split('\n');
    expect(lines[3]).toBe('|    |    |'); // new blank row after row 1
    expect(parseTables(doc)[0].rowLines).toHaveLength(4);
  });
  it('inserts a blank row above a body row', () => {
    const { doc } = insertRow(TABLE, 0, 2, 'above');
    const lines = doc.split('\n');
    expect(lines[3]).toBe('|    |    |');
  });
  it('never splits the header/separator: a row around the header becomes the first body row', () => {
    const { doc } = insertRow(TABLE, 0, 0, 'above');
    const lines = doc.split('\n');
    expect(lines[1]).toBe('| --- | --- |'); // separator still directly under header
    expect(lines[2]).toBe('|    |    |'); // new row is first body row
  });
});

describe('insertColumn (cell-relative)', () => {
  it('inserts a column to the right and preserves separator alignment', () => {
    const { doc } = insertColumn(TABLE, 0, 0, 'right');
    const lines = doc.split('\n');
    expect(splitTableRow(lines[0]).cells).toEqual(['a', '', 'b']);
    expect(splitTableRow(lines[1]).cells).toEqual(['---', '---', '---']);
  });
  it('inserts a column to the left of the addressed column', () => {
    const { doc } = insertColumn(TABLE, 0, 1, 'left');
    expect(splitTableRow(doc.split('\n')[0]).cells).toEqual(['a', '', 'b']);
  });
});

describe('deleteRow / deleteColumn (guarded)', () => {
  it('deletes a body row', () => {
    const { doc, changed } = deleteRow(TABLE, 0, 1);
    expect(changed).toBe(true);
    expect(parseTables(doc)[0].rowLines).toHaveLength(2);
  });
  it('refuses to delete the header row', () => {
    expect(deleteRow(TABLE, 0, 0).changed).toBe(false);
  });
  it('refuses to delete the last remaining body row', () => {
    const oneBody = ['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n');
    expect(deleteRow(oneBody, 0, 1).changed).toBe(false);
  });
  it('deletes a column and updates the separator', () => {
    const { doc } = deleteColumn(TABLE, 0, 0);
    expect(splitTableRow(doc.split('\n')[0]).cells).toEqual(['b']);
    expect(splitTableRow(doc.split('\n')[1]).cells).toEqual(['---']);
  });
  it('refuses to delete the last remaining column', () => {
    const oneCol = ['| a |', '| --- |', '| 1 |'].join('\n');
    expect(deleteColumn(oneCol, 0, 0).changed).toBe(false);
  });
});

describe('rowHasData / columnHasData (delete guards)', () => {
  it('detects data-bearing rows and columns', () => {
    expect(rowHasData(TABLE, 0, 1)).toBe(true); // | 1 | 2 |
    expect(columnHasData(TABLE, 0, 0)).toBe(true); // a / 1 / 3
  });
  it('reports an empty inserted row/column as having no data', () => {
    const withBlankRow = insertRow(TABLE, 0, 1, 'below').doc;
    expect(rowHasData(withBlankRow, 0, 2)).toBe(false);
    const withBlankCol = insertColumn(TABLE, 0, 0, 'right').doc;
    expect(columnHasData(withBlankCol, 0, 1)).toBe(false);
  });
});

describe('round-trip safety', () => {
  it('preserves escaped pipes and alignment through a parse + cell edit', () => {
    const doc = ['| h\\|1 | h2 |', '| :--- | ---: |', '| a | b |'].join('\n');
    const { doc: next } = replaceCell(doc, 0, 1, 1, 'B');
    const lines = next.split('\n');
    expect(lines[0]).toBe('| h\\|1 | h2 |'); // header escaped pipe intact
    expect(lines[1]).toBe('| :--- | ---: |'); // alignment markers intact
    expect(lines[2]).toBe('| a | B |');
  });
});

describe('resolveTableCellAtLine (G006 source-range)', () => {
  // lines: 0 intro · 1 blank · 2 header · 3 separator · 4 body1 · 5 body2
  const doc = ['intro', '', '| h1 | h2 |', '| --- | --- |', '| a | b |', '| c | d |'].join('\n');

  it('maps the header source line to (tableIdx 0, rowIdx 0)', () => {
    expect(resolveTableCellAtLine(doc, 2)).toEqual({ tableIdx: 0, rowIdx: 0 });
  });
  it('maps body source lines to their rowIdx (separator excluded)', () => {
    expect(resolveTableCellAtLine(doc, 4)).toEqual({ tableIdx: 0, rowIdx: 1 });
    expect(resolveTableCellAtLine(doc, 5)).toEqual({ tableIdx: 0, rowIdx: 2 });
  });
  it('returns null for the separator and non-table lines', () => {
    expect(resolveTableCellAtLine(doc, 3)).toBeNull();
    expect(resolveTableCellAtLine(doc, 0)).toBeNull();
    expect(resolveTableCellAtLine(doc, 99)).toBeNull();
  });
  it('addresses the correct table when several tables exist', () => {
    const two = ['| a | b |', '| - | - |', '| 1 | 2 |', '', '| c | d |', '| - | - |', '| 3 | 4 |'].join('\n');
    expect(resolveTableCellAtLine(two, 0)).toEqual({ tableIdx: 0, rowIdx: 0 });
    expect(resolveTableCellAtLine(two, 6)).toEqual({ tableIdx: 1, rowIdx: 1 });
  });
});
