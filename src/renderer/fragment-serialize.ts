import type { ContentRunKind } from './source-journal';

// Kept byte-for-byte compatible with Turndown's markdownEscapes in
// turndown.cjs.js. Inline text is not trusted to already be markdown-safe.
const markdownEscapes: ReadonlyArray<readonly [RegExp, string]> = [
  [/\\/g, '\\\\'],
  [/\*/g, '\\*'],
  [/^-/g, '\\-'],
  [/^\+ /g, '\\+ '],
  [/^(=+)/g, '\\$1'],
  [/^(#{1,6}) /g, '\\$1 '],
  [/`/g, '\\`'],
  [/^~~~/g, '\\~~~'],
  [/\[/g, '\\['],
  [/\]/g, '\\]'],
  [/^>/g, '\\>'],
  [/_/g, '\\_'],
  [/^(\d+)\. /g, '$1\\. '],
];

function escapeMarkdownText(value: string): string {
  return markdownEscapes.reduce((escaped, [pattern, replacement]) => escaped.replace(pattern, replacement), value);
}

export type SerializeResult =
  | { kind: 'segments'; segments: readonly string[] }
  | { kind: 'verbatim'; text: string }
  | { kind: 'verbatim-segments'; segments: readonly string[] }
  | { kind: 'rerender'; reason: string };

function inline(node: Node): string | null {
  if (node.nodeType === Node.TEXT_NODE) return escapeMarkdownText(node.textContent ?? '');
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  if (tag === 'br') return '\n';
  if (tag === 'input' && (el as HTMLInputElement).type === 'checkbox') return (el as HTMLInputElement).checked ? '[x] ' : '[ ] ';
  const content = Array.from(el.childNodes).map(inline);
  if (content.some((part) => part == null)) return null;
  const text = content.join('');
  if (tag === 'strong' || tag === 'b') return `**${text}**`;
  if (tag === 'em' || tag === 'i') return `_${text}_`;
  if (tag === 'code') return `\`${text}\``;
  if (tag === 'mark') return `==${text}==`;
  if (tag === 'sup') return `^${text}^`;
  if (tag === 'a') return `[${text}](${el.getAttribute('href') ?? ''})`;
  if (['span', 'label', 'p', 'li', 'td', 'th', 'dd'].includes(tag)) return text;
  return null;
}

function expectedSlices(node: Element): number {
  const raw = Number(node.getAttribute('data-source-slice-count'));
  return Number.isInteger(raw) && raw > 0 ? raw : 1;
}

function splitBreaks(value: string): string[] { return value.split('\n'); }

/** Serializes only a run's editable inner content; source-owned wrappers stay out. */
export function serializeChangedRun(kind: ContentRunKind, node: Element): SerializeResult {
  const count = expectedSlices(node);
  const code = node.matches('pre, code') ? node.querySelector('code') ?? node : null;
  if (kind === 'fence-body' || code) {
    const text = (code ?? node).textContent ?? '';
    const prefixes = (() => {
      try { return JSON.parse(node.getAttribute('data-synthetic-indent-prefixes') ?? '[]') as string[]; }
      catch { return []; }
    })();
    const segments = splitBreaks(text).slice(0, count);
    if (prefixes.length > 0) {
      for (let i = 0; i < segments.length; i++) {
        const prefix = prefixes[i] ?? '';
        if (prefix && !segments[i].startsWith(prefix)) return { kind: 'rerender', reason: 'synthetic-indent-prefix-mutated' };
        segments[i] = segments[i].slice(prefix.length);
      }
      return segments.length === count ? { kind: 'verbatim-segments', segments } : { kind: 'rerender', reason: 'verbatim-segment-count-mismatch' };
    }
    return count === 1 ? { kind: 'verbatim', text } : { kind: 'rerender', reason: 'fence-not-contiguous' };
  }
  if (kind === 'heading' || kind === 'table-cell') {
    if (node.querySelector('br') || (node.textContent ?? '').includes('\n')) return { kind: 'rerender', reason: 'break-not-supported-for-run' };
  }
  const value = Array.from(node.childNodes).map(inline);
  if (value.some((part) => part == null)) return { kind: 'rerender', reason: 'unknown-inline-node' };
  const segments = splitBreaks(value.join(''));
  return segments.length === count ? { kind: 'segments', segments } : { kind: 'rerender', reason: 'source-slice-count-mismatch' };
}
