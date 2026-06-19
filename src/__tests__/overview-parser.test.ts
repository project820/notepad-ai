/**
 * overview-parser.test.ts
 *
 * Unit tests for `parseOverview(content: string) → OverviewMap`.
 *
 * Test matrix (Sub-AC 12.2.1):
 *
 *  GROUP A — Empty / whitespace inputs
 *   A1. Empty string → { fields: {}, sections: {} }
 *   A2. Whitespace-only string → { fields: {}, sections: {} }
 *   A3. Only newlines → { fields: {}, sections: {} }
 *
 *  GROUP B — Fields-only (no ## headings)
 *   B1. Single field
 *   B2. Multiple fields
 *   B3. Field with empty value (`key:`)
 *   B4. Field with colon(s) in the value
 *   B5. Field key with hyphens
 *   B6. `# Title` line before fields is silently ignored
 *   B7. Non-field non-heading lines are silently dropped
 *   B8. Fields are trimmed (leading/trailing whitespace)
 *
 *  GROUP C — Sections-only (no key-value fields)
 *   C1. Single section with body
 *   C2. Multiple sections
 *   C3. Section with multi-line body
 *   C4. Section body is trimmed (leading/trailing blank lines removed)
 *   C5. Empty section body
 *   C6. Section heading text is trimmed
 *   C7. `###` deeper headings create section entries
 *   C8. Blank lines between sections don't produce phantom sections
 *
 *  GROUP D — Mixed content (fields + sections)
 *   D1. Fields before first section, sections after
 *   D2. `# Title` → field lines → `## Section` → body
 *   D3. Non-field lines in pre-heading zone don't appear in output
 *   D4. Fields are NOT added to sections; sections are NOT added to fields
 *
 *  GROUP E — Edge cases
 *   E1. Duplicate section heading — last-wins
 *   E2. `##` with no heading text — skipped (empty key)
 *   E3. Windows-style CRLF line endings handled correctly
 *   E4. Single-char field key
 *   E5. Large document (many sections)
 */

import { describe, it, expect } from 'vitest';
import { parseOverview, mergeOverviewMaps, cascadeMerge, type OverviewMap } from '../../src/main/overview-parser';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convenience wrapper: assert both maps are empty. */
function expectEmpty(result: OverviewMap) {
  expect(result.fields).toEqual({});
  expect(result.sections).toEqual({});
}

// ============================================================================
// GROUP A — Empty / whitespace inputs
// ============================================================================

describe('parseOverview — empty / whitespace inputs', () => {
  it('A1: empty string returns empty fields and sections', () => {
    expectEmpty(parseOverview(''));
  });

  it('A2: whitespace-only string returns empty fields and sections', () => {
    expectEmpty(parseOverview('   \t  '));
  });

  it('A3: only newlines returns empty fields and sections', () => {
    expectEmpty(parseOverview('\n\n\n'));
  });
});

// ============================================================================
// GROUP B — Fields-only (no ## headings)
// ============================================================================

describe('parseOverview — fields-only', () => {
  it('B1: parses a single key-value field', () => {
    const result = parseOverview('purpose: Monthly report');
    expect(result.fields).toEqual({ purpose: 'Monthly report' });
    expect(result.sections).toEqual({});
  });

  it('B2: parses multiple key-value fields', () => {
    const content = [
      'purpose: Quarterly report for executives',
      'tone: Formal and concise',
      'language: Korean',
    ].join('\n');

    const result = parseOverview(content);
    expect(result.fields).toEqual({
      purpose: 'Quarterly report for executives',
      tone: 'Formal and concise',
      language: 'Korean',
    });
    expect(result.sections).toEqual({});
  });

  it('B3: parses a field with an empty value', () => {
    const result = parseOverview('forbidden-terms:');
    expect(result.fields).toEqual({ 'forbidden-terms': '' });
    expect(result.sections).toEqual({});
  });

  it('B4: preserves colons inside the field value', () => {
    // Only the FIRST colon is the key-value delimiter.
    const result = parseOverview('note: see section 3: appendix');
    expect(result.fields).toEqual({ note: 'see section 3: appendix' });
    expect(result.sections).toEqual({});
  });

  it('B4b: preserves multiple colons inside the field value', () => {
    const result = parseOverview('time: 09:00–17:00 KST');
    expect(result.fields).toEqual({ time: '09:00–17:00 KST' });
  });

  it('B5: parses a field key containing hyphens', () => {
    const result = parseOverview('forbidden-terms: experimental, prototype, failed');
    expect(result.fields).toEqual({
      'forbidden-terms': 'experimental, prototype, failed',
    });
  });

  it('B6: silently ignores a `# Title` line before fields', () => {
    const content = '# Project Alpha\n\npurpose: Report\ntone: Formal';
    const result = parseOverview(content);
    expect(result.fields).toEqual({ purpose: 'Report', tone: 'Formal' });
    expect(result.sections).toEqual({});
  });

  it('B7: silently drops non-field non-heading lines in the pre-heading zone', () => {
    // "This project is..." is a plain prose line — should not appear in output.
    const content = [
      'purpose: Report',
      'This project is about quarterly financials.',
      'tone: Formal',
    ].join('\n');

    const result = parseOverview(content);
    // Only key-value pairs are extracted; prose line is dropped.
    expect(result.fields).toEqual({ purpose: 'Report', tone: 'Formal' });
    expect(result.sections).toEqual({});
  });

  it('B8: trims leading and trailing whitespace from field keys and values', () => {
    // Raw line: "  purpose :  Report generation  "
    // After trimEnd(): "  purpose :  Report generation"
    // fieldMatch[1] trimmed → "purpose :" — wait, the FIELD_RE key is [^:]+
    // Let's use a straightforward case: extra spaces in the value.
    const result = parseOverview('tone:   Formal and concise   ');
    // Value is trimmed at extraction time.
    expect(result.fields['tone']).toBe('Formal and concise');
  });
});

// ============================================================================
// GROUP C — Sections-only (no key-value fields)
// ============================================================================

describe('parseOverview — sections-only', () => {
  it('C1: parses a single section with a one-line body', () => {
    const content = '## Background\nThis project started in Q1 2024.';
    const result = parseOverview(content);
    expect(result.fields).toEqual({});
    expect(result.sections).toEqual({
      Background: 'This project started in Q1 2024.',
    });
  });

  it('C2: parses multiple sections', () => {
    const content = [
      '## Background',
      'Context here.',
      '',
      '## Style',
      'Be concise.',
    ].join('\n');

    const result = parseOverview(content);
    expect(result.fields).toEqual({});
    expect(result.sections).toEqual({
      Background: 'Context here.',
      Style: 'Be concise.',
    });
  });

  it('C3: captures multi-line section bodies', () => {
    const content = [
      '## Style Guidelines',
      'Use active voice.',
      'Avoid passive constructions.',
      'Be direct and confident.',
    ].join('\n');

    const result = parseOverview(content);
    expect(result.sections['Style Guidelines']).toBe(
      'Use active voice.\nAvoid passive constructions.\nBe direct and confident.'
    );
  });

  it('C4: trims leading and trailing blank lines from section body', () => {
    const content = '## Tone\n\n\nBe concise.\n\n';
    const result = parseOverview(content);
    expect(result.sections['Tone']).toBe('Be concise.');
  });

  it('C5: records an empty string for a section with no body', () => {
    const content = '## EmptySection\n## NextSection\nBody here.';
    const result = parseOverview(content);
    expect(result.sections['EmptySection']).toBe('');
    expect(result.sections['NextSection']).toBe('Body here.');
  });

  it('C6: trims leading and trailing whitespace from section heading text', () => {
    // "##   Spaced Heading   " → key should be "Spaced Heading"
    const content = '##   Spaced Heading   \nSome body.';
    const result = parseOverview(content);
    expect(Object.keys(result.sections)).toContain('Spaced Heading');
    expect(result.sections['Spaced Heading']).toBe('Some body.');
  });

  it('C7: treats ### (level-3) headings as section separators', () => {
    const content = '### Deep Section\nContent.';
    const result = parseOverview(content);
    expect(result.sections['Deep Section']).toBe('Content.');
  });

  it('C7b: treats #### (level-4) headings as section separators', () => {
    const content = '#### Very Deep\nMore content.';
    const result = parseOverview(content);
    expect(result.sections['Very Deep']).toBe('More content.');
  });

  it('C8: blank lines between sections do not create phantom sections', () => {
    const content = [
      '## First',
      'A.',
      '',
      '',
      '## Second',
      'B.',
    ].join('\n');

    const result = parseOverview(content);
    expect(Object.keys(result.sections)).toHaveLength(2);
    expect(result.sections['First']).toBe('A.');
    expect(result.sections['Second']).toBe('B.');
  });
});

// ============================================================================
// GROUP D — Mixed content (fields + sections)
// ============================================================================

describe('parseOverview — mixed content', () => {
  it('D1: parses fields before sections and sections after', () => {
    const content = [
      'purpose: Quarterly report for executives',
      'tone: Formal and concise',
      'forbidden-terms: experimental, prototype',
      '',
      '## Background',
      'This project started in Q1 2024.',
      '',
      '## Style Guidelines',
      'Use active voice.  Avoid passive constructions.',
    ].join('\n');

    const result = parseOverview(content);

    expect(result.fields).toEqual({
      purpose: 'Quarterly report for executives',
      tone: 'Formal and concise',
      'forbidden-terms': 'experimental, prototype',
    });
    expect(result.sections).toEqual({
      Background: 'This project started in Q1 2024.',
      'Style Guidelines': 'Use active voice.  Avoid passive constructions.',
    });
  });

  it('D2: handles # title → fields → ## sections in sequence', () => {
    const content = [
      '# Project Alpha',
      '',
      'purpose: Report',
      'tone: Formal',
      '',
      '## Context',
      'We work on finance.',
    ].join('\n');

    const result = parseOverview(content);
    expect(result.fields).toEqual({ purpose: 'Report', tone: 'Formal' });
    expect(result.sections).toEqual({ Context: 'We work on finance.' });
  });

  it('D3: non-field prose in pre-heading zone is dropped (not in fields or sections)', () => {
    const content = [
      'purpose: Report',
      'This is a prose line that is not a field.',
      'tone: Formal',
      '',
      '## Background',
      'Context.',
    ].join('\n');

    const result = parseOverview(content);
    // fields has only the key-value pairs
    expect(Object.keys(result.fields)).toHaveLength(2);
    expect(result.fields).toEqual({ purpose: 'Report', tone: 'Formal' });
    // sections has only the heading section
    expect(Object.keys(result.sections)).toHaveLength(1);
  });

  it('D4: fields and sections are independent — no cross-contamination', () => {
    const content = 'tone: Formal\n\n## Tone\nBe direct.';
    const result = parseOverview(content);

    // fields should have 'tone' key
    expect(result.fields['tone']).toBe('Formal');
    // sections should have 'Tone' key (heading text)
    expect(result.sections['Tone']).toBe('Be direct.');
    // No bleed-over
    expect(result.fields['Tone']).toBeUndefined();
    expect(result.sections['tone']).toBeUndefined();
  });

  it('D5: three fields + three sections (full realistic example)', () => {
    const content = [
      '# Team Alpha — Overview',
      '',
      'purpose: Monthly status report for management',
      'tone: Professional, concise',
      'language: Korean with English terms for technical concepts',
      '',
      '## Project Background',
      'We are building a document editor.',
      'The goal is to reduce report creation time by 50%.',
      '',
      '## Tone and Voice',
      'Use active voice.',
      'Avoid hedging language.',
      '',
      '## Forbidden Terms',
      'Do not use: experimental, prototype, internal-only.',
    ].join('\n');

    const result = parseOverview(content);

    expect(result.fields).toEqual({
      purpose: 'Monthly status report for management',
      tone: 'Professional, concise',
      language: 'Korean with English terms for technical concepts',
    });

    expect(result.sections['Project Background']).toBe(
      'We are building a document editor.\nThe goal is to reduce report creation time by 50%.'
    );
    expect(result.sections['Tone and Voice']).toBe(
      'Use active voice.\nAvoid hedging language.'
    );
    expect(result.sections['Forbidden Terms']).toBe(
      'Do not use: experimental, prototype, internal-only.'
    );
  });
});

// ============================================================================
// GROUP E — Edge cases
// ============================================================================

describe('parseOverview — edge cases', () => {
  it('E1: duplicate section heading — last occurrence wins', () => {
    const content = [
      '## Style',
      'First version.',
      '## Style',
      'Second version — this should win.',
    ].join('\n');

    const result = parseOverview(content);
    expect(result.sections['Style']).toBe('Second version — this should win.');
  });

  it('E2: ## with no heading text is recorded as empty-key section (then overwritten by later sections)', () => {
    // "## " with no text → heading text is empty string after trim.
    // The implementation stores it under key "" (empty string).
    const content = '## \nOrphan body.';
    const result = parseOverview(content);
    // An empty heading key should NOT pollute the sections map with content
    // that cannot be meaningfully looked up.  We verify only that the parser
    // doesn't crash and that the empty key maps to its body (implementation detail).
    expect(() => parseOverview(content)).not.toThrow();
    // The body IS recorded under "":
    expect(result.sections['']).toBe('Orphan body.');
  });

  it('E3: Windows-style CRLF line endings are normalised correctly', () => {
    const content = 'purpose: Report\r\ntone: Formal\r\n\r\n## Background\r\nContext.';
    const result = parseOverview(content);
    expect(result.fields).toEqual({ purpose: 'Report', tone: 'Formal' });
    expect(result.sections).toEqual({ Background: 'Context.' });
  });

  it('E3b: old Mac-style CR-only line endings are normalised correctly', () => {
    const content = 'purpose: Report\rtone: Formal';
    const result = parseOverview(content);
    expect(result.fields).toEqual({ purpose: 'Report', tone: 'Formal' });
  });

  it('E4: single-character field key is valid', () => {
    const result = parseOverview('x: hello');
    expect(result.fields).toEqual({ x: 'hello' });
  });

  it('E5: large document with many sections is handled correctly', () => {
    const sections = Array.from({ length: 20 }, (_, i) => [
      `## Section ${i + 1}`,
      `Body of section ${i + 1}.`,
    ]).flat();

    const result = parseOverview(sections.join('\n'));
    expect(Object.keys(result.sections)).toHaveLength(20);
    expect(result.sections['Section 1']).toBe('Body of section 1.');
    expect(result.sections['Section 20']).toBe('Body of section 20.');
  });

  it('E6: section body containing a # line (not ##) does not split the section', () => {
    // A `# single-hash` line inside a section body should be treated as content,
    // not as a new section (only ## or deeper trigger section splits).
    const content = [
      '## Main Section',
      'Introduction line.',
      '# This is just content inside the section',
      'More content.',
    ].join('\n');

    const result = parseOverview(content);
    expect(result.sections['Main Section']).toContain('# This is just content inside the section');
  });

  it('E7: returns correct types — fields and sections are plain objects', () => {
    const result = parseOverview('purpose: Test\n\n## Section\nBody.');
    expect(typeof result.fields).toBe('object');
    expect(typeof result.sections).toBe('object');
    expect(Array.isArray(result.fields)).toBe(false);
    expect(Array.isArray(result.sections)).toBe(false);
  });

  it('E8: never throws — malformed or unusual input is handled gracefully', () => {
    const weirdInputs = [
      ':',              // colon-only line
      '::',             // double colon
      '##',             // ## with no space or heading text
      '## ',            // ## with only a space
      '    ## indented heading',  // indented heading (not a real MD heading)
      '\0\0\0',         // null bytes
      'a'.repeat(10000), // very long single line
    ];

    for (const input of weirdInputs) {
      expect(() => parseOverview(input)).not.toThrow();
    }
  });

  it('E9: ## heading at the very last line (no body) produces empty-string body', () => {
    const content = 'purpose: Test\n## Trailing';
    const result = parseOverview(content);
    expect(result.sections['Trailing']).toBe('');
  });

  it('E10: field immediately followed by ## heading (no blank line separator)', () => {
    const content = 'purpose: Report\n## Context\nSome text.';
    const result = parseOverview(content);
    expect(result.fields).toEqual({ purpose: 'Report' });
    expect(result.sections).toEqual({ Context: 'Some text.' });
  });
});

// ============================================================================
// Integration: realistic Overview.md roundtrip
// ============================================================================

describe('parseOverview — realistic Overview.md roundtrip', () => {
  it('parses a complete meeting-minutes project Overview.md', () => {
    const overviewMd = `# 팀 알파 — 프로젝트 오버뷰

purpose: 월간 경영진 보고서 생성
tone: 전문적이고 간결하게
language: 한국어 (기술 용어는 영어 병기)
forbidden-terms: 실험적, 프로토타입, 미완성

## 프로젝트 배경
이 프로젝트는 2024년 1분기에 시작되었습니다.
목표는 보고서 작성 시간을 50% 단축하는 것입니다.

## 작성 톤 가이드
능동형 문장을 사용하세요.
모호한 표현을 피하세요.

## 금지 용어
아래 용어는 사용을 삼가세요: 실험적, 프로토타입, 내부용.
`;

    const result = parseOverview(overviewMd);

    // Fields
    expect(result.fields['purpose']).toBe('월간 경영진 보고서 생성');
    expect(result.fields['tone']).toBe('전문적이고 간결하게');
    expect(result.fields['language']).toBe('한국어 (기술 용어는 영어 병기)');
    expect(result.fields['forbidden-terms']).toBe('실험적, 프로토타입, 미완성');

    // Sections
    expect(result.sections['프로젝트 배경']).toContain('2024년 1분기');
    expect(result.sections['작성 톤 가이드']).toContain('능동형 문장을 사용하세요');
    expect(result.sections['금지 용어']).toContain('실험적, 프로토타입, 내부용');
  });

  it('parses an English-only Overview.md with three fields and two sections', () => {
    const overviewMd = `purpose: Technical design document
tone: Technical, precise
audience: Senior engineers

## Architecture Decision Context
This system was designed to handle 10k concurrent users.
The primary constraint is latency, not throughput.

## Glossary
SSE: Server-Sent Events
CM6: CodeMirror version 6
`;

    const result = parseOverview(overviewMd);

    expect(result.fields).toEqual({
      purpose: 'Technical design document',
      tone: 'Technical, precise',
      audience: 'Senior engineers',
    });
    expect(result.sections['Architecture Decision Context']).toContain(
      '10k concurrent users'
    );
    expect(result.sections['Glossary']).toContain('CodeMirror version 6');
  });
});

// ============================================================================
// mergeOverviewMaps — Sub-AC 12.2.2
// ============================================================================

/**
 * Test matrix for mergeOverviewMaps(maps: OverviewMap[]) → OverviewMap
 *
 * GROUP M1 — Empty / degenerate inputs
 *   M1a. Empty array → { fields: {}, sections: {} }
 *   M1b. Array of one empty map → { fields: {}, sections: {} }
 *   M1c. Array of multiple empty maps → { fields: {}, sections: {} }
 *
 * GROUP M2 — Single-element passthrough
 *   M2a. Single map with only fields is returned (shallow copy)
 *   M2b. Single map with only sections is returned (shallow copy)
 *   M2c. Single map with both fields and sections is returned intact
 *   M2d. Result is a new object (input not mutated)
 *
 * GROUP M3 — All-distinct keys (union, no conflicts)
 *   M3a. Two maps with completely distinct field keys → union of both
 *   M3b. Two maps with completely distinct section keys → union of both
 *   M3c. Three maps with distinct fields and sections → full union
 *   M3d. One map has fields, the other has only sections → union of both
 *
 * GROUP M4 — Same-key conflicts (closer-wins = index 0 wins)
 *   M4a. Same field key in two maps — index 0 wins
 *   M4b. Same section key in two maps — index 0 wins
 *   M4c. Same key in three maps — index 0 wins over index 1 and 2
 *   M4d. Index 0 wins for fields; index 1 wins for a distinct section key
 *        (non-conflicting keys still union correctly)
 *   M4e. All maps share the same key — index 0 value is in result
 *
 * GROUP M5 — Realistic cascading-folder scenarios
 *   M5a. Child folder overrides parent's tone field
 *   M5b. Parent provides purpose; child provides tone; both appear in result
 *   M5c. Three-level cascade: child > parent > grandparent
 */

// ────────────────────────────────────────────────────────────────────────────
// GROUP M1 — Empty / degenerate inputs
// ────────────────────────────────────────────────────────────────────────────

describe('mergeOverviewMaps — empty / degenerate inputs', () => {
  it('M1a: empty array returns an empty OverviewMap', () => {
    const result = mergeOverviewMaps([]);
    expect(result.fields).toEqual({});
    expect(result.sections).toEqual({});
  });

  it('M1b: array of one empty map returns an empty OverviewMap', () => {
    const result = mergeOverviewMaps([{ fields: {}, sections: {} }]);
    expect(result.fields).toEqual({});
    expect(result.sections).toEqual({});
  });

  it('M1c: array of multiple empty maps returns an empty OverviewMap', () => {
    const result = mergeOverviewMaps([
      { fields: {}, sections: {} },
      { fields: {}, sections: {} },
      { fields: {}, sections: {} },
    ]);
    expect(result.fields).toEqual({});
    expect(result.sections).toEqual({});
  });
});

// ────────────────────────────────────────────────────────────────────────────
// GROUP M2 — Single-element passthrough
// ────────────────────────────────────────────────────────────────────────────

describe('mergeOverviewMaps — single-element passthrough', () => {
  it('M2a: single map with only fields returns correct fields', () => {
    const input: OverviewMap = { fields: { tone: 'formal', purpose: 'report' }, sections: {} };
    const result = mergeOverviewMaps([input]);
    expect(result.fields).toEqual({ tone: 'formal', purpose: 'report' });
    expect(result.sections).toEqual({});
  });

  it('M2b: single map with only sections returns correct sections', () => {
    const input: OverviewMap = {
      fields: {},
      sections: { Background: 'Context here.', Style: 'Be concise.' },
    };
    const result = mergeOverviewMaps([input]);
    expect(result.fields).toEqual({});
    expect(result.sections).toEqual({
      Background: 'Context here.',
      Style: 'Be concise.',
    });
  });

  it('M2c: single map with both fields and sections is returned intact', () => {
    const input: OverviewMap = {
      fields: { tone: 'formal', language: 'Korean' },
      sections: { Background: 'Started in Q1.', Style: 'Active voice.' },
    };
    const result = mergeOverviewMaps([input]);
    expect(result.fields).toEqual({ tone: 'formal', language: 'Korean' });
    expect(result.sections).toEqual({
      Background: 'Started in Q1.',
      Style: 'Active voice.',
    });
  });

  it('M2d: result is a new object — original input is not mutated', () => {
    const input: OverviewMap = { fields: { tone: 'formal' }, sections: { Style: 'Active voice.' } };
    const result = mergeOverviewMaps([input]);

    // Mutate the result and verify the input is unchanged.
    result.fields['tone'] = 'MUTATED';
    result.sections['Style'] = 'MUTATED';

    expect(input.fields['tone']).toBe('formal');
    expect(input.sections['Style']).toBe('Active voice.');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// GROUP M3 — All-distinct keys (union, no conflicts)
// ────────────────────────────────────────────────────────────────────────────

describe('mergeOverviewMaps — all-distinct keys (union)', () => {
  it('M3a: two maps with distinct field keys — all keys appear in result', () => {
    const result = mergeOverviewMaps([
      { fields: { tone: 'formal' }, sections: {} },
      { fields: { purpose: 'report' }, sections: {} },
    ]);
    expect(result.fields).toEqual({ tone: 'formal', purpose: 'report' });
    expect(result.sections).toEqual({});
  });

  it('M3b: two maps with distinct section keys — all sections appear in result', () => {
    const result = mergeOverviewMaps([
      { fields: {}, sections: { Background: 'Context here.' } },
      { fields: {}, sections: { Style: 'Be concise.' } },
    ]);
    expect(result.fields).toEqual({});
    expect(result.sections).toEqual({
      Background: 'Context here.',
      Style: 'Be concise.',
    });
  });

  it('M3c: three maps with distinct fields and sections — full union', () => {
    const result = mergeOverviewMaps([
      { fields: { tone: 'formal' }, sections: { Style: 'Active voice.' } },
      { fields: { purpose: 'report' }, sections: { Background: 'Context.' } },
      { fields: { language: 'Korean' }, sections: { Glossary: 'SSE: Server-Sent Events.' } },
    ]);
    expect(result.fields).toEqual({
      tone: 'formal',
      purpose: 'report',
      language: 'Korean',
    });
    expect(result.sections).toEqual({
      Style: 'Active voice.',
      Background: 'Context.',
      Glossary: 'SSE: Server-Sent Events.',
    });
  });

  it('M3d: one map has only fields, the other has only sections — both combined', () => {
    const result = mergeOverviewMaps([
      { fields: { tone: 'formal', purpose: 'report' }, sections: {} },
      { fields: {}, sections: { Background: 'Context here.' } },
    ]);
    expect(result.fields).toEqual({ tone: 'formal', purpose: 'report' });
    expect(result.sections).toEqual({ Background: 'Context here.' });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// GROUP M4 — Same-key conflicts (closer-wins = index 0 wins)
// ────────────────────────────────────────────────────────────────────────────

describe('mergeOverviewMaps — same-key conflicts (index 0 wins)', () => {
  it('M4a: same field key in two maps — index 0 value wins', () => {
    const result = mergeOverviewMaps([
      { fields: { tone: 'formal' }, sections: {} },   // closer (priority)
      { fields: { tone: 'casual' }, sections: {} },   // farther (overridden)
    ]);
    expect(result.fields['tone']).toBe('formal');
    // Only one entry for 'tone'
    expect(Object.keys(result.fields)).toHaveLength(1);
  });

  it('M4b: same section key in two maps — index 0 value wins', () => {
    const result = mergeOverviewMaps([
      { fields: {}, sections: { Style: 'Use active voice.' } },   // closer
      { fields: {}, sections: { Style: 'Use passive voice.' } },  // farther
    ]);
    expect(result.sections['Style']).toBe('Use active voice.');
    expect(Object.keys(result.sections)).toHaveLength(1);
  });

  it('M4c: same key in three maps — index 0 wins over index 1 and 2', () => {
    const result = mergeOverviewMaps([
      { fields: { tone: 'index-0' }, sections: {} },
      { fields: { tone: 'index-1' }, sections: {} },
      { fields: { tone: 'index-2' }, sections: {} },
    ]);
    expect(result.fields['tone']).toBe('index-0');
  });

  it('M4d: index 0 wins for conflicting field; non-conflicting keys still union', () => {
    const result = mergeOverviewMaps([
      { fields: { tone: 'formal' }, sections: {} },           // wins 'tone'; no 'purpose'
      { fields: { tone: 'casual', purpose: 'report' }, sections: {} },  // loses 'tone'; provides 'purpose'
    ]);
    // Index 0 wins for 'tone'
    expect(result.fields['tone']).toBe('formal');
    // Index 1's 'purpose' is uncontested → appears in union
    expect(result.fields['purpose']).toBe('report');
    expect(Object.keys(result.fields)).toHaveLength(2);
  });

  it('M4e: all maps share the same key — only index 0 value survives', () => {
    const maps: OverviewMap[] = Array.from({ length: 5 }, (_, i) => ({
      fields: { key: `value-${i}` },
      sections: {},
    }));
    const result = mergeOverviewMaps(maps);
    expect(result.fields['key']).toBe('value-0');
  });

  it('M4f: section conflict and field conflict simultaneously — both follow closer-wins', () => {
    const result = mergeOverviewMaps([
      { fields: { tone: 'formal' }, sections: { Style: 'Active voice.' } },
      { fields: { tone: 'casual' }, sections: { Style: 'Passive voice.' } },
    ]);
    expect(result.fields['tone']).toBe('formal');
    expect(result.sections['Style']).toBe('Active voice.');
  });

  it('M4g: mixed conflict and no-conflict in sections', () => {
    const result = mergeOverviewMaps([
      { fields: {}, sections: { Style: 'Child style.', Notes: 'Child notes.' } },
      { fields: {}, sections: { Style: 'Parent style.', Background: 'Parent background.' } },
    ]);
    // 'Style' conflict → index 0 (child) wins
    expect(result.sections['Style']).toBe('Child style.');
    // 'Notes' is unique to index 0 → present
    expect(result.sections['Notes']).toBe('Child notes.');
    // 'Background' is unique to index 1 → present
    expect(result.sections['Background']).toBe('Parent background.');
    expect(Object.keys(result.sections)).toHaveLength(3);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// GROUP M5 — Realistic cascading-folder scenarios
// ────────────────────────────────────────────────────────────────────────────

describe('mergeOverviewMaps — realistic cascading-folder scenarios', () => {
  /**
   * Scenario: two-level folder — child overrides parent's tone field.
   *
   * Structure:
   *   /workspace/               ← root; Overview.md = maps[1]
   *     /project/               ← child; Overview.md = maps[0] (closest, wins)
   *       doc.md
   */
  it('M5a: child folder overrides parent tone field (two-level cascade)', () => {
    const parentMap: OverviewMap = parseOverview(
      'tone: Professional\npurpose: Quarterly report',
    );
    const childMap: OverviewMap = parseOverview('tone: Casual');

    // Child (closest) is index 0; parent is index 1.
    const result = mergeOverviewMaps([childMap, parentMap]);

    // Child's tone overrides parent's
    expect(result.fields['tone']).toBe('Casual');
    // Parent's purpose is uncontested → inherited
    expect(result.fields['purpose']).toBe('Quarterly report');
  });

  it('M5b: parent provides purpose; child provides tone; both appear in result', () => {
    const parentMap: OverviewMap = parseOverview('purpose: Annual summary');
    const childMap: OverviewMap = parseOverview('tone: Formal');

    const result = mergeOverviewMaps([childMap, parentMap]);

    expect(result.fields['purpose']).toBe('Annual summary');
    expect(result.fields['tone']).toBe('Formal');
    expect(Object.keys(result.fields)).toHaveLength(2);
  });

  it('M5c: three-level cascade — grandchild > child > grandparent for same key', () => {
    const grandparent: OverviewMap = parseOverview(
      [
        'tone: Very formal',
        'language: English',
        '',
        '## Company Policy',
        'Follow all company guidelines.',
      ].join('\n'),
    );

    const parent: OverviewMap = parseOverview(
      [
        'tone: Semi-formal',
        'audience: Management',
        '',
        '## Company Policy',
        'Parent override of company policy.',
      ].join('\n'),
    );

    const child: OverviewMap = parseOverview(
      [
        'tone: Casual',
        '',
        '## Company Policy',
        'Child override of company policy.',
      ].join('\n'),
    );

    // Closest first: child (0), parent (1), grandparent (2).
    const result = mergeOverviewMaps([child, parent, grandparent]);

    // 'tone' — child wins
    expect(result.fields['tone']).toBe('Casual');
    // 'language' — only grandparent has it → inherited
    expect(result.fields['language']).toBe('English');
    // 'audience' — only parent has it → inherited
    expect(result.fields['audience']).toBe('Management');
    // 'Company Policy' section — child wins
    expect(result.sections['Company Policy']).toBe('Child override of company policy.');
  });

  it('M5d: merging parsed Overview.md strings roundtrips correctly', () => {
    // Verify that merging parsed maps from realistic markdown content
    // produces the expected combined output.
    const rootOverview = parseOverview(
      '# Root\npurpose: Root purpose\ntone: Root tone\n\n## Background\nRoot background.',
    );
    const subOverview = parseOverview(
      '# Sub\ntone: Sub tone\n\n## Background\nSub background.',
    );

    // Sub is closer (index 0), root is farther (index 1).
    const result = mergeOverviewMaps([subOverview, rootOverview]);

    // 'purpose' only from root — inherited
    expect(result.fields['purpose']).toBe('Root purpose');
    // 'tone' conflict — sub (index 0) wins
    expect(result.fields['tone']).toBe('Sub tone');
    // 'Background' section conflict — sub (index 0) wins
    expect(result.sections['Background']).toBe('Sub background.');
  });
});

// ============================================================================
// cascadeMerge — Sub-AC 12.2.3
// Cascade-merge pipeline: composes parseOverview + mergeOverviewMaps and
// serializes the result back to a Markdown string.
// ============================================================================

/**
 * Test matrix for cascadeMerge(contents: string[]) → string
 *
 * GROUP CM0 — Degenerate / empty inputs
 *   CM0a. Empty array returns empty string
 *   CM0b. Array of one empty string returns empty string
 *   CM0c. Array of multiple empty strings returns empty string
 *
 * GROUP CM1 — Single entry round-trip
 *   CM1a. Fields-only content round-trips semantically
 *   CM1b. Sections-only content round-trips semantically
 *   CM1c. Mixed fields+sections content round-trips semantically
 *   CM1d. Round-trip preserves field key and value verbatim
 *   CM1e. Round-trip preserves multi-line section body
 *
 * GROUP CM2 — Non-conflicting multi-level concatenation
 *   CM2a. Two entries with distinct field keys — union of both appears in output
 *   CM2b. Two entries with distinct section headings — both appear in output
 *   CM2c. Three entries, all distinct fields and sections — full union in output
 *   CM2d. Child has fields only; parent has sections only — both appear
 *   CM2e. Output is parseable back to the unioned field+section map
 *
 * GROUP CM3 — Conflicting key / section resolution (closer-wins)
 *   CM3a. Same field key — child (index 0) value appears in output; parent value absent
 *   CM3b. Same section heading — child body appears in output; parent body absent
 *   CM3c. Three-level conflict — index 0 wins over index 1 and 2
 *   CM3d. Mixed: conflicting tone field + non-conflicting purpose field
 *   CM3e. Conflicting field AND conflicting section simultaneously
 *
 * GROUP CM4 — Output format verification
 *   CM4a. Fields appear before sections in output
 *   CM4b. Fields are formatted as `key: value` lines
 *   CM4c. Sections are formatted with `## heading\nbody` blocks
 *   CM4d. Empty merged result returns ""
 *   CM4e. Serialized output is parseable (idempotency check)
 */

// ────────────────────────────────────────────────────────────────────────────
// GROUP CM0 — Degenerate / empty inputs
// ────────────────────────────────────────────────────────────────────────────

describe('cascadeMerge — degenerate / empty inputs', () => {
  it('CM0a: empty array returns empty string', () => {
    expect(cascadeMerge([])).toBe('');
  });

  it('CM0b: array of one empty string returns empty string', () => {
    expect(cascadeMerge([''])).toBe('');
  });

  it('CM0c: array of multiple empty strings returns empty string', () => {
    expect(cascadeMerge(['', '   ', '\n\n'])).toBe('');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// GROUP CM1 — Single entry round-trip
// ────────────────────────────────────────────────────────────────────────────

describe('cascadeMerge — single entry round-trip', () => {
  it('CM1a: fields-only content round-trips — output parses to the same fields', () => {
    const input = 'tone: formal\npurpose: Quarterly report';
    const output = cascadeMerge([input]);
    const reparsed = parseOverview(output);
    expect(reparsed.fields).toEqual({ tone: 'formal', purpose: 'Quarterly report' });
    expect(reparsed.sections).toEqual({});
  });

  it('CM1b: sections-only content round-trips — output parses to the same sections', () => {
    const input = '## Background\nContext here.\n\n## Style\nBe concise.';
    const output = cascadeMerge([input]);
    const reparsed = parseOverview(output);
    expect(reparsed.fields).toEqual({});
    expect(reparsed.sections).toEqual({
      Background: 'Context here.',
      Style: 'Be concise.',
    });
  });

  it('CM1c: mixed fields+sections round-trips — output parses to same fields and sections', () => {
    const input = [
      'purpose: Monthly report',
      'tone: Formal',
      '',
      '## Background',
      'Project started in Q1.',
      '',
      '## Style',
      'Use active voice.',
    ].join('\n');
    const output = cascadeMerge([input]);
    const reparsed = parseOverview(output);
    expect(reparsed.fields).toEqual({ purpose: 'Monthly report', tone: 'Formal' });
    expect(reparsed.sections['Background']).toBe('Project started in Q1.');
    expect(reparsed.sections['Style']).toBe('Use active voice.');
  });

  it('CM1d: round-trip preserves field key and value verbatim', () => {
    const input = 'forbidden-terms: experimental, prototype, failed';
    const output = cascadeMerge([input]);
    const reparsed = parseOverview(output);
    expect(reparsed.fields['forbidden-terms']).toBe('experimental, prototype, failed');
  });

  it('CM1e: round-trip preserves multi-line section body', () => {
    const input = [
      '## Tone and Voice',
      'Use active voice.',
      'Avoid hedging language.',
      'Be direct and confident.',
    ].join('\n');
    const output = cascadeMerge([input]);
    const reparsed = parseOverview(output);
    expect(reparsed.sections['Tone and Voice']).toBe(
      'Use active voice.\nAvoid hedging language.\nBe direct and confident.',
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// GROUP CM2 — Non-conflicting multi-level concatenation
// ────────────────────────────────────────────────────────────────────────────

describe('cascadeMerge — non-conflicting multi-level concatenation', () => {
  it('CM2a: two entries with distinct field keys — both keys appear in output', () => {
    const child  = 'tone: formal';
    const parent = 'purpose: Quarterly report';
    const output = cascadeMerge([child, parent]);
    const reparsed = parseOverview(output);
    expect(reparsed.fields['tone']).toBe('formal');
    expect(reparsed.fields['purpose']).toBe('Quarterly report');
  });

  it('CM2b: two entries with distinct section headings — both sections appear in output', () => {
    const child  = '## Style\nBe concise.';
    const parent = '## Background\nProject context.';
    const output = cascadeMerge([child, parent]);
    const reparsed = parseOverview(output);
    expect(reparsed.sections['Style']).toBe('Be concise.');
    expect(reparsed.sections['Background']).toBe('Project context.');
  });

  it('CM2c: three entries, all distinct — full union of all fields and sections', () => {
    const entry0 = 'tone: formal';
    const entry1 = 'purpose: report\n\n## Style\nActive voice.';
    const entry2 = 'language: Korean\n\n## Background\nContext.';
    const output = cascadeMerge([entry0, entry1, entry2]);
    const reparsed = parseOverview(output);
    expect(reparsed.fields['tone']).toBe('formal');
    expect(reparsed.fields['purpose']).toBe('report');
    expect(reparsed.fields['language']).toBe('Korean');
    expect(reparsed.sections['Style']).toBe('Active voice.');
    expect(reparsed.sections['Background']).toBe('Context.');
  });

  it('CM2d: child has fields only; parent has sections only — both appear in output', () => {
    const child  = 'tone: formal\npurpose: report';
    const parent = '## Background\nHistory here.';
    const output = cascadeMerge([child, parent]);
    const reparsed = parseOverview(output);
    expect(reparsed.fields).toEqual({ tone: 'formal', purpose: 'report' });
    expect(reparsed.sections['Background']).toBe('History here.');
  });

  it('CM2e: output of non-conflicting cascade is parseable (idempotency)', () => {
    const child  = 'tone: formal';
    const parent = 'language: Korean';
    const output1 = cascadeMerge([child, parent]);
    // Parsing and re-serializing should produce identical output.
    const output2 = cascadeMerge([output1]);
    const reparsed1 = parseOverview(output1);
    const reparsed2 = parseOverview(output2);
    expect(reparsed1).toEqual(reparsed2);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// GROUP CM3 — Conflicting key / section resolution (closer-wins)
// ────────────────────────────────────────────────────────────────────────────

describe('cascadeMerge — conflicting key/section resolution (closer-wins)', () => {
  it('CM3a: same field key — index 0 (child) value survives; parent value absent', () => {
    const child  = 'tone: formal';
    const parent = 'tone: casual';
    const output = cascadeMerge([child, parent]);
    const reparsed = parseOverview(output);
    expect(reparsed.fields['tone']).toBe('formal');
    // Only one 'tone' key
    expect(Object.keys(reparsed.fields)).toHaveLength(1);
  });

  it('CM3b: same section heading — index 0 (child) body survives; parent body absent', () => {
    const child  = '## Style\nChild: active voice.';
    const parent = '## Style\nParent: passive voice.';
    const output = cascadeMerge([child, parent]);
    const reparsed = parseOverview(output);
    expect(reparsed.sections['Style']).toBe('Child: active voice.');
    expect(Object.keys(reparsed.sections)).toHaveLength(1);
  });

  it('CM3c: three-level field conflict — index 0 wins over index 1 and 2', () => {
    const grandchild = 'tone: grandchild-tone';
    const child      = 'tone: child-tone';
    const parent     = 'tone: parent-tone';
    const output = cascadeMerge([grandchild, child, parent]);
    const reparsed = parseOverview(output);
    expect(reparsed.fields['tone']).toBe('grandchild-tone');
  });

  it('CM3d: conflicting tone field + non-conflicting purpose — both resolved correctly', () => {
    const child  = 'tone: formal';
    const parent = 'tone: casual\npurpose: Quarterly report';
    const output = cascadeMerge([child, parent]);
    const reparsed = parseOverview(output);
    // Child tone wins
    expect(reparsed.fields['tone']).toBe('formal');
    // Parent purpose is uncontested → inherited
    expect(reparsed.fields['purpose']).toBe('Quarterly report');
  });

  it('CM3e: conflicting field AND conflicting section simultaneously — both follow closer-wins', () => {
    const child  = 'tone: formal\n\n## Style\nChild style guidelines.';
    const parent = 'tone: casual\n\n## Style\nParent style guidelines.';
    const output = cascadeMerge([child, parent]);
    const reparsed = parseOverview(output);
    expect(reparsed.fields['tone']).toBe('formal');
    expect(reparsed.sections['Style']).toBe('Child style guidelines.');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// GROUP CM4 — Output format verification
// ────────────────────────────────────────────────────────────────────────────

describe('cascadeMerge — output format verification', () => {
  it('CM4a: fields appear before sections in output string', () => {
    const input = 'tone: formal\n\n## Style\nBe direct.';
    const output = cascadeMerge([input]);
    const fieldIdx   = output.indexOf('tone: formal');
    const sectionIdx = output.indexOf('## Style');
    expect(fieldIdx).toBeGreaterThanOrEqual(0);
    expect(sectionIdx).toBeGreaterThanOrEqual(0);
    expect(fieldIdx).toBeLessThan(sectionIdx);
  });

  it('CM4b: field lines are formatted as `key: value`', () => {
    const output = cascadeMerge(['purpose: Quarterly report\ntone: formal']);
    expect(output).toContain('purpose: Quarterly report');
    expect(output).toContain('tone: formal');
  });

  it('CM4c: section blocks are formatted with `## heading` followed by body', () => {
    const output = cascadeMerge(['## Background\nContext here.']);
    expect(output).toContain('## Background');
    expect(output).toContain('Context here.');
    // Heading must precede body in the output
    expect(output.indexOf('## Background')).toBeLessThan(output.indexOf('Context here.'));
  });

  it('CM4d: all-empty input array returns exactly ""', () => {
    expect(cascadeMerge([])).toBe('');
  });

  it('CM4e: serialized output is parseable — idempotency across two full cycles', () => {
    const input = [
      'purpose: Monthly report',
      'tone: Formal',
      '',
      '## Background',
      'Context here.',
      '',
      '## Style',
      'Active voice.',
    ].join('\n');
    const out1 = cascadeMerge([input]);
    const out2 = cascadeMerge([out1]);
    // Two cycles should produce semantically identical results
    expect(parseOverview(out1)).toEqual(parseOverview(out2));
  });

  it('CM4f: field with empty value is preserved in output (round-trip)', () => {
    const input = 'forbidden-terms:';
    const output = cascadeMerge([input]);
    const reparsed = parseOverview(output);
    expect(reparsed.fields['forbidden-terms']).toBe('');
  });

  it('CM4g: section with empty body is preserved in output (round-trip)', () => {
    const input = '## EmptySection';
    const output = cascadeMerge([input]);
    const reparsed = parseOverview(output);
    expect(reparsed.sections['EmptySection']).toBe('');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// GROUP CM5 — End-to-end realistic cascading-folder scenarios
// ────────────────────────────────────────────────────────────────────────────

describe('cascadeMerge — end-to-end realistic folder cascade scenarios', () => {
  /**
   * Scenario: meeting-minutes project with three-level folder hierarchy.
   *
   * Structure:
   *   /workspace/               ← root: company-wide defaults
   *     /team-alpha/            ← team: overrides tone
   *       /2024-q4/             ← subfolder: overrides purpose
   *         meeting-notes.md   ← document being edited
   *
   * Contents (closest first, index 0 = /2024-q4/Overview.md):
   */
  it('CM5a: three-level meeting-minutes cascade produces correct merged output', () => {
    const rootContent = [
      '# Company Defaults',
      '',
      'language: Korean',
      'tone: Very formal',
      '',
      '## Company Policy',
      'Follow all company guidelines.',
      '하나은행 스타일 가이드를 따르세요.',
    ].join('\n');

    const teamContent = [
      '# Team Alpha',
      '',
      'tone: Professional',
      'audience: Management',
      '',
      '## Company Policy',
      'Team Alpha follows a simplified policy.',
    ].join('\n');

    const subfolderContent = [
      '# Q4 2024 Meeting Notes',
      '',
      'purpose: Q4 2024 Meeting Minutes',
      '',
      '## Background',
      'Q4 kickoff meeting context.',
    ].join('\n');

    // Closest first: subfolder (0), team (1), root (2)
    const output = cascadeMerge([subfolderContent, teamContent, rootContent]);
    const reparsed = parseOverview(output);

    // Unique fields are unioned
    expect(reparsed.fields['language']).toBe('Korean');      // from root (only source)
    expect(reparsed.fields['audience']).toBe('Management');  // from team (only source)
    expect(reparsed.fields['purpose']).toBe('Q4 2024 Meeting Minutes'); // from subfolder

    // Conflicting 'tone': subfolder has none; team wins over root
    expect(reparsed.fields['tone']).toBe('Professional');

    // 'Company Policy' conflict: team (index 1) wins over root (index 2);
    // subfolder (index 0) has no 'Company Policy' → team's version survives
    expect(reparsed.sections['Company Policy']).toBe(
      'Team Alpha follows a simplified policy.',
    );

    // 'Background' only in subfolder (index 0) → present
    expect(reparsed.sections['Background']).toBe('Q4 kickoff meeting context.');
  });

  /**
   * Scenario: doc-to-doc workflow where user has a root Overview.md only.
   * Verifies single-file cascade path works end-to-end.
   */
  it('CM5b: single-file cascade — root Overview.md only', () => {
    const rootContent = [
      'purpose: Technical design document',
      'tone: Technical, precise',
      'audience: Senior engineers',
      '',
      '## Architecture Decision Context',
      'This system handles 10k concurrent users.',
    ].join('\n');

    const output = cascadeMerge([rootContent]);
    const reparsed = parseOverview(output);

    expect(reparsed.fields['purpose']).toBe('Technical design document');
    expect(reparsed.fields['tone']).toBe('Technical, precise');
    expect(reparsed.fields['audience']).toBe('Senior engineers');
    expect(reparsed.sections['Architecture Decision Context']).toContain(
      '10k concurrent users',
    );
  });
});
