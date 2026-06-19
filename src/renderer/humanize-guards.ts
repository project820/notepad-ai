/**
 * Meaning-preservation guards for the always-on humanize layer.
 *
 * Humanization must never alter facts. These pure helpers extract the spans the
 * style layer is forbidden to change (code, inline code, direct quotes, numbers,
 * proper nouns) and let callers verify an AI rewrite preserved them, plus a
 * cheap change-rate estimate to flag over-humanization before apply.
 *
 * No I/O, no DOM — fully unit tested.
 */

export type ProtectedSpans = {
  codeBlocks: string[];
  inlineCode: string[];
  quotes: string[];
  numbers: string[];
  properNouns: string[];
};

const FENCE_RE = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g;
const INLINE_CODE_RE = /`[^`\n]+`/g;
// Straight and typographic double/single quotes, ASCII + CJK.
const QUOTE_RE = /["“”„][^"“”„\n]{1,400}["“”„]|['‘’][^'‘’\n]{1,400}['‘’]/g;
// Numbers with optional separators / decimals / percent / currency.
const NUMBER_RE = /\d[\d.,]*\d%?|\d%?/g;
// Conservative proper-noun heuristic: TitleCase words (optionally multi-word),
// excluding sentence-initial single words is out of scope — we keep it simple.
const PROPER_NOUN_RE = /\b[A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+)*\b/g;

function matchAll(text: string, re: RegExp): string[] {
  return text.match(re) ?? [];
}

export function extractProtectedSpans(markdown: string): ProtectedSpans {
  const codeBlocks = matchAll(markdown, FENCE_RE);
  // Remove fenced regions before scanning inline code/quotes/numbers to avoid
  // double-counting content inside code blocks.
  const withoutFences = markdown.replace(FENCE_RE, ' ');
  return {
    codeBlocks,
    inlineCode: matchAll(withoutFences, INLINE_CODE_RE),
    quotes: matchAll(withoutFences, QUOTE_RE).map((q) => q.trim()),
    numbers: matchAll(withoutFences.replace(INLINE_CODE_RE, ' '), NUMBER_RE),
    properNouns: matchAll(withoutFences.replace(INLINE_CODE_RE, ' '), PROPER_NOUN_RE),
  };
}

function multiset(items: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) m.set(it, (m.get(it) ?? 0) + 1);
  return m;
}

/** Items present in `source` but missing (or fewer) in `output`. */
function missingItems(source: string[], output: string[]): string[] {
  const out = multiset(output);
  const missing: string[] = [];
  for (const it of source) {
    const n = out.get(it) ?? 0;
    if (n <= 0) missing.push(it);
    else out.set(it, n - 1);
  }
  return missing;
}

export type SpanComparison = {
  ok: boolean;
  missingCode: string[];
  missingInlineCode: string[];
  missingQuotes: string[];
  missingNumbers: string[];
  missingProperNouns: string[];
};

/**
 * Compare protected spans of a source vs an AI rewrite. `ok` is false when any
 * code/inline-code/quote/number span from the source is absent in the output.
 * Proper nouns are reported but not treated as a hard failure (heuristic).
 */
export function compareProtectedSpans(source: string, output: string): SpanComparison {
  const a = extractProtectedSpans(source);
  const b = extractProtectedSpans(output);
  const missingCode = missingItems(a.codeBlocks, b.codeBlocks);
  const missingInlineCode = missingItems(a.inlineCode, b.inlineCode);
  const missingQuotes = missingItems(a.quotes, b.quotes);
  const missingNumbers = missingItems(a.numbers, b.numbers);
  const missingProperNouns = missingItems(a.properNouns, b.properNouns);
  const ok =
    missingCode.length === 0 &&
    missingInlineCode.length === 0 &&
    missingQuotes.length === 0 &&
    missingNumbers.length === 0;
  return { ok, missingCode, missingInlineCode, missingQuotes, missingNumbers, missingProperNouns };
}

/**
 * Cheap word-level change rate in [0,1]. 0 = identical word multiset, 1 = no
 * shared words. Used to warn on over-humanization (e.g. > 0.5).
 */
export function changeRate(source: string, output: string): number {
  const tokenize = (s: string) => s.trim().split(/\s+/).filter(Boolean);
  const a = tokenize(source);
  const b = tokenize(output);
  if (a.length === 0 && b.length === 0) return 0;
  const bSet = multiset(b);
  let shared = 0;
  for (const w of a) {
    const n = bSet.get(w) ?? 0;
    if (n > 0) {
      shared++;
      bSet.set(w, n - 1);
    }
  }
  return 1 - (2 * shared) / (a.length + b.length);
}

export const OVER_HUMANIZE_WARN = 0.5;

/** Convenience verdict combining span preservation + change-rate warning. */
export function guardVerdict(
  source: string,
  output: string,
): { blockApply: boolean; overHumanized: boolean; comparison: SpanComparison; rate: number } {
  const comparison = compareProtectedSpans(source, output);
  const rate = changeRate(source, output);
  return {
    blockApply: !comparison.ok,
    overHumanized: rate > OVER_HUMANIZE_WARN,
    comparison,
    rate,
  };
}
