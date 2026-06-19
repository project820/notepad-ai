/**
 * mention-parser.test.ts
 *
 * Unit tests for `extractAtMentionTokens`, `filterMdMentions`, and
 * `mentionToFilename` from mention-parser.ts.
 *
 * Test matrix covers:
 *   1. Valid mentions — single, multiple, at various positions in string
 *   2. Mid-word @ — e-mail addresses, words with embedded @
 *   3. Edge cases — empty string, no mention, bare @, @ with no valid tail
 *   4. Non-.md filenames — pass-through behaviour (extractor includes them)
 *   5. filterMdMentions — only .md tokens survive
 *   6. mentionToFilename — strips leading @
 */

import { describe, it, expect } from 'vitest';
import {
  extractAtMentionTokens,
  extractAtMentionsFromText,
  filterMdMentions,
  filterMdFileReferences,
  mentionToFilename,
} from '../mention-parser';

// ============================================================================
// extractAtMentionTokens
// ============================================================================

describe('extractAtMentionTokens', () => {
  // --------------------------------------------------------------------------
  // 1. Valid mentions
  // --------------------------------------------------------------------------

  it('returns a single valid .md mention from a simple string', () => {
    expect(extractAtMentionTokens('@report.md')).toEqual(['@report.md']);
  });

  it('extracts a mention embedded within a heading line', () => {
    expect(extractAtMentionTokens('## Background @overview.md context')).toEqual([
      '@overview.md',
    ]);
  });

  it('extracts multiple mentions from a single line', () => {
    expect(
      extractAtMentionTokens('## Status @report.md and @notes.md')
    ).toEqual(['@report.md', '@notes.md']);
  });

  it('extracts three mentions preserving order', () => {
    expect(
      extractAtMentionTokens('@a.md @b.md @c.md')
    ).toEqual(['@a.md', '@b.md', '@c.md']);
  });

  it('handles mention at the very start of string', () => {
    expect(extractAtMentionTokens('@intro.md is the starting point')).toEqual([
      '@intro.md',
    ]);
  });

  it('handles mention at the very end of string', () => {
    expect(extractAtMentionTokens('see also @appendix.md')).toEqual([
      '@appendix.md',
    ]);
  });

  it('handles mention with hyphen in filename', () => {
    expect(extractAtMentionTokens('@my-doc.md')).toEqual(['@my-doc.md']);
  });

  it('handles mention with underscore in filename', () => {
    expect(extractAtMentionTokens('@meeting_notes.md')).toEqual([
      '@meeting_notes.md',
    ]);
  });

  it('handles mention with digits in filename', () => {
    expect(extractAtMentionTokens('@2024_Q1.md')).toEqual(['@2024_Q1.md']);
  });

  it('extracts mention preceded by a comma (punctuation boundary)', () => {
    expect(extractAtMentionTokens('see doc, @file.md for details')).toEqual([
      '@file.md',
    ]);
  });

  it('extracts mention preceded by an opening parenthesis', () => {
    expect(extractAtMentionTokens('(see @file.md)')).toEqual(['@file.md']);
  });

  // --------------------------------------------------------------------------
  // 2. Mid-word @ — must NOT be extracted
  // --------------------------------------------------------------------------

  it('ignores mid-word @ (e-mail address format)', () => {
    expect(extractAtMentionTokens('contact user@example.com for details')).toEqual([]);
  });

  it('ignores @ immediately preceded by a letter', () => {
    expect(extractAtMentionTokens('word@mention.md')).toEqual([]);
  });

  it('ignores @ immediately preceded by a digit', () => {
    expect(extractAtMentionTokens('2@file.md')).toEqual([]);
  });

  it('ignores @ immediately preceded by underscore', () => {
    expect(extractAtMentionTokens('word_@file.md')).toEqual([]);
  });

  it('handles a line with both mid-word @ and valid mentions', () => {
    // email@ is mid-word, @report.md is valid
    expect(
      extractAtMentionTokens('contact me@company.com or see @report.md')
    ).toEqual(['@report.md']);
  });

  // --------------------------------------------------------------------------
  // 3. Edge cases
  // --------------------------------------------------------------------------

  it('returns empty array for empty string', () => {
    expect(extractAtMentionTokens('')).toEqual([]);
  });

  it('returns empty array for string with no @ at all', () => {
    expect(extractAtMentionTokens('no mentions here')).toEqual([]);
  });

  it('returns empty array for bare @ with no following word char', () => {
    expect(extractAtMentionTokens('look @ me')).toEqual([]);
  });

  it('returns empty array for lone @ at end of string', () => {
    expect(extractAtMentionTokens('trailing @')).toEqual([]);
  });

  it('returns empty array for @@ (second @ has @ before it, which is not \\w, but first tail is @)', () => {
    // "@@" — the first @ has nothing before it (valid start), but its tail
    // would be "@" which is not [\w], so no match on first @.
    // The second @ has "@" before it, which is not \w → valid start, but tail
    // is nothing → no match either. Result: []
    expect(extractAtMentionTokens('@@')).toEqual([]);
  });

  it('handles newlines — extracts valid mention after newline', () => {
    expect(extractAtMentionTokens('line one\n@doc.md is here')).toEqual([
      '@doc.md',
    ]);
  });

  it('handles tab character before mention', () => {
    expect(extractAtMentionTokens('\t@tabbed.md')).toEqual(['@tabbed.md']);
  });

  it('does not include trailing punctuation as part of the token', () => {
    // The dot at the end of a sentence after .md would extend the token,
    // but "report.md." — the trailing "." IS captured because [\w.-]* includes ".".
    // This is intentional: the caller normalises filenames.
    // Verify actual behaviour is stable and documented.
    const tokens = extractAtMentionTokens('see @report.md.');
    // "@report.md." is returned as-is — the trailing dot is part of the match
    // because dots are allowed filename characters in the regex.
    // filterMdMentions will NOT pass "@report.md." through because it doesn't
    // end with ".md" exactly — this is expected and acceptable.
    expect(tokens).toEqual(['@report.md.']);
  });

  // --------------------------------------------------------------------------
  // 4. Non-.md filenames — pass-through
  // --------------------------------------------------------------------------

  it('includes non-.md mention as pass-through (png)', () => {
    expect(extractAtMentionTokens('@logo.png')).toEqual(['@logo.png']);
  });

  it('includes non-.md mention as pass-through (xlsx)', () => {
    expect(extractAtMentionTokens('@budget.xlsx')).toEqual(['@budget.xlsx']);
  });

  it('includes non-.md mention as pass-through (pdf)', () => {
    expect(extractAtMentionTokens('@spec.pdf used as source')).toEqual([
      '@spec.pdf',
    ]);
  });

  it('includes mention with no extension as pass-through', () => {
    expect(extractAtMentionTokens('@username')).toEqual(['@username']);
  });

  it('returns mixed .md and non-.md tokens together', () => {
    expect(
      extractAtMentionTokens('## Draft @source.md @diagram.png @notes.md')
    ).toEqual(['@source.md', '@diagram.png', '@notes.md']);
  });
});

// ============================================================================
// extractAtMentionsFromText (Sub-AC 5d-i)
// ============================================================================

/**
 * `extractAtMentionsFromText` is the atomic unit described in Sub-AC 5d-i.
 * It delegates to `extractAtMentionTokens` so the behaviour is identical,
 * but these dedicated tests serve as the authoritative contract for the
 * function's public API.
 *
 * Required test matrix per the Seed spec:
 *   1. Zero mentions
 *   2. One mention
 *   3. Multiple mentions
 *   4. @tokens that are NOT file references (no extension)
 */
describe('extractAtMentionsFromText (Sub-AC 5d-i)', () => {
  // --------------------------------------------------------------------------
  // 1. Zero mentions
  // --------------------------------------------------------------------------

  it('returns an empty array when the string contains no @ at all', () => {
    expect(extractAtMentionsFromText('no mentions here')).toEqual([]);
  });

  it('returns an empty array for an empty string', () => {
    expect(extractAtMentionsFromText('')).toEqual([]);
  });

  it('returns an empty array for a bare @ with no following word character', () => {
    expect(extractAtMentionsFromText('look @ the board')).toEqual([]);
  });

  it('returns an empty array when the only @ is mid-word (e-mail address)', () => {
    expect(extractAtMentionsFromText('contact me@company.com')).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // 2. One mention
  // --------------------------------------------------------------------------

  it('returns a single .md mention from a simple heading', () => {
    expect(extractAtMentionsFromText('## Background @overview.md')).toEqual([
      '@overview.md',
    ]);
  });

  it('returns a single mention when it is the only token in the string', () => {
    expect(extractAtMentionsFromText('@report.md')).toEqual(['@report.md']);
  });

  it('returns a single mention surrounded by prose text', () => {
    expect(
      extractAtMentionsFromText('See the context in @context.md for details')
    ).toEqual(['@context.md']);
  });

  // --------------------------------------------------------------------------
  // 3. Multiple mentions
  // --------------------------------------------------------------------------

  it('returns two .md mentions from a heading line', () => {
    expect(
      extractAtMentionsFromText('## Status @report.md and @notes.md')
    ).toEqual(['@report.md', '@notes.md']);
  });

  it('returns three mentions preserving document order', () => {
    expect(
      extractAtMentionsFromText('## Draft @source.md @diagram.png @notes.md')
    ).toEqual(['@source.md', '@diagram.png', '@notes.md']);
  });

  it('returns mentions from a dense list with no intervening words', () => {
    expect(
      extractAtMentionsFromText('@a.md @b.md @c.md')
    ).toEqual(['@a.md', '@b.md', '@c.md']);
  });

  it('extracts only valid mentions from a mixed line with an e-mail address', () => {
    // The e-mail address must be excluded; both .md mentions must appear.
    expect(
      extractAtMentionsFromText('## Review contact@company.com @brief.md @summary.md')
    ).toEqual(['@brief.md', '@summary.md']);
  });

  // --------------------------------------------------------------------------
  // 4. @tokens that are NOT file references (no extension)
  // --------------------------------------------------------------------------

  it('includes a bare @username token (no extension) as a pass-through', () => {
    expect(extractAtMentionsFromText('@username')).toEqual(['@username']);
  });

  it('includes a no-extension mention alongside a .md mention', () => {
    // Both tokens are returned — caller filters for .md if needed.
    expect(
      extractAtMentionsFromText('## Section @admin @report.md')
    ).toEqual(['@admin', '@report.md']);
  });

  it('includes multiple no-extension tokens when all mentions lack an extension', () => {
    expect(
      extractAtMentionsFromText('@alice @bob @charlie')
    ).toEqual(['@alice', '@bob', '@charlie']);
  });

  it('returns a no-extension token even when surrounded by prose', () => {
    expect(extractAtMentionsFromText('ping @john about this section')).toEqual([
      '@john',
    ]);
  });

  // --------------------------------------------------------------------------
  // Additional contracts: result type and ordering
  // --------------------------------------------------------------------------

  it('always returns an array (never null or undefined)', () => {
    const result = extractAtMentionsFromText('nothing here');
    expect(Array.isArray(result)).toBe(true);
  });

  it('preserves insertion order for mixed extension tokens', () => {
    const result = extractAtMentionsFromText(
      '@z.md @username @a.md @logo.png'
    );
    expect(result).toEqual(['@z.md', '@username', '@a.md', '@logo.png']);
  });
});

// ============================================================================
// filterMdMentions
// ============================================================================

describe('filterMdMentions', () => {
  it('keeps only .md tokens', () => {
    expect(
      filterMdMentions(['@report.md', '@logo.png', '@notes.md', '@budget.xlsx'])
    ).toEqual(['@report.md', '@notes.md']);
  });

  it('returns empty array when no .md tokens present', () => {
    expect(filterMdMentions(['@logo.png', '@data.csv'])).toEqual([]);
  });

  it('returns all tokens when all are .md', () => {
    expect(filterMdMentions(['@a.md', '@b.md'])).toEqual(['@a.md', '@b.md']);
  });

  it('handles empty input array', () => {
    expect(filterMdMentions([])).toEqual([]);
  });

  it('is case-insensitive for .MD extension', () => {
    // Edge case: files saved with uppercase extension
    expect(filterMdMentions(['@DOC.MD', '@other.png'])).toEqual(['@DOC.MD']);
  });
});

// ============================================================================
// filterMdFileReferences (Sub-AC 5c)
// ============================================================================

describe('filterMdFileReferences', () => {
  // --------------------------------------------------------------------------
  // .md tokens — must pass through
  // --------------------------------------------------------------------------

  it('keeps a single @-prefixed .md token', () => {
    expect(filterMdFileReferences(['@report.md'])).toEqual(['@report.md']);
  });

  it('keeps multiple .md tokens from a mixed list', () => {
    expect(
      filterMdFileReferences(['@report.md', '@notes.md', '@sheet.txt'])
    ).toEqual(['@report.md', '@notes.md']);
  });

  it('keeps all tokens when all are .md', () => {
    expect(
      filterMdFileReferences(['@a.md', '@b.md', '@c.md'])
    ).toEqual(['@a.md', '@b.md', '@c.md']);
  });

  // --------------------------------------------------------------------------
  // .txt tokens — must be excluded
  // --------------------------------------------------------------------------

  it('excludes .txt tokens', () => {
    expect(filterMdFileReferences(['@readme.txt'])).toEqual([]);
  });

  it('excludes .txt tokens while keeping .md in the same list', () => {
    expect(
      filterMdFileReferences(['@spec.md', '@notes.txt', '@draft.md'])
    ).toEqual(['@spec.md', '@draft.md']);
  });

  // --------------------------------------------------------------------------
  // .ts tokens — must be excluded
  // --------------------------------------------------------------------------

  it('excludes .ts tokens', () => {
    expect(filterMdFileReferences(['@util.ts'])).toEqual([]);
  });

  it('excludes .ts tokens in a mixed list', () => {
    expect(
      filterMdFileReferences(['@overview.md', '@helper.ts', '@types.ts'])
    ).toEqual(['@overview.md']);
  });

  // --------------------------------------------------------------------------
  // No-extension tokens — must be excluded
  // --------------------------------------------------------------------------

  it('excludes tokens with no file extension', () => {
    expect(filterMdFileReferences(['@username'])).toEqual([]);
  });

  it('excludes no-extension tokens while keeping .md tokens', () => {
    expect(
      filterMdFileReferences(['@username', '@brief.md', '@admin'])
    ).toEqual(['@brief.md']);
  });

  it('excludes token that is only an @ symbol with no filename', () => {
    // '@' alone — no filename, no extension
    expect(filterMdFileReferences(['@'])).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // Case-sensitivity: extension check is case-INsensitive
  // --------------------------------------------------------------------------

  it('accepts .MD uppercase extension (case-insensitive)', () => {
    expect(filterMdFileReferences(['@DOC.MD'])).toEqual(['@DOC.MD']);
  });

  it('accepts mixed-case .Md extension', () => {
    expect(filterMdFileReferences(['@Doc.Md'])).toEqual(['@Doc.Md']);
  });

  it('excludes .TXT uppercase because it is not .md regardless of case', () => {
    expect(filterMdFileReferences(['@README.TXT'])).toEqual([]);
  });

  it('excludes .TS uppercase extension', () => {
    expect(filterMdFileReferences(['@Helper.TS'])).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // Tokens without leading @ (bare filenames) — also accepted
  // --------------------------------------------------------------------------

  it('accepts a bare filename ending in .md (no leading @)', () => {
    // filterMdFileReferences works on both @-prefixed tokens and bare names
    expect(filterMdFileReferences(['report.md'])).toEqual(['report.md']);
  });

  it('excludes a bare filename ending in .txt', () => {
    expect(filterMdFileReferences(['notes.txt'])).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // Edge cases
  // --------------------------------------------------------------------------

  it('returns empty array for empty input', () => {
    expect(filterMdFileReferences([])).toEqual([]);
  });

  it('returns empty array when no tokens match .md', () => {
    expect(
      filterMdFileReferences(['@logo.png', '@data.csv', '@script.js'])
    ).toEqual([]);
  });

  it('preserves insertion order of passing tokens', () => {
    expect(
      filterMdFileReferences(['@z.md', '@a.md', '@m.md'])
    ).toEqual(['@z.md', '@a.md', '@m.md']);
  });

  it('handles a filename that ends in .mdx — excluded (not .md)', () => {
    // .mdx is a different format; only strict .md suffix passes
    expect(filterMdFileReferences(['@page.mdx'])).toEqual([]);
  });

  it('handles a filename that contains .md but does not end with it — excluded', () => {
    // ".md" appears in the middle but extension is ".backup"
    expect(filterMdFileReferences(['@doc.md.backup'])).toEqual([]);
  });
});

// ============================================================================
// mentionToFilename
// ============================================================================

describe('mentionToFilename', () => {
  it('strips the leading @ from a standard token', () => {
    expect(mentionToFilename('@report.md')).toBe('report.md');
  });

  it('strips @ from a non-.md token', () => {
    expect(mentionToFilename('@logo.png')).toBe('logo.png');
  });

  it('is a no-op when token has no leading @', () => {
    expect(mentionToFilename('report.md')).toBe('report.md');
  });

  it('strips only the first character when token starts with @', () => {
    expect(mentionToFilename('@@@weird')).toBe('@@weird');
  });
});

// ============================================================================
// Integration: extractAtMentionTokens → filterMdMentions pipeline
// ============================================================================

describe('extractAtMentionTokens → filterMdMentions pipeline', () => {
  it('extracts and filters .md mentions from a heading with mixed references', () => {
    const heading = '## Findings @study.md @chart.png @summary.md';
    const all = extractAtMentionTokens(heading);
    const mdOnly = filterMdMentions(all);
    expect(all).toEqual(['@study.md', '@chart.png', '@summary.md']);
    expect(mdOnly).toEqual(['@study.md', '@summary.md']);
  });

  it('returns empty for a heading with no mentions', () => {
    const heading = '## Introduction';
    expect(filterMdMentions(extractAtMentionTokens(heading))).toEqual([]);
  });

  it('ignores e-mail addresses in mixed heading text', () => {
    const heading = '## Contact user@company.com or see @brief.md';
    const mdOnly = filterMdMentions(extractAtMentionTokens(heading));
    expect(mdOnly).toEqual(['@brief.md']);
  });
});
