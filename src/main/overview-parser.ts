/**
 * overview-parser.ts
 *
 * Pure utility for parsing the content of a single Overview.md file into a
 * structured map of key-value fields and named sections.
 *
 * Overview.md is the folder-level context file injected into the 7-layer
 * prompt stack for Side Chat and Outline→Draft workflows (v1.1 Seed, AC #12).
 *
 * ─── File format ────────────────────────────────────────────────────────────
 * An Overview.md file may contain two kinds of content:
 *
 * 1. Key-value FIELDS — lines matching `key: value` that appear BEFORE the
 *    first `##` heading.  Common fields: `purpose`, `tone`, `language`,
 *    `forbidden-terms`.  A `#` document-title line may precede fields and is
 *    silently ignored.
 *
 * 2. Named SECTIONS — blocks of text delimited by `##` (or deeper) headings.
 *    The heading text (stripped of `#` and whitespace) becomes the section key;
 *    all subsequent lines until the next `##` heading (or EOF) become the body.
 *
 * Example:
 * ─────────────────────────────────────────────────
 * # Project Alpha
 *
 * purpose: Quarterly report for executives
 * tone: Formal and concise
 * forbidden-terms: experimental, prototype
 *
 * ## Background
 * This project started in Q1 2024…
 *
 * ## Style Guidelines
 * Use active voice.  Avoid passive constructions.
 * ─────────────────────────────────────────────────
 *
 * → fields:   { purpose: "Quarterly report for executives",
 *               tone: "Formal and concise",
 *               "forbidden-terms": "experimental, prototype" }
 * → sections: { Background: "This project started in Q1 2024…",
 *               "Style Guidelines": "Use active voice.  Avoid passive constructions." }
 *
 * ─── Design notes ───────────────────────────────────────────────────────────
 * - PURE FUNCTION — no imports beyond built-in TypeScript types.  No I/O, no
 *   DOM, no Electron.  Safe to call in both main and renderer processes.
 * - ROLLBACK SAFETY — callers guard invocations behind the `promptLayersEnabled`
 *   feature toggle.  This module itself has no toggle awareness.
 * - Absent files (Overview.md not found) are handled at the call site
 *   (findOverviewChain / overview-traversal.ts); this parser only operates on
 *   strings, so it never crashes on missing files.
 * - When the same section heading appears more than once the LAST occurrence
 *   wins (later content is considered more specific).
 * - Non-`key: value` lines in the pre-heading zone (other than `#` titles) are
 *   silently dropped; they do not appear in either `fields` or `sections`.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Structured representation of a parsed Overview.md file.
 *
 * @property fields   - Key-value pairs extracted from `key: value` lines that
 *                      appear before the first `##` heading.
 *                      Keys are trimmed; values are trimmed.
 *                      Empty object when no fields are present.
 *
 * @property sections - Named sections keyed by heading text (with `#` stripped
 *                      and trimmed).  Values are the trimmed section body text.
 *                      Empty object when no `##` headings are present.
 */
export interface OverviewMap {
  fields: Record<string, string>;
  sections: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Matches a Markdown heading at level 2 or deeper (##, ###, ####, …).
 * Capture group 1 = the heading text (after the `#` chars and mandatory space).
 *
 * We treat level-2+ headings as section separators and level-1 headings (`#`)
 * as document titles — level-1 is silently skipped in the pre-heading zone and
 * treated as regular body content inside a section.
 */
const SECTION_HEADING_RE = /^#{2,}\s+(.*)/;

/**
 * Matches a simple `key: value` field line.
 * - `key`   (capture group 1) — everything before the FIRST colon; trimmed.
 * - `value` (capture group 2) — everything after the first `: `; trimmed.
 *
 * Allows colons in the value (e.g. `forbidden-terms: foo: bar`).
 * The key must contain at least one non-colon character.
 */
const FIELD_RE = /^([^:\r\n]+):\s*(.*)/;

// ---------------------------------------------------------------------------
// Core parser
// ---------------------------------------------------------------------------

/**
 * Parses the raw string content of a single Overview.md file into an
 * {@link OverviewMap} containing extracted fields and named sections.
 *
 * @param content - Raw UTF-8 string of an Overview.md file.
 *                  Pass an empty string or whitespace-only string to receive an
 *                  empty `OverviewMap` (both maps will be `{}`).
 *
 * @returns Structured {@link OverviewMap} with `fields` and `sections` maps.
 *          Never throws — all edge cases return a valid (possibly empty) map.
 *
 * @example
 * // Fields-only
 * parseOverview("purpose: Monthly report\ntone: Formal")
 * // → { fields: { purpose: "Monthly report", tone: "Formal" }, sections: {} }
 *
 * @example
 * // Sections-only
 * parseOverview("## Background\nContext here.\n\n## Style\nBe concise.")
 * // → { fields: {}, sections: { Background: "Context here.", Style: "Be concise." } }
 *
 * @example
 * // Mixed
 * parseOverview("tone: Formal\n\n## Background\nContext.")
 * // → { fields: { tone: "Formal" }, sections: { Background: "Context." } }
 *
 * @example
 * // Empty
 * parseOverview("")
 * // → { fields: {}, sections: {} }
 */
/**
 * Merges an ordered array of {@link OverviewMap} objects into a single map
 * using the **closer-wins** rule: lower array indices take priority over
 * higher indices (index 0 = highest priority, i.e. the file closest to the
 * document being edited).
 *
 * Merge semantics:
 * - **Fields**: same-key conflicts are won by the lowest-index map that
 *   defines the key.  Distinct keys from all maps are unioned.
 * - **Sections**: identical rule — lowest-index heading wins for section
 *   content conflicts; all unique headings are included.
 *
 * This mirrors the Claude Code CLAUDE.md cascade pattern referenced in the
 * v1.1 Seed: a subfolder's Overview.md overrides its parent's Overview.md
 * for the same field or section name, while inheriting all non-conflicting
 * entries from parent files.
 *
 * @param maps - Ordered array of parsed {@link OverviewMap} objects.
 *               Index 0 is the highest-priority map (closest to the document).
 *               Pass an empty array to receive an empty {@link OverviewMap}.
 *
 * @returns A new {@link OverviewMap} containing the merged fields and sections.
 *          The input maps are never mutated.
 *
 * @example
 * // Single-element passthrough
 * mergeOverviewMaps([{ fields: { tone: 'formal' }, sections: {} }])
 * // → { fields: { tone: 'formal' }, sections: {} }
 *
 * @example
 * // All-distinct keys — union
 * mergeOverviewMaps([
 *   { fields: { tone: 'formal' }, sections: {} },
 *   { fields: { purpose: 'report' }, sections: {} },
 * ])
 * // → { fields: { tone: 'formal', purpose: 'report' }, sections: {} }
 *
 * @example
 * // Same-key conflict — index 0 wins
 * mergeOverviewMaps([
 *   { fields: { tone: 'formal' }, sections: {} },    // closer (wins)
 *   { fields: { tone: 'casual' }, sections: {} },    // farther (loses)
 * ])
 * // → { fields: { tone: 'formal' }, sections: {} }
 */
// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

/**
 * Serializes an {@link OverviewMap} back to a Markdown string.
 *
 * Output format:
 * - Fields are emitted first, one per line as `key: value`.
 * - A blank line separates the fields block from the sections block (when both
 *   exist).
 * - Sections are emitted in insertion order as `## heading\nbody`, separated by
 *   a blank line between consecutive sections.
 * - If both fields and sections are empty, returns an empty string `""`.
 *
 * Round-trip contract:
 *   `parseOverview(serializeOverviewMap(parseOverview(x)))` is semantically
 *   equivalent to `parseOverview(x)` — the fields and sections are preserved,
 *   though the string may not be byte-identical to the original.
 *
 * @param map - A structured {@link OverviewMap} to serialize.
 * @returns   Markdown-formatted string, or `""` when both maps are empty.
 */
function serializeOverviewMap(map: OverviewMap): string {
  const parts: string[] = [];

  // ── Fields block ────────────────────────────────────────────────────────────
  const fieldLines: string[] = [];
  for (const [key, value] of Object.entries(map.fields)) {
    fieldLines.push(`${key}: ${value}`);
  }
  if (fieldLines.length > 0) {
    parts.push(fieldLines.join('\n'));
  }

  // ── Sections block ──────────────────────────────────────────────────────────
  const sectionBlocks: string[] = [];
  for (const [heading, body] of Object.entries(map.sections)) {
    sectionBlocks.push(body ? `## ${heading}\n${body}` : `## ${heading}`);
  }
  if (sectionBlocks.length > 0) {
    parts.push(sectionBlocks.join('\n\n'));
  }

  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Cascade-merge pipeline
// ---------------------------------------------------------------------------

/**
 * Cascade-merges an ordered array of raw Overview.md content strings into a
 * single Markdown string, applying the **closer-wins** conflict-resolution rule.
 *
 * This is the top-level pipeline composing {@link parseOverview} and
 * {@link mergeOverviewMaps}:
 *
 * ```
 * cascadeMerge(contents)
 *   ≡ serializeOverviewMap(mergeOverviewMaps(contents.map(parseOverview)))
 * ```
 *
 * Ordering convention — `contents[0]` is the **highest-priority** entry (the
 * Overview.md file physically closest to the document being edited); later
 * indices are lower priority.  This mirrors the Claude Code CLAUDE.md cascade
 * pattern referenced in the v1.1 Seed: a child folder's context overrides a
 * parent folder's context for the same key while inheriting everything else.
 *
 * PURE FUNCTION — no I/O, no DOM, no Electron.  Safe to call in both main and
 * renderer processes.
 *
 * ROLLBACK SAFETY — callers guard invocations behind the `promptLayersEnabled`
 * feature toggle.  This function itself has no toggle awareness and is
 * independently disable-able by simply not calling it.
 *
 * @param contents - Array of raw UTF-8 strings, each being the full text of one
 *                   Overview.md file.  Pass `[]` to receive `""`.
 *                   Index 0 = closest / highest priority.
 *
 * @returns A Markdown string containing the merged fields (`key: value` lines)
 *          followed by merged sections (`## heading\nbody` blocks), separated by
 *          a blank line.  Returns `""` when all inputs are empty or the array
 *          itself is empty.
 *
 * @example
 * // Single entry — semantic round-trip
 * const content = 'tone: formal\n\n## Style\nBe direct.';
 * cascadeMerge([content]);
 * // → 'tone: formal\n\n## Style\nBe direct.'
 *
 * @example
 * // Non-conflicting multi-level concatenation
 * cascadeMerge([
 *   'tone: formal',               // child (closest, index 0)
 *   'purpose: Quarterly report',  // parent (index 1)
 * ]);
 * // → 'tone: formal\npurpose: Quarterly report'
 *
 * @example
 * // Conflicting key — closer wins
 * cascadeMerge([
 *   'tone: formal',  // child wins
 *   'tone: casual',  // parent loses
 * ]);
 * // → 'tone: formal'
 */
export function cascadeMerge(contents: string[]): string {
  if (contents.length === 0) {
    return '';
  }
  const maps = contents.map(parseOverview);
  const merged = mergeOverviewMaps(maps);
  return serializeOverviewMap(merged);
}

export function mergeOverviewMaps(maps: OverviewMap[]): OverviewMap {
  // Fast-path: empty input.
  if (maps.length === 0) {
    return { fields: {}, sections: {} };
  }

  // Fast-path: single element — return a shallow copy (non-mutating passthrough).
  if (maps.length === 1) {
    return {
      fields: { ...maps[0].fields },
      sections: { ...maps[0].sections },
    };
  }

  // Multi-element merge:
  // Iterate from LOWEST priority (highest index) to HIGHEST priority (index 0).
  // Each iteration overwrites the merged result with the current map's values,
  // so the final pass (index 0) wins for any conflicting keys.
  const mergedFields: Record<string, string> = {};
  const mergedSections: Record<string, string> = {};

  for (let i = maps.length - 1; i >= 0; i--) {
    Object.assign(mergedFields, maps[i].fields);
    Object.assign(mergedSections, maps[i].sections);
  }

  return { fields: mergedFields, sections: mergedSections };
}

// ---------------------------------------------------------------------------
// Core parser
// ---------------------------------------------------------------------------

export function parseOverview(content: string): OverviewMap {
  const fields: Record<string, string> = {};
  const sections: Record<string, string> = {};

  // Fast-path: nothing to parse.
  if (!content || content.trim() === '') {
    return { fields, sections };
  }

  // Normalise line endings to `\n` only (handles \r\n from Windows-created files).
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  // ── State machine ──────────────────────────────────────────────────────────
  // `inSection`      — true once the first ## heading has been seen
  // `currentHeading` — heading text of the section currently being accumulated
  // `currentBody`    — accumulated lines for the current section
  let inSection = false;
  let currentHeading = '';
  let currentBody: string[] = [];

  /**
   * Flush the in-progress section into the sections map.
   * Section body is joined and trimmed to remove leading/trailing blank lines.
   *
   * Note: an empty heading (from `## ` with no text) is stored under key `""`
   * (empty string).  This is intentional — callers look up sections by name
   * and will never accidentally hit the `""` key unless they explicitly ask
   * for it.  Excluding it would require special-casing and could hide bugs.
   */
  function flushSection(): void {
    if (inSection) {
      sections[currentHeading] = currentBody.join('\n').trim();
    }
  }

  for (const rawLine of lines) {
    // Preserve internal content as-is; only strip trailing whitespace from
    // the right when checking patterns (not from the stored content).
    const trimmedLine = rawLine.trimEnd();

    // ── Check for a section heading (## or deeper) ─────────────────────────
    // Use `rawLine` (not `trimmedLine`) so that a trailing-space line like
    // "## " is still detected as a heading.  The regex's `\s+` consumes the
    // space and capture group 1 captures the empty string (if no heading text).
    const headingMatch = rawLine.match(SECTION_HEADING_RE);
    if (headingMatch) {
      // Save the previously accumulated section (if any).
      flushSection();

      // Begin new section.  capture group 1 may be undefined when the heading
      // line is exactly `##` with no trailing characters at all; normalise to "".
      currentHeading = (headingMatch[1] ?? '').trim();
      currentBody = [];
      inSection = true;
      continue;
    }

    if (inSection) {
      // Inside a section: accumulate ALL lines (including blanks) verbatim.
      // The body is trimmed at flush time.
      currentBody.push(rawLine);
    } else {
      // Pre-heading zone ─────────────────────────────────────────────────────

      // Skip level-1 headings (document title line).
      if (trimmedLine.startsWith('#')) {
        continue;
      }

      // Attempt to parse a `key: value` field.
      const fieldMatch = trimmedLine.match(FIELD_RE);
      if (fieldMatch) {
        const key = fieldMatch[1].trim();
        const value = fieldMatch[2].trim();
        // Only store non-empty keys.
        if (key.length > 0) {
          fields[key] = value;
        }
      }
      // Lines that are neither a heading nor a `key: value` pair are silently
      // dropped.  This keeps the pre-heading zone intentionally structured.
    }
  }

  // Flush the final section (if the file ends without a trailing heading).
  flushSection();

  return { fields, sections };
}
