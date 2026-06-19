/**
 * Pure Markdown table helpers — the single source of truth for table editing.
 *
 * MD is authoritative: the preview computes patches against the Markdown source
 * through these functions. No I/O, no DOM — fully unit testable. The escaped-pipe
 * scanner makes round-trips safe for `\|`, alignment rows, and duplicate tables.
 *
 * Row index convention (matches rendered rows):
 *   - rowIdx 0      = header row
 *   - rowIdx 1..n   = body rows (the separator line is never addressed directly)
 */

export type RowParts = { lead: string; cells: string[]; trail: string };

export type ParsedTable = {
  /** 0-based line index of the header row. */
  headerLine: number;
  /** 0-based line index of the alignment/separator row. */
  separatorLine: number;
  /** Line indices of addressable rows: [header, ...body], separator excluded. */
  rowLines: number[];
  /** Column count from the header row. */
  colCount: number;
};

const ROW_RE = /^\s*\|.*\|\s*$/;
const SEP_RE = /^\s*\|?[\s:|-]+\|?\s*$/;

/** Split a pipe-table row into lead whitespace, trimmed cells, trail whitespace. */
export function splitTableRow(line: string): RowParts {
  const lead = (line.match(/^(\s*)/)?.[1]) ?? '';
  let body = line.slice(lead.length);
  const trail = (body.match(/(\s*)$/)?.[1]) ?? '';
  body = body.slice(0, body.length - trail.length);
  if (body.startsWith('|')) body = body.slice(1);
  // Strip a single trailing pipe, but never an escaped one ("\\|").
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);

  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\' && body[i + 1] === '|') {
      cur += '\\|';
      i++;
      continue;
    }
    if (ch === '|') {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return { lead, cells: cells.map((c) => c.trim()), trail };
}

/** Re-join cells into a canonical pipe-table row. */
export function joinTableRow(lead: string, cells: string[], trail: string): string {
  return `${lead}| ${cells.join(' | ')} |${trail}`;
}

/** Escape a raw cell value for safe storage in a pipe-table row. */
export function escapeCellValue(value: string): string {
  return value
    .replace(/\r?\n+/g, ' ')
    .replace(/\\?\|/g, (m) => (m === '\\|' ? m : '\\|'))
    .trim();
}

/** Find every pipe-table block in the document. */
export function parseTables(doc: string): ParsedTable[] {
  const lines = doc.split('\n');
  const tables: ParsedTable[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (!ROW_RE.test(lines[i])) continue;
    const sep = lines[i + 1];
    if (!SEP_RE.test(sep) || !sep.includes('-')) continue;
    const rowLines = [i];
    let j = i + 2;
    while (j < lines.length && ROW_RE.test(lines[j])) {
      rowLines.push(j);
      j++;
    }
    tables.push({
      headerLine: i,
      separatorLine: i + 1,
      rowLines,
      colCount: splitTableRow(lines[i]).cells.length,
    });
    i = j - 1;
  }
  return tables;
}

/** Build a fresh empty Markdown table with localized header labels. */
export function buildMarkdownTable(rows: number, cols: number, locale: 'ko' | 'en'): string {
  const safeCols = Math.max(1, cols);
  const safeRows = Math.max(1, rows);
  const colLabel = locale === 'ko' ? '열' : 'col';
  const header = '| ' + Array.from({ length: safeCols }, (_, i) => `${colLabel}${i + 1}`).join(' | ') + ' |';
  const divider = '| ' + Array.from({ length: safeCols }, () => '---').join(' | ') + ' |';
  const bodyRows = Math.max(0, safeRows - 1);
  const body = Array.from({ length: bodyRows }, () =>
    '| ' + Array.from({ length: safeCols }, () => '  ').join(' | ') + ' |',
  ).join('\n');
  return [header, divider, body].filter(Boolean).join('\n');
}

type PatchResult = { doc: string; changed: boolean };

function withTable(
  doc: string,
  tableIdx: number,
  fn: (lines: string[], table: ParsedTable) => boolean,
): PatchResult {
  const lines = doc.split('\n');
  const table = parseTables(doc)[tableIdx];
  if (!table) return { doc, changed: false };
  const changed = fn(lines, table);
  return changed ? { doc: lines.join('\n'), changed: true } : { doc, changed: false };
}

/** Replace one cell's value (escaping the new value). */
export function replaceCell(
  doc: string,
  tableIdx: number,
  rowIdx: number,
  colIdx: number,
  value: string,
): PatchResult {
  return withTable(doc, tableIdx, (lines, table) => {
    const lineIdx = table.rowLines[rowIdx];
    if (lineIdx == null) return false;
    const parts = splitTableRow(lines[lineIdx]);
    while (parts.cells.length <= colIdx) parts.cells.push('');
    const next = escapeCellValue(value);
    if (parts.cells[colIdx] === next) return false;
    parts.cells[colIdx] = next;
    lines[lineIdx] = joinTableRow(parts.lead, parts.cells, parts.trail);
    return true;
  });
}

/** Insert a blank row above/below the addressed row (header rows stay first). */
export function insertRow(
  doc: string,
  tableIdx: number,
  rowIdx: number,
  where: 'above' | 'below',
): PatchResult {
  return withTable(doc, tableIdx, (lines, table) => {
    const blank = joinTableRow('', Array.from({ length: table.colCount }, () => '  '), '');
    let insertAt: number;
    if (rowIdx === 0) {
      // Never split header/separator: a row "around" the header becomes the first body row.
      insertAt = table.separatorLine + 1;
    } else {
      const lineIdx = table.rowLines[rowIdx];
      if (lineIdx == null) return false;
      insertAt = where === 'above' ? lineIdx : lineIdx + 1;
    }
    lines.splice(insertAt, 0, blank);
    return true;
  });
}

/** Insert a blank column to the left/right of the addressed column. */
export function insertColumn(
  doc: string,
  tableIdx: number,
  colIdx: number,
  where: 'left' | 'right',
): PatchResult {
  return withTable(doc, tableIdx, (lines, table) => {
    const at = where === 'left' ? colIdx : colIdx + 1;
    for (const li of table.rowLines) {
      const parts = splitTableRow(lines[li]);
      const clamped = Math.min(Math.max(0, at), parts.cells.length);
      parts.cells.splice(clamped, 0, '');
      lines[li] = joinTableRow(parts.lead, parts.cells, parts.trail);
    }
    const sep = splitTableRow(lines[table.separatorLine]);
    const clampedSep = Math.min(Math.max(0, at), sep.cells.length);
    sep.cells.splice(clampedSep, 0, '---');
    lines[table.separatorLine] = joinTableRow(sep.lead, sep.cells, sep.trail);
    return true;
  });
}

/** Delete a body row. Refuses to delete the header or the last body row. */
export function deleteRow(doc: string, tableIdx: number, rowIdx: number): PatchResult {
  return withTable(doc, tableIdx, (lines, table) => {
    if (rowIdx === 0) return false; // never delete the header
    if (table.rowLines.length <= 2) return false; // keep at least one body row
    const lineIdx = table.rowLines[rowIdx];
    if (lineIdx == null) return false;
    lines.splice(lineIdx, 1);
    return true;
  });
}

/** Delete a column. Refuses to delete the last remaining column. */
export function deleteColumn(doc: string, tableIdx: number, colIdx: number): PatchResult {
  return withTable(doc, tableIdx, (lines, table) => {
    if (table.colCount <= 1) return false;
    for (const li of table.rowLines) {
      const parts = splitTableRow(lines[li]);
      if (colIdx < parts.cells.length) {
        parts.cells.splice(colIdx, 1);
        lines[li] = joinTableRow(parts.lead, parts.cells, parts.trail);
      }
    }
    const sep = splitTableRow(lines[table.separatorLine]);
    if (colIdx < sep.cells.length) {
      sep.cells.splice(colIdx, 1);
      lines[table.separatorLine] = joinTableRow(sep.lead, sep.cells, sep.trail);
    }
    return true;
  });
}

/** True when the addressed body/header row has any non-empty cell. */
export function rowHasData(doc: string, tableIdx: number, rowIdx: number): boolean {
  const table = parseTables(doc)[tableIdx];
  if (!table) return false;
  const lineIdx = table.rowLines[rowIdx];
  if (lineIdx == null) return false;
  return splitTableRow(doc.split('\n')[lineIdx]).cells.some((c) => c.trim().length > 0);
}

/** True when the addressed column has any non-empty cell across header+body. */
export function columnHasData(doc: string, tableIdx: number, colIdx: number): boolean {
  const table = parseTables(doc)[tableIdx];
  if (!table) return false;
  const lines = doc.split('\n');
  return table.rowLines.some((li) => {
    const cell = splitTableRow(lines[li]).cells[colIdx];
    return !!cell && cell.trim().length > 0;
  });
}
