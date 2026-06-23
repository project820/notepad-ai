/**
 * corpus-to-model.ts — deterministic Markdown → ContentModel shim (G006 corpus).
 *
 * A small, dependency-free, AI-FREE converter so the containment runner and the
 * pipeline integration test can turn the synthetic corpus fixtures (authored
 * Markdown) into a validated `ContentModel` without invoking any model. It is
 * NOT a general Markdown engine — it understands exactly the subset the corpus
 * fixtures use, deterministically (identical input → identical model):
 *
 *   # Title              → model.title (first H1 only)
 *   ## Section           → starts a new section (its title)
 *   ^^ kicker text       → kicker for the current section
 *   ###, #### text       → heading block (level 3/4); a later #  → heading lvl 1
 *   paragraph lines      → paragraph block (blank line separates paragraphs)
 *   - / * item           → unordered list   | 1. item → ordered list
 *   > quote line         → quote block
 *   | a | b |  (+ ---)   → table (GFM; the --- row marks the header)
 *   ```lang … ```        → code block
 *   ```chart … ```       → chart block (fence body is JSON: {type,labels,series,…})
 *   ```callout:tone … ```→ callout block (tone optional, after the colon)
 *
 * Output is guaranteed to satisfy `validateContentModel` for the corpus inputs.
 */

import { CHART_TYPES, type ChartSpec, type ChartType, type ContentBlock, type ContentModel, type ContentSection } from '../../html-export-model';

/** The synthetic corpus fixtures authored for the containment gate. */
export const CORPUS_FIXTURES = [
  'short',
  'very-long',
  'table-heavy',
  'code-heavy',
  'korean',
  'mixed',
  'data-heavy',
] as const;

/** The user's REAL handover source — supplied separately, NEVER synthesized. */
export const REAL_HANDOVER_FIXTURE = 'gentz-handover.md';

type Pending =
  | { kind: 'none' }
  | { kind: 'para'; lines: string[] }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'table'; rows: string[] };

const CHART_TYPE_SET = new Set<string>(CHART_TYPES);

function isTableRow(line: string): boolean {
  return /^\|.*\|\s*$/.test(line);
}
function isTableSeparator(line: string): boolean {
  return /^\|[\s:|-]+\|\s*$/.test(line) && line.includes('-');
}
function splitRow(line: string): string[] {
  const cells = line.trim().replace(/^\|/, '').replace(/\|\s*$/, '').split('|');
  return cells.map((c) => c.trim());
}

/** Parse the body of a ```chart fence (JSON) into a safe ChartSpec; never throws. */
function parseChart(body: string): ChartSpec {
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>;
  } catch {
    /* malformed chart JSON → fall through to a minimal valid placeholder */
  }
  const type: ChartType = CHART_TYPE_SET.has(String(raw.type)) ? (raw.type as ChartType) : 'bar';
  const labels = Array.isArray(raw.labels) ? raw.labels.map((l) => String(l)) : [];
  const seriesIn = Array.isArray(raw.series) ? raw.series : [];
  const series = seriesIn
    .map((s) => {
      const so = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
      const values = Array.isArray(so.values) ? so.values.map((v) => Number(v)).filter((v) => Number.isFinite(v)) : [];
      const out: { name?: string; values: number[] } = { values };
      if (typeof so.name === 'string') out.name = so.name;
      return out;
    })
    .filter((s) => s.values.length > 0);
  const chart: ChartSpec = {
    type,
    labels: labels.length > 0 ? labels : ['—'],
    series: series.length > 0 ? series : [{ values: [0] }],
  };
  if (typeof raw.title === 'string') chart.title = raw.title;
  if (typeof raw.note === 'string') chart.note = raw.note;
  if (typeof raw.unit === 'string') chart.unit = raw.unit;
  return chart;
}

/**
 * Convert authored corpus Markdown into a validated-shaped ContentModel.
 * Deterministic and AI-free.
 */
export function corpusToModel(md: string, fallbackTitle = 'Untitled'): ContentModel {
  const text = typeof md === 'string' ? md : '';
  const lines = text.split(/\r?\n/);

  let title = '';
  const sections: ContentSection[] = [];
  let current: ContentSection | null = null;
  let pending: Pending = { kind: 'none' };

  const section = (): ContentSection => {
    if (!current) {
      current = { blocks: [] };
      sections.push(current);
    }
    return current;
  };

  const flush = (): void => {
    if (pending.kind === 'none') return;
    const sec = section();
    if (pending.kind === 'para') {
      const t = pending.lines.join(' ').trim();
      if (t) sec.blocks.push({ kind: 'paragraph', text: t });
    } else if (pending.kind === 'quote') {
      const t = pending.lines.join(' ').trim();
      if (t) sec.blocks.push({ kind: 'quote', text: t });
    } else if (pending.kind === 'list') {
      const items = pending.items.filter((i) => i.length > 0);
      if (items.length > 0) sec.blocks.push({ kind: 'list', ordered: pending.ordered, items });
    } else if (pending.kind === 'table') {
      const rowsRaw = pending.rows;
      const sepIdx = rowsRaw.findIndex(isTableSeparator);
      let headers: string[] = [];
      let bodyRows = rowsRaw;
      if (sepIdx >= 0) {
        headers = sepIdx > 0 ? splitRow(rowsRaw[sepIdx - 1]) : [];
        bodyRows = rowsRaw.filter((_, i) => i !== sepIdx && i !== sepIdx - 1);
      }
      const rows = bodyRows.map(splitRow).filter((r) => r.some((c) => c.length > 0));
      if (headers.length > 0 || rows.length > 0) sec.blocks.push({ kind: 'table', headers, rows });
    }
    pending = { kind: 'none' };
  };

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.replace(/\s+$/, '');
    const trimmed = line.trim();

    // Fenced block (code / chart / callout) — collect verbatim until the close.
    const fenceOpen = trimmed.match(/^```+\s*(.*)$/);
    if (fenceOpen) {
      flush();
      const info = fenceOpen[1].trim();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```+\s*$/.test(lines[i].trim())) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // consume the closing fence
      const sec = section();
      const bodyText = body.join('\n');
      if (/^chart\b/i.test(info)) {
        sec.blocks.push({ kind: 'chart', chart: parseChart(bodyText) });
      } else if (/^callout\b/i.test(info)) {
        const tone = info.split(':')[1]?.trim();
        const block: ContentBlock = { kind: 'callout', text: body.join(' ').trim() || bodyText };
        if (tone) (block as { tone?: string }).tone = tone;
        sec.blocks.push(block);
      } else {
        const block: ContentBlock = { kind: 'code', code: bodyText };
        if (info) (block as { language?: string }).language = info;
        sec.blocks.push(block);
      }
      continue;
    }

    if (trimmed === '') {
      flush();
      i += 1;
      continue;
    }

    // Headings.
    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flush();
      const level = heading[1].length;
      // Drop a trailing `{#anchor}` heading id (common in handover/export Markdown).
      const htext = heading[2].replace(/\s*\{#[^}]*\}\s*$/, '').trim();
      if (level === 1 && !title) {
        title = htext;
      } else if (level === 2) {
        current = { title: htext, blocks: [] };
        sections.push(current);
      } else {
        const lvl = (level <= 1 ? 1 : level >= 4 ? 4 : level) as 1 | 3 | 4;
        section().blocks.push({ kind: 'heading', level: lvl, text: htext });
      }
      i += 1;
      continue;
    }

    // Section kicker.
    if (/^\^\^\s+/.test(trimmed)) {
      flush();
      section().kicker = trimmed.replace(/^\^\^\s+/, '').trim();
      i += 1;
      continue;
    }

    // Blockquote.
    if (/^>\s?/.test(trimmed)) {
      if (pending.kind !== 'quote') {
        flush();
        pending = { kind: 'quote', lines: [] };
      }
      pending.lines.push(trimmed.replace(/^>\s?/, ''));
      i += 1;
      continue;
    }

    // Tables.
    if (isTableRow(trimmed)) {
      if (pending.kind !== 'table') {
        flush();
        pending = { kind: 'table', rows: [] };
      }
      pending.rows.push(trimmed);
      i += 1;
      continue;
    }

    // Lists.
    const ul = trimmed.match(/^[-*+]\s+(.*)$/);
    const ol = trimmed.match(/^\d+\.\s+(.*)$/);
    if (ul || ol) {
      const ordered = !!ol;
      const item = (ul ? ul[1] : (ol as RegExpMatchArray)[1]).trim();
      if (pending.kind !== 'list' || pending.ordered !== ordered) {
        flush();
        pending = { kind: 'list', ordered, items: [] };
      }
      pending.items.push(item);
      i += 1;
      continue;
    }

    // Paragraph (default).
    if (pending.kind !== 'para') {
      flush();
      pending = { kind: 'para', lines: [] };
    }
    pending.lines.push(trimmed);
    i += 1;
  }
  flush();

  // Guarantee the model is non-empty + drop sections that carry nothing.
  const usable = sections.filter((s) => (s.title && s.title.length > 0) || s.blocks.length > 0);
  if (usable.length === 0) {
    usable.push({ blocks: [{ kind: 'paragraph', text: text.trim() || 'Empty document.' }] });
  }
  return { title: title || fallbackTitle, sections: usable };
}
