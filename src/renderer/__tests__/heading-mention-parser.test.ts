/**
 * heading-mention-parser.test.ts
 *
 * End-to-end tests for `parseHeadingAtMentions` — Sub-AC 5d-ii.
 *
 * These tests validate the FULL pipeline:
 *   raw Markdown → markdownToMdast → extractHeadingNodes →
 *   extractAtMentionsFromText (per heading) → filterMdFileReferences →
 *   deduplicate → string[]
 *
 * Required assertions per the Seed spec:
 *   A. @mentions appearing ONLY in body paragraphs are excluded.
 *   B. @mentions in headings that reference non-.md files are excluded.
 *   C. Valid heading-scoped .md references are returned.
 *
 * Additional test matrix:
 *   D. Empty / no-heading documents return []
 *   E. Deduplication across headings
 *   F. All heading depths h1–h6 are recognised
 *   G. Headings inside fenced code blocks are not parsed as real headings
 *   H. Mentions in list items / blockquotes in body are excluded
 *   I. Mixed valid and invalid mentions in a single heading
 *   J. Multiple headings — all contribute to the result
 *   K. Stable insertion-order of deduplicated results
 *   L. Case-insensitive .md extension
 *   M. E-mail addresses inside heading lines are not extracted
 *   N. Return type is always an array (never null/undefined)
 */

import { describe, it, expect } from 'vitest';
import { parseHeadingAtMentions } from '../heading-mention-parser';

// ============================================================================
// A. Body-only mentions are excluded
// ============================================================================

describe('parseHeadingAtMentions — A: body-only mentions excluded', () => {
  it('excludes @mention in a standalone paragraph (no headings at all)', () => {
    const md = 'See @context.md for details.';
    expect(parseHeadingAtMentions(md)).toEqual([]);
  });

  it('excludes @mention that appears only in a body paragraph after a heading', () => {
    const md = [
      '# Introduction',
      '',
      'This paragraph references @source.md but it should be ignored.',
    ].join('\n');
    expect(parseHeadingAtMentions(md)).toEqual([]);
  });

  it('excludes @mention in second body paragraph while heading has no mention', () => {
    const md = [
      '## Background',
      '',
      'First paragraph.',
      '',
      'Second paragraph references @notes.md.',
    ].join('\n');
    expect(parseHeadingAtMentions(md)).toEqual([]);
  });

  it('excludes body mention when heading contains a non-.md mention only', () => {
    const md = [
      '## Overview @diagram.png',
      '',
      'Body text cites @report.md — excluded.',
    ].join('\n');
    expect(parseHeadingAtMentions(md)).toEqual([]);
  });

  it('excludes all body mentions across multiple sections', () => {
    const md = [
      '# Title',
      'Body @a.md',
      '',
      '## Section One',
      'Body @b.md',
      '',
      '## Section Two',
      'Body @c.md',
    ].join('\n');
    expect(parseHeadingAtMentions(md)).toEqual([]);
  });

  it('returns [] when ALL mentions are in body paragraphs only', () => {
    const md = [
      'Standalone paragraph @standalone.md.',
      '',
      'Another paragraph @second.md.',
    ].join('\n');
    expect(parseHeadingAtMentions(md)).toEqual([]);
  });
});

// ============================================================================
// B. Heading mentions for non-.md files are excluded
// ============================================================================

describe('parseHeadingAtMentions — B: non-.md heading mentions excluded', () => {
  it('excludes @mention.png from a heading', () => {
    const md = '## Design @diagram.png';
    expect(parseHeadingAtMentions(md)).toEqual([]);
  });

  it('excludes @mention.xlsx from a heading', () => {
    const md = '## Data @budget.xlsx';
    expect(parseHeadingAtMentions(md)).toEqual([]);
  });

  it('excludes @mention.pdf from a heading', () => {
    const md = '### Reference @spec.pdf';
    expect(parseHeadingAtMentions(md)).toEqual([]);
  });

  it('excludes @mention.ts (TypeScript file) from a heading', () => {
    const md = '## Implementation @helper.ts';
    expect(parseHeadingAtMentions(md)).toEqual([]);
  });

  it('excludes @mention.txt from a heading', () => {
    const md = '# Notes @changelog.txt';
    expect(parseHeadingAtMentions(md)).toEqual([]);
  });

  it('excludes bare @username (no extension) from a heading', () => {
    const md = '## Section @alice';
    expect(parseHeadingAtMentions(md)).toEqual([]);
  });

  it('excludes @mention.mdx — strict .md suffix only', () => {
    // .mdx is not .md
    const md = '## Component @page.mdx';
    expect(parseHeadingAtMentions(md)).toEqual([]);
  });

  it('excludes @mention when the .md appears only in the middle of the filename', () => {
    // ".md" appears mid-name but extension is ".backup"
    const md = '## Archive @doc.md.backup';
    expect(parseHeadingAtMentions(md)).toEqual([]);
  });

  it('excludes all non-.md mentions when heading has multiple non-.md mentions', () => {
    const md = '## Mixed @diagram.png @data.xlsx @summary.pdf';
    expect(parseHeadingAtMentions(md)).toEqual([]);
  });
});

// ============================================================================
// C. Valid heading-scoped .md references are returned
// ============================================================================

describe('parseHeadingAtMentions — C: valid heading .md references returned', () => {
  it('returns a single .md mention from a simple h2 heading', () => {
    const md = '## Background @context.md';
    expect(parseHeadingAtMentions(md)).toEqual(['@context.md']);
  });

  it('returns a single .md mention from an h1 heading', () => {
    const md = '# Report @overview.md';
    expect(parseHeadingAtMentions(md)).toEqual(['@overview.md']);
  });

  it('returns two .md mentions from a single heading', () => {
    const md = '## Status @report.md @notes.md';
    expect(parseHeadingAtMentions(md)).toEqual(['@report.md', '@notes.md']);
  });

  it('returns .md mention when surrounded by non-.md mentions in the same heading', () => {
    const md = '## Summary @diagram.png @brief.md @chart.xlsx';
    expect(parseHeadingAtMentions(md)).toEqual(['@brief.md']);
  });

  it('returns .md mention from heading with mixed prose and mention', () => {
    const md = '## Background context @context.md information';
    expect(parseHeadingAtMentions(md)).toEqual(['@context.md']);
  });

  it('returns mention with hyphen in filename', () => {
    const md = '## Analysis @long-report.md';
    expect(parseHeadingAtMentions(md)).toEqual(['@long-report.md']);
  });

  it('returns mention with underscore in filename', () => {
    const md = '## Data @meeting_notes.md';
    expect(parseHeadingAtMentions(md)).toEqual(['@meeting_notes.md']);
  });

  it('returns mention with digits in filename', () => {
    const md = '## Quarterly @2024_Q1.md';
    expect(parseHeadingAtMentions(md)).toEqual(['@2024_Q1.md']);
  });

  it('returns .md mention from heading when body also has a mention (body excluded)', () => {
    const md = [
      '## Analysis @results.md',
      '',
      'Body paragraph @body-mention.md — excluded.',
    ].join('\n');
    expect(parseHeadingAtMentions(md)).toEqual(['@results.md']);
  });
});

// ============================================================================
// D. Empty / no-heading documents
// ============================================================================

describe('parseHeadingAtMentions — D: empty / no-heading documents', () => {
  it('returns [] for an empty string', () => {
    expect(parseHeadingAtMentions('')).toEqual([]);
  });

  it('returns [] for a string containing only whitespace', () => {
    expect(parseHeadingAtMentions('   \n\n   ')).toEqual([]);
  });

  it('returns [] for a document with only body paragraphs (no headings)', () => {
    const md = [
      'First paragraph.',
      '',
      'Second paragraph.',
      '',
      'Third paragraph.',
    ].join('\n');
    expect(parseHeadingAtMentions(md)).toEqual([]);
  });

  it('returns [] for a document with headings but no @mentions anywhere', () => {
    const md = [
      '# Title',
      '',
      '## Section A',
      'Body text.',
      '',
      '## Section B',
      'More text.',
    ].join('\n');
    expect(parseHeadingAtMentions(md)).toEqual([]);
  });

  it('returns [] for a document with a single empty heading', () => {
    const md = '##';
    expect(parseHeadingAtMentions(md)).toEqual([]);
  });

  it('returns [] for headings that have non-.md mentions only', () => {
    const md = [
      '# Overview @diagram.png',
      '## Details @data.xlsx',
    ].join('\n');
    expect(parseHeadingAtMentions(md)).toEqual([]);
  });
});

// ============================================================================
// E. Deduplication across headings
// ============================================================================

describe('parseHeadingAtMentions — E: deduplication across headings', () => {
  it('deduplicates same .md mention appearing in two headings', () => {
    const md = [
      '## Section A @context.md',
      '## Section B @context.md',
    ].join('\n');
    expect(parseHeadingAtMentions(md)).toEqual(['@context.md']);
  });

  it('deduplicates same .md mention appearing in three headings', () => {
    const md = [
      '# Intro @source.md',
      '## Background @source.md',
      '## Analysis @source.md',
    ].join('\n');
    expect(parseHeadingAtMentions(md)).toEqual(['@source.md']);
  });

  it('returns first occurrence in insertion order when deduplicating', () => {
    const md = [
      '## Section One @alpha.md @beta.md',
      '## Section Two @beta.md @gamma.md',
      '## Section Three @alpha.md @gamma.md',
    ].join('\n');
    // @alpha first seen in section one, @beta first seen in section one,
    // @gamma first seen in section two
    expect(parseHeadingAtMentions(md)).toEqual(['@alpha.md', '@beta.md', '@gamma.md']);
  });

  it('deduplicates within a single heading line (same mention twice)', () => {
    // @mention.md appears twice in the same heading — parser returns one entry
    // (extractAtMentionsFromText returns both but dedup collapses them)
    const md = '## Section @notes.md @notes.md';
    expect(parseHeadingAtMentions(md)).toEqual(['@notes.md']);
  });

  it('deduplication is case-sensitive — @notes.md and @Notes.md are distinct', () => {
    // Filenames on macOS APFS are case-insensitive on disk but the mention
    // token is stored as-is; callers resolve paths — dedup treats them as distinct.
    const md = [
      '## Section A @notes.md',
      '## Section B @Notes.md',
    ].join('\n');
    expect(parseHeadingAtMentions(md)).toEqual(['@notes.md', '@Notes.md']);
  });
});

// ============================================================================
// F. All heading depths h1–h6 are recognised
// ============================================================================

describe('parseHeadingAtMentions — F: all heading depths h1–h6', () => {
  it('recognises an h1 heading (# prefix)', () => {
    expect(parseHeadingAtMentions('# Title @doc.md')).toEqual(['@doc.md']);
  });

  it('recognises an h2 heading (## prefix)', () => {
    expect(parseHeadingAtMentions('## Section @doc.md')).toEqual(['@doc.md']);
  });

  it('recognises an h3 heading (### prefix)', () => {
    expect(parseHeadingAtMentions('### Subsection @doc.md')).toEqual(['@doc.md']);
  });

  it('recognises an h4 heading (#### prefix)', () => {
    expect(parseHeadingAtMentions('#### Detail @doc.md')).toEqual(['@doc.md']);
  });

  it('recognises an h5 heading (##### prefix)', () => {
    expect(parseHeadingAtMentions('##### Minor @doc.md')).toEqual(['@doc.md']);
  });

  it('recognises an h6 heading (###### prefix)', () => {
    expect(parseHeadingAtMentions('###### Deep @doc.md')).toEqual(['@doc.md']);
  });

  it('collects mentions from headings at different depths', () => {
    const md = [
      '# Top @a.md',
      '## Two @b.md',
      '### Three @c.md',
    ].join('\n');
    expect(parseHeadingAtMentions(md)).toEqual(['@a.md', '@b.md', '@c.md']);
  });
});

// ============================================================================
// G. Headings inside fenced code blocks are NOT parsed as headings
// ============================================================================

describe('parseHeadingAtMentions — G: fenced code block exclusion', () => {
  it('ignores a heading-like line inside a fenced code block (backticks)', () => {
    const md = [
      '```markdown',
      '## Not a real heading @fake.md',
      '```',
    ].join('\n');
    expect(parseHeadingAtMentions(md)).toEqual([]);
  });

  it('ignores a heading-like line inside a fenced code block (tildes)', () => {
    const md = [
      '~~~',
      '# Also fake @not-real.md',
      '~~~',
    ].join('\n');
    expect(parseHeadingAtMentions(md)).toEqual([]);
  });

  it('extracts mention from heading BEFORE a code fence but not inside', () => {
    const md = [
      '## Real Heading @real.md',
      '',
      '```',
      '## Inside fence @fake.md',
      '```',
    ].join('\n');
    expect(parseHeadingAtMentions(md)).toEqual(['@real.md']);
  });

  it('extracts mention from heading AFTER a closed code fence', () => {
    const md = [
      '```',
      '## Fake @not-here.md',
      '```',
      '',
      '## Real @here.md',
    ].join('\n');
    expect(parseHeadingAtMentions(md)).toEqual(['@here.md']);
  });

  it('handles multi-line code fence with multiple fake headings', () => {
    const md = [
      '## Outer Heading @outer.md',
      '```sh',
      '# comment @script.md',
      '## another @fake.md',
      '```',
      '## After @after.md',
    ].join('\n');
    expect(parseHeadingAtMentions(md)).toEqual(['@outer.md', '@after.md']);
  });
});

// ============================================================================
// H. Mentions in list items and blockquotes are excluded
// ============================================================================

describe('parseHeadingAtMentions — H: list / blockquote body mentions excluded', () => {
  it('excludes @mention in an unordered list item', () => {
    const md = [
      '## Section',
      '',
      '- See @item.md for reference.',
    ].join('\n');
    expect(parseHeadingAtMentions(md)).toEqual([]);
  });

  it('excludes @mention in an ordered list item', () => {
    const md = [
      '## Section',
      '',
      '1. Review @step1.md first.',
    ].join('\n');
    expect(parseHeadingAtMentions(md)).toEqual([]);
  });

  it('excludes @mention in a blockquote', () => {
    const md = [
      '## Section',
      '',
      '> Quoted from @source.md',
    ].join('\n');
    expect(parseHeadingAtMentions(md)).toEqual([]);
  });
});

// ============================================================================
// I. Mixed valid and invalid mentions in a single heading
// ============================================================================

describe('parseHeadingAtMentions — I: mixed mentions in single heading', () => {
  it('returns only .md from a heading with .md, .png, and .xlsx mentions', () => {
    const md = '## Report @summary.md @chart.png @data.xlsx';
    expect(parseHeadingAtMentions(md)).toEqual(['@summary.md']);
  });

  it('returns two .md tokens from a heading with four mixed mentions', () => {
    const md = '## Analysis @a.md @b.png @c.md @d.txt';
    expect(parseHeadingAtMentions(md)).toEqual(['@a.md', '@c.md']);
  });

  it('returns empty array when the only mentions in a heading are non-.md', () => {
    const md = '## Overview @image.jpg @data.csv @script.py';
    expect(parseHeadingAtMentions(md)).toEqual([]);
  });

  it('ignores e-mail address in heading while returning .md mention', () => {
    // E-mail mid-word @ must be excluded (tested at unit level in mention-parser);
    // this confirms the pipeline preserves that behaviour end-to-end.
    const md = '## Contact contact@company.com see @brief.md';
    expect(parseHeadingAtMentions(md)).toEqual(['@brief.md']);
  });

  it('handles heading with @username (no extension) alongside .md mention', () => {
    const md = '## Section @admin @report.md';
    expect(parseHeadingAtMentions(md)).toEqual(['@report.md']);
  });
});

// ============================================================================
// J. Multiple headings — all contribute correctly
// ============================================================================

describe('parseHeadingAtMentions — J: multiple headings contribute', () => {
  it('collects mentions from each heading in document order', () => {
    const md = [
      '# Title',
      '',
      '## Background @context.md',
      'Body text.',
      '',
      '## Analysis @results.md',
      'Body text.',
      '',
      '## Conclusion @summary.md',
    ].join('\n');
    expect(parseHeadingAtMentions(md)).toEqual(['@context.md', '@results.md', '@summary.md']);
  });

  it('handles headings with no mention interspersed between headings with mentions', () => {
    const md = [
      '## Section A @first.md',
      '## Section B (no mentions)',
      '## Section C @third.md',
    ].join('\n');
    expect(parseHeadingAtMentions(md)).toEqual(['@first.md', '@third.md']);
  });

  it('collects all .md mentions from a realistic document structure', () => {
    const md = [
      '# Project Report',
      '',
      'Introduction paragraph — body, excluded.',
      '',
      '## Background @context.md @ignored.png',
      '',
      'Background body @also-ignored.md.',
      '',
      '### Prior Work @reference.md',
      '',
      'Prior work body text.',
      '',
      '## Methodology',
      '',
      'No heading-level mention here.',
      '',
      '## Results @results.md @context.md',
      '',
      '## Conclusion',
      '',
      'Conclusion text with @foot.md in body.',
    ].join('\n');

    expect(parseHeadingAtMentions(md)).toEqual([
      '@context.md',   // first in ## Background (## Results duplicate deduplicated)
      '@reference.md', // ### Prior Work
      '@results.md',   // ## Results
    ]);
  });

  it('handles a document where every heading has exactly one .md mention', () => {
    const md = [
      '# Doc @a.md',
      '## Section @b.md',
      '### Sub @c.md',
      '#### Sub-sub @d.md',
    ].join('\n');
    expect(parseHeadingAtMentions(md)).toEqual(['@a.md', '@b.md', '@c.md', '@d.md']);
  });
});

// ============================================================================
// K. Stable insertion-order of results
// ============================================================================

describe('parseHeadingAtMentions — K: stable insertion order', () => {
  it('returns results in document heading order, not alphabetical', () => {
    const md = [
      '## Section @z.md',
      '## Section @a.md',
      '## Section @m.md',
    ].join('\n');
    // Must be z, a, m — document order, not sorted
    expect(parseHeadingAtMentions(md)).toEqual(['@z.md', '@a.md', '@m.md']);
  });

  it('first-seen wins when deduplicating — order is stable', () => {
    const md = [
      '## First @alpha.md @beta.md',
      '## Second @beta.md @gamma.md',
    ].join('\n');
    expect(parseHeadingAtMentions(md)).toEqual(['@alpha.md', '@beta.md', '@gamma.md']);
  });
});

// ============================================================================
// L. Case-insensitive .md extension matching
// ============================================================================

describe('parseHeadingAtMentions — L: case-insensitive .md extension', () => {
  it('accepts @FILE.MD (all-caps extension) in a heading', () => {
    const md = '## Section @REPORT.MD';
    expect(parseHeadingAtMentions(md)).toEqual(['@REPORT.MD']);
  });

  it('accepts @File.Md (mixed-case extension) in a heading', () => {
    const md = '## Section @Doc.Md';
    expect(parseHeadingAtMentions(md)).toEqual(['@Doc.Md']);
  });

  it('excludes @FILE.TXT (non-.md even uppercase) in a heading', () => {
    const md = '## Section @README.TXT';
    expect(parseHeadingAtMentions(md)).toEqual([]);
  });
});

// ============================================================================
// M. E-mail addresses in heading lines are not extracted
// ============================================================================

describe('parseHeadingAtMentions — M: e-mail addresses excluded', () => {
  it('does not extract mid-word @ from an e-mail in a heading', () => {
    const md = '## Contact user@example.com';
    expect(parseHeadingAtMentions(md)).toEqual([]);
  });

  it('extracts only the .md mention, not the e-mail, from a mixed heading', () => {
    const md = '## Contact me@company.com or see @brief.md';
    expect(parseHeadingAtMentions(md)).toEqual(['@brief.md']);
  });
});

// ============================================================================
// N. Return type guarantees
// ============================================================================

describe('parseHeadingAtMentions — N: return type guarantees', () => {
  it('always returns an array (never null or undefined)', () => {
    const result = parseHeadingAtMentions('');
    expect(Array.isArray(result)).toBe(true);
  });

  it('returns an array for a document with no headings', () => {
    const result = parseHeadingAtMentions('Just body text @ignored.md');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it('returns an array for a document with headings but no .md mentions', () => {
    const result = parseHeadingAtMentions('## Heading @image.png');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it('all returned tokens start with @ and end with .md (case-insensitive)', () => {
    const md = [
      '## Section A @report.md',
      '## Section B @NOTES.MD',
      '## Section C @data.csv @summary.md',
    ].join('\n');
    const results = parseHeadingAtMentions(md);
    expect(results.length).toBeGreaterThan(0);
    for (const token of results) {
      expect(token.startsWith('@')).toBe(true);
      expect(token.toLowerCase().endsWith('.md')).toBe(true);
    }
  });
});

// ============================================================================
// Integration: canonical Seed scenario (combined A + B + C)
// ============================================================================

describe('parseHeadingAtMentions — integration: Seed canonical scenario', () => {
  /**
   * Simulates a document from the "meeting minutes → report" dogfooding
   * scenario:
   *   - Document has multiple heading levels
   *   - Some headings reference .md context files
   *   - Body paragraphs also contain @mentions (must be excluded)
   *   - One non-.md mention in a heading (must be excluded)
   *   - One .md mention appears in two headings (must be deduplicated)
   */
  it('passes the meeting-minutes-to-report canonical scenario', () => {
    const doc = `
# Q3 Strategy Report @overview.md

This document synthesises the Q3 meeting minutes and @background.md notes.
(This line is body — excluded.)

## Executive Summary @background.md

Summary paragraph. See @ignored-body.md.

## Action Items @tasks.md @diagram.png

- Item 1 references @list-item.md (body list — excluded)
- Item 2

## Next Steps

Body content only. No heading mention.

### Timeline @timeline.md @background.md

Detailed timeline body.
    `.trim();

    // Expected: @overview.md (h1), @background.md (first seen in h2),
    //           @tasks.md (h2 Action Items), @timeline.md (h3 Timeline)
    // @diagram.png — excluded (not .md)
    // @background.md in h3 Timeline — deduplicated (already in result)
    // body mentions — all excluded
    expect(parseHeadingAtMentions(doc)).toEqual([
      '@overview.md',
      '@background.md',
      '@tasks.md',
      '@timeline.md',
    ]);
  });

  /**
   * Simulates the "existing-doc → new-doc" scenario where a user creates
   * a new document outline that references multiple source files.
   */
  it('passes the existing-doc-to-new-doc scenario', () => {
    const doc = [
      '# New Report Draft',
      '',
      'Draft introduction paragraph (no mentions in heading).',
      '',
      '## Background @source-a.md @source-b.md',
      '',
      'Body references @ignored.md.',
      '',
      '## Methodology @source-b.md @method.md',
      '',
      '## Results @results.md',
      '',
      '## Conclusion',
    ].join('\n');

    // @source-a.md — h2 Background
    // @source-b.md — h2 Background (first), deduplicated from h2 Methodology
    // @method.md — h2 Methodology
    // @results.md — h2 Results
    // @ignored.md — body, excluded
    expect(parseHeadingAtMentions(doc)).toEqual([
      '@source-a.md',
      '@source-b.md',
      '@method.md',
      '@results.md',
    ]);
  });
});
