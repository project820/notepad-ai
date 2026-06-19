/**
 * mention-parser.ts
 *
 * Utility functions for parsing @mention tokens from Markdown text.
 * Used by the v1.1 context-aware AI features to extract file references
 * from heading lines.
 *
 * ROLLBACK SAFETY: This module is purely functional with no side-effects.
 * It has zero coupling to the editor or AI surfaces. Removing its callers
 * fully reverts all @mention behaviour without data migration.
 *
 * Design decisions:
 * - `extractAtMentionTokens` is intentionally permissive: it returns ALL
 *   @mention tokens regardless of file extension. Callers that need .md-only
 *   references must filter the result (see `filterMdMentions` below).
 * - Mid-word '@' (e.g. in e-mail addresses) is rejected via a lookbehind.
 * - No I/O, no imports — safe to call in both main and renderer processes.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A raw @mention token exactly as it appears in source text, e.g. "@report.md"
 */
export type MentionToken = string;

// ---------------------------------------------------------------------------
// Core extractor
// ---------------------------------------------------------------------------

/**
 * Extracts all @mention tokens from a raw string.
 *
 * Rules:
 * - The `@` must NOT be immediately preceded by a word character (`\w`).
 *   This rejects mid-word mentions such as e-mail addresses (`user@host.com`).
 * - The character immediately after `@` must be a word character, so bare `@`
 *   or `@ space` produce no match.
 * - The rest of the token may contain word chars (`\w`), hyphens (`-`), and
 *   dots (`.`), enabling filenames like `@my-doc.md`, `@2024_Q1.md`.
 * - Non-.md filenames (e.g. `@logo.png`, `@sheet.xlsx`) are returned as-is
 *   (pass-through). The caller decides whether to act on them.
 *
 * @param text - Any raw string (heading line, body paragraph, etc.)
 * @returns Ordered array of @mention token strings.
 *          Empty array when no valid tokens are found.
 *
 * @example
 * extractAtMentionTokens("## Status @report.md and @notes.md")
 * // => ["@report.md", "@notes.md"]
 *
 * extractAtMentionTokens("send to user@example.com")
 * // => []   (mid-word @ is rejected)
 *
 * extractAtMentionTokens("no mentions here")
 * // => []
 *
 * extractAtMentionTokens("@logo.png used as reference")
 * // => ["@logo.png"]   (non-.md, included as pass-through)
 */
export function extractAtMentionTokens(text: string): MentionToken[] {
  /**
   * Regex breakdown:
   *   (?<!\w)   — negative lookbehind: @ must NOT follow a word character
   *   @         — literal @ symbol
   *   [\w]      — first char of filename must be a word char (rejects bare "@")
   *   [\w.-]*   — remaining chars: word chars, dots, hyphens (zero or more)
   *
   * The `g` flag is required for `matchAll`.
   */
  const MENTION_RE = /(?<!\w)@[\w][\w.-]*/g;
  return Array.from(text.matchAll(MENTION_RE), (m) => m[0]);
}

// ---------------------------------------------------------------------------
// Convenience helpers
// ---------------------------------------------------------------------------

/**
 * Filters an array of mention tokens to only those referencing .md files.
 *
 * Per the v1.1 spec, only `.md` files may be injected as context.
 * This helper is the recommended way to apply that filter after
 * `extractAtMentionTokens`.
 *
 * @param tokens - Token array from `extractAtMentionTokens`
 * @returns Subset of tokens whose filename ends with `.md` (case-insensitive)
 */
export function filterMdMentions(tokens: MentionToken[]): MentionToken[] {
  return tokens.filter((t) => t.toLowerCase().endsWith('.md'));
}

/**
 * Filters a list of @mention tokens to only those whose filename ends in `.md`.
 *
 * This is the canonical Sub-AC 5c filter for the v1.1 context injection pipeline.
 * It accepts raw mention strings (with or without leading `@`) and applies a
 * case-insensitive `.md` suffix check so that files saved as `.MD` on
 * case-insensitive macOS HFS+ / APFS volumes are also accepted.
 *
 * Difference from `filterMdMentions`: this function accepts plain filename
 * strings as well as `@`-prefixed tokens, making it usable at any point in
 * the pipeline regardless of whether the leading `@` has been stripped.
 *
 * @param mentions - Array of strings, each a mention token such as
 *   `"@report.md"`, `"@notes.txt"`, `"@script.ts"`, or `"@username"`.
 * @returns New array containing only those entries whose filename (the portion
 *   after a leading `@`, if present) ends with `.md` (case-insensitive).
 *
 * @example
 * filterMdFileReferences(['@report.md', '@sheet.txt', '@util.ts', '@username'])
 * // => ['@report.md']
 *
 * filterMdFileReferences(['@DOC.MD', '@other.txt'])
 * // => ['@DOC.MD']  — case-insensitive match
 *
 * filterMdFileReferences([])
 * // => []
 */
export function filterMdFileReferences(mentions: string[]): string[] {
  return mentions.filter((m) => {
    // Strip the leading '@' (if present) to get the bare filename, then check
    // for the '.md' suffix in a case-insensitive manner.
    const filename = m.startsWith('@') ? m.slice(1) : m;
    return filename.toLowerCase().endsWith('.md');
  });
}

/**
 * Strips the leading `@` from a mention token, returning the bare filename.
 *
 * @param token - e.g. "@report.md"
 * @returns e.g. "report.md"
 */
export function mentionToFilename(token: MentionToken): string {
  return token.startsWith('@') ? token.slice(1) : token;
}

// ---------------------------------------------------------------------------
// Sub-AC 5d-i: extractAtMentionsFromText
// ---------------------------------------------------------------------------

/**
 * Applies the @mention regex to a single string and returns all captured
 * mention tokens, regardless of file extension.
 *
 * This is the atomic, testable unit described in Sub-AC 5d-i. It is a thin
 * named alias for `extractAtMentionTokens` with a more ergonomic name that
 * mirrors the "from text" mental model used throughout the pipeline.
 *
 * Callers that only need `.md` references should pipe the result through
 * `filterMdMentions` or `filterMdFileReferences`.
 *
 * Rules (identical to `extractAtMentionTokens`):
 * - The `@` must NOT be immediately preceded by a word character — rejects
 *   mid-word mentions such as e-mail addresses (`user@host.com`).
 * - The character immediately after `@` must be a word character, so bare
 *   `@` or `@ space` produce no match.
 * - The token may contain word chars, hyphens, and dots, enabling filenames
 *   such as `@my-doc.md`, `@2024_Q1.md`.
 * - Non-.md tokens (e.g. `@logo.png`, `@username`) are returned as-is.
 *
 * @param text - Any raw string; typically a heading's plain text.
 * @returns Ordered array of @mention token strings.
 *          Empty array when no valid tokens are found.
 *
 * @example
 * extractAtMentionsFromText("## Status @report.md and @notes.md")
 * // => ["@report.md", "@notes.md"]
 *
 * extractAtMentionsFromText("no mentions here")
 * // => []
 *
 * extractAtMentionsFromText("send to user@example.com")
 * // => []   (mid-word @ is rejected)
 *
 * extractAtMentionsFromText("@username")
 * // => ["@username"]   (no extension — included as pass-through)
 */
export function extractAtMentionsFromText(text: string): string[] {
  return extractAtMentionTokens(text);
}
