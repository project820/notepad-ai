/**
 * overview-resolver.test.ts
 *
 * End-to-end tests for `resolveEffectiveOverview(docPath, workspaceRoot, fs) → Promise<OverviewMap>`.
 *
 * Sub-AC 12.3.3 — Effective-Overview resolver (end-to-end composition):
 * "Implement and test the final public resolveEffectiveOverview(docPath, fs)
 *  function that pipes the collector (Sub-AC 3b) output through mergeOverviewMaps
 *  (AC 12.2) and returns the merged OverviewMap; covered by end-to-end tests
 *  against a mock filesystem for: no Overview at any level returns empty map,
 *  single-level present returns that map verbatim, and multi-level nested folders
 *  return the correctly cascade-merged result."
 *
 * ─── Test matrix ────────────────────────────────────────────────────────────
 *
 * GROUP A — No Overview.md at any level → empty map returned
 *   A1. Flat workspace, no Overview.md → empty map
 *   A2. Two-level nesting, no Overview.md at either level → empty map
 *   A3. Three-level nesting, no Overview.md at any level → empty map
 *   A4. Document outside workspaceRoot → empty map (guard case)
 *   A5. FsReader always throws ENOENT → empty map (never crashes)
 *   A6. FsReader always throws EACCES → empty map (never crashes)
 *
 * GROUP B — Single-level present → verbatim map returned
 *   B1. Overview.md only at doc's immediate directory → fields and sections correct
 *   B2. Overview.md only at workspace root → fields and sections correct
 *   B3. Overview.md only at mid-level ancestor → fields and sections correct
 *   B4. Single-level with complex multi-field Overview.md → all fields preserved
 *   B5. Single-level with sections → sections preserved verbatim
 *   B6. Empty Overview.md content → empty fields and sections (not null)
 *   B7. Whitespace-only Overview.md → empty fields and sections (not null)
 *
 * GROUP C — Multi-level nested folders → cascade-merged result
 *   C1. Two-level: child overrides parent for same field key (closer wins)
 *   C2. Two-level: all-distinct keys → unioned (all keys present)
 *   C3. Two-level: child and parent both define sections → child's section wins
 *   C4. Three-level: all three levels define 'tone' → closest wins (depth 0)
 *   C5. Three-level: fields and sections from different levels are merged correctly
 *   C6. Three-level skip: depth 0 and depth 2 only (depth 1 absent) → two-level merge
 *   C7. Four-level: deepest level wins for conflicts; all others inherited
 *   C8. Korean-language Overview.md files merge correctly (Unicode keys/values)
 *
 * GROUP D — Rollback-safety and robustness
 *   D1. Resolved map is a new object (input maps are never mutated)
 *   D2. Deleting all Overview.md files never crashes — returns empty map
 *   D3. Mixed: some levels have Overview.md, some do not — only present levels contribute
 *   D4. Function is pure per-call — two sequential calls return independent maps
 *   D5. workspaceRoot with trailing slash behaves identically to without
 *
 * GROUP E — Integration / real-world dogfooding scenarios
 *   E1. Meeting-minutes → report: child tone wins over root tone; root language inherited
 *   E2. Multi-source synthesis: three-level hierarchy collapses to correct single map
 *   E3. Forbidden-terms section from closest level overrides parent
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolveEffectiveOverview, type FsReader } from '../../src/main/overview-resolver';

// ============================================================================
// Test infrastructure
// ============================================================================

/**
 * Constructs a FsReader stub backed by an in-memory map of
 * `{ [absoluteOverviewPath]: markdownContent }`.
 *
 * Any path not in the table throws ENOENT.
 */
function stubFs(fileTable: Record<string, string>): FsReader {
  return {
    async readFile(filePath: string, _enc: BufferEncoding): Promise<string> {
      if (Object.prototype.hasOwnProperty.call(fileTable, filePath)) {
        return fileTable[filePath];
      }
      throw makeEnoent(filePath);
    },
  };
}

/** A FsReader that always throws ENOENT regardless of path. */
function alwaysAbsentFs(): FsReader {
  return {
    async readFile(filePath: string, _enc: BufferEncoding): Promise<string> {
      throw makeEnoent(filePath);
    },
  };
}

/** A FsReader that always throws EACCES regardless of path. */
function alwaysAccessDeniedFs(): FsReader {
  return {
    async readFile(filePath: string, _enc: BufferEncoding): Promise<string> {
      const err = new Error(`EACCES: permission denied, open '${filePath}'`) as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    },
  };
}

/** Creates an ENOENT-compatible ErrnoException. */
function makeEnoent(filePath: string): NodeJS.ErrnoException {
  const err = new Error(`ENOENT: no such file or directory, open '${filePath}'`) as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  return err;
}

// ---------------------------------------------------------------------------
// Workspace path helpers
// ---------------------------------------------------------------------------

/** Stable fake workspace root — hermetic, never touches real filesystem. */
const WS = '/ws';

/** Joins workspace root + segments to form an absolute path. */
function wsPath(...segments: string[]): string {
  return path.join(WS, ...segments);
}

/** Overview.md path inside a directory. */
function overviewOf(dirPath: string): string {
  return path.join(dirPath, 'Overview.md');
}

/** Asserts that an OverviewMap is empty (no fields, no sections). */
function expectEmptyMap(map: { fields: Record<string, string>; sections: Record<string, string> }): void {
  expect(map.fields).toEqual({});
  expect(map.sections).toEqual({});
}

// ============================================================================
// GROUP A — No Overview.md at any level → empty map returned
// ============================================================================

describe('resolveEffectiveOverview — no Overview.md at any level returns empty map', () => {
  it('A1: flat workspace with no Overview.md → returns empty map', async () => {
    const docPath = wsPath('doc.md');
    const map = await resolveEffectiveOverview(docPath, WS, alwaysAbsentFs());
    expectEmptyMap(map);
  });

  it('A2: two-level nesting, no Overview.md at either level → returns empty map', async () => {
    const docPath = wsPath('sub', 'doc.md');
    const map = await resolveEffectiveOverview(docPath, WS, alwaysAbsentFs());
    expectEmptyMap(map);
  });

  it('A3: three-level nesting, no Overview.md at any level → returns empty map', async () => {
    const docPath = wsPath('a', 'b', 'doc.md');
    const map = await resolveEffectiveOverview(docPath, WS, alwaysAbsentFs());
    expectEmptyMap(map);
  });

  it('A4: document outside workspaceRoot → returns empty map (guard case, no traversal)', async () => {
    const docPath = '/outside/workspace/doc.md';
    // Provide an Overview.md that would be found if traversal happened (it shouldn't)
    const fs = stubFs({ '/outside/workspace/Overview.md': 'purpose: outside' });
    const map = await resolveEffectiveOverview(docPath, WS, fs);
    expectEmptyMap(map);
  });

  it('A5: FsReader always throws ENOENT → returns empty map without crashing', async () => {
    const docPath = wsPath('deep', 'nested', 'doc.md');
    const map = await resolveEffectiveOverview(docPath, WS, alwaysAbsentFs());
    expectEmptyMap(map);
  });

  it('A6: FsReader always throws EACCES → returns empty map without crashing', async () => {
    const docPath = wsPath('reports', 'doc.md');
    const map = await resolveEffectiveOverview(docPath, WS, alwaysAccessDeniedFs());
    expectEmptyMap(map);
  });
});

// ============================================================================
// GROUP B — Single-level present → verbatim map returned
// ============================================================================

describe('resolveEffectiveOverview — single-level Overview.md returns verbatim map', () => {
  it('B1: Overview.md only at doc\'s immediate directory → correct fields returned', async () => {
    const subDir = wsPath('sub');
    const docPath = path.join(subDir, 'doc.md');
    const fs = stubFs({ [overviewOf(subDir)]: 'tone: formal\npurpose: sub-level report' });

    const map = await resolveEffectiveOverview(docPath, WS, fs);

    expect(map.fields).toEqual({ tone: 'formal', purpose: 'sub-level report' });
    expect(map.sections).toEqual({});
  });

  it('B2: Overview.md only at workspace root → correct fields returned', async () => {
    const docPath = wsPath('sub', 'doc.md');
    const fs = stubFs({ [overviewOf(WS)]: 'language: Korean\npurpose: root-level context' });

    const map = await resolveEffectiveOverview(docPath, WS, fs);

    expect(map.fields).toEqual({ language: 'Korean', purpose: 'root-level context' });
    expect(map.sections).toEqual({});
  });

  it('B3: Overview.md only at mid-level ancestor (depth 1) → correct fields returned', async () => {
    const aDir = wsPath('a');
    const docPath = wsPath('a', 'b', 'doc.md');
    const fs = stubFs({ [overviewOf(aDir)]: 'purpose: mid-level report' });

    const map = await resolveEffectiveOverview(docPath, WS, fs);

    expect(map.fields).toEqual({ purpose: 'mid-level report' });
    expect(map.sections).toEqual({});
  });

  it('B4: single-level Overview.md with multiple fields → all fields preserved', async () => {
    const subDir = wsPath('reports');
    const docPath = path.join(subDir, 'q3.md');
    const fs = stubFs({
      [overviewOf(subDir)]: [
        'purpose: Q3 Quarterly Report',
        'tone: Formal and executive-focused',
        'language: Korean',
        'forbidden-terms: experimental, prototype',
      ].join('\n'),
    });

    const map = await resolveEffectiveOverview(docPath, WS, fs);

    expect(map.fields).toEqual({
      purpose: 'Q3 Quarterly Report',
      tone: 'Formal and executive-focused',
      language: 'Korean',
      'forbidden-terms': 'experimental, prototype',
    });
    expect(map.sections).toEqual({});
  });

  it('B5: single-level Overview.md with sections → sections preserved verbatim', async () => {
    const subDir = wsPath('docs');
    const docPath = path.join(subDir, 'report.md');
    const fs = stubFs({
      [overviewOf(subDir)]: [
        'tone: formal',
        '',
        '## Background',
        'This project started in Q1 2024.',
        '',
        '## Style Guidelines',
        'Use active voice. Avoid passive constructions.',
      ].join('\n'),
    });

    const map = await resolveEffectiveOverview(docPath, WS, fs);

    expect(map.fields).toEqual({ tone: 'formal' });
    expect(map.sections['Background']).toBe('This project started in Q1 2024.');
    expect(map.sections['Style Guidelines']).toBe('Use active voice. Avoid passive constructions.');
  });

  it('B6: empty Overview.md content → returns empty-but-valid map (not null, not crashing)', async () => {
    const subDir = wsPath('sub');
    const docPath = path.join(subDir, 'doc.md');
    const fs = stubFs({ [overviewOf(subDir)]: '' });

    const map = await resolveEffectiveOverview(docPath, WS, fs);

    expectEmptyMap(map);
  });

  it('B7: whitespace-only Overview.md → returns empty-but-valid map', async () => {
    const subDir = wsPath('sub');
    const docPath = path.join(subDir, 'doc.md');
    const fs = stubFs({ [overviewOf(subDir)]: '   \n\n   \n' });

    const map = await resolveEffectiveOverview(docPath, WS, fs);

    expectEmptyMap(map);
  });
});

// ============================================================================
// GROUP C — Multi-level nested folders → cascade-merged result
// ============================================================================

describe('resolveEffectiveOverview — multi-level folders return cascade-merged result', () => {
  it('C1: two-level — child overrides parent for same field key (closer wins)', async () => {
    // child (docs/) defines tone: formal
    // parent (WS/) defines tone: casual, purpose: report
    // Expected: tone=formal (child wins), purpose=report (inherited)
    const docsDir = wsPath('docs');
    const docPath = path.join(docsDir, 'report.md');
    const fs = stubFs({
      [overviewOf(docsDir)]: 'tone: formal',
      [overviewOf(WS)]:      'tone: casual\npurpose: report',
    });

    const map = await resolveEffectiveOverview(docPath, WS, fs);

    expect(map.fields['tone']).toBe('formal');      // child wins
    expect(map.fields['purpose']).toBe('report');   // inherited from parent (uncontested)
    expect(Object.keys(map.fields)).toHaveLength(2);
  });

  it('C2: two-level — all-distinct keys → unioned (all keys present in result)', async () => {
    const subDir = wsPath('sub');
    const docPath = path.join(subDir, 'doc.md');
    const fs = stubFs({
      [overviewOf(subDir)]: 'tone: formal',
      [overviewOf(WS)]:     'purpose: report',
    });

    const map = await resolveEffectiveOverview(docPath, WS, fs);

    expect(map.fields['tone']).toBe('formal');
    expect(map.fields['purpose']).toBe('report');
    expect(Object.keys(map.fields)).toHaveLength(2);
  });

  it('C3: two-level — both define same section heading → child section body wins', async () => {
    const docsDir = wsPath('docs');
    const docPath = path.join(docsDir, 'report.md');
    const fs = stubFs({
      [overviewOf(docsDir)]: '## Style\nChild style: be terse.',
      [overviewOf(WS)]:      '## Style\nParent style: be verbose.\n\n## Background\nRoot background.',
    });

    const map = await resolveEffectiveOverview(docPath, WS, fs);

    // Child's Style section wins
    expect(map.sections['Style']).toBe('Child style: be terse.');
    // Parent's Background section is inherited (uncontested)
    expect(map.sections['Background']).toBe('Root background.');
    expect(Object.keys(map.sections)).toHaveLength(2);
  });

  it('C4: three-level — all three define "tone" → depth 0 (closest) wins', async () => {
    const bDir = wsPath('a', 'b');
    const aDir = wsPath('a');
    const docPath = path.join(bDir, 'doc.md');
    const fs = stubFs({
      [overviewOf(bDir)]: 'tone: depth0-tone',
      [overviewOf(aDir)]: 'tone: depth1-tone',
      [overviewOf(WS)]:   'tone: depth2-tone',
    });

    const map = await resolveEffectiveOverview(docPath, WS, fs);

    // depth 0 (b/) wins
    expect(map.fields['tone']).toBe('depth0-tone');
    expect(Object.keys(map.fields)).toHaveLength(1);
  });

  it('C5: three-level — fields and sections from different levels are merged correctly', async () => {
    // b/ (closest): tone field + Style section
    // a/ (middle):  language field + Background section
    // WS/ (root):   purpose field (no sections)
    const bDir = wsPath('a', 'b');
    const aDir = wsPath('a');
    const docPath = path.join(bDir, 'doc.md');
    const fs = stubFs({
      [overviewOf(bDir)]: 'tone: technical\n\n## Style\nUse precise language.',
      [overviewOf(aDir)]: 'language: English\n\n## Background\nDepartment context.',
      [overviewOf(WS)]:   'purpose: quarterly-report',
    });

    const map = await resolveEffectiveOverview(docPath, WS, fs);

    expect(map.fields['tone']).toBe('technical');
    expect(map.fields['language']).toBe('English');
    expect(map.fields['purpose']).toBe('quarterly-report');
    expect(map.sections['Style']).toBe('Use precise language.');
    expect(map.sections['Background']).toBe('Department context.');
    expect(Object.keys(map.fields)).toHaveLength(3);
    expect(Object.keys(map.sections)).toHaveLength(2);
  });

  it('C6: three-level skip — depth 0 and depth 2 only (depth 1 absent) → two-map merge', async () => {
    // b/ (depth 0): present
    // a/ (depth 1): absent
    // WS/ (depth 2): present
    const bDir = wsPath('a', 'b');
    const docPath = path.join(bDir, 'doc.md');
    const fs = stubFs({
      [overviewOf(bDir)]: 'tone: concise',
      // a/ has no Overview.md
      [overviewOf(WS)]:   'purpose: workspace-level\ntone: verbose',
    });

    const map = await resolveEffectiveOverview(docPath, WS, fs);

    // depth 0 (b/) tone wins over WS/ tone
    expect(map.fields['tone']).toBe('concise');
    // WS/ purpose inherited uncontested
    expect(map.fields['purpose']).toBe('workspace-level');
    expect(Object.keys(map.fields)).toHaveLength(2);
  });

  it('C7: four-level — deepest level wins conflicts; farther levels contribute unique keys', async () => {
    const cDir = wsPath('a', 'b', 'c');
    const bDir = wsPath('a', 'b');
    const aDir = wsPath('a');
    const docPath = path.join(cDir, 'doc.md');
    const fs = stubFs({
      [overviewOf(cDir)]: 'tone: c-tone',
      [overviewOf(bDir)]: 'tone: b-tone\nformat: pdf',
      [overviewOf(aDir)]: 'tone: a-tone\nformat: html\nlanguage: English',
      [overviewOf(WS)]:   'tone: ws-tone\nformat: docx\nlanguage: Korean\npurpose: root-purpose',
    });

    const map = await resolveEffectiveOverview(docPath, WS, fs);

    // c/ (depth 0) wins for 'tone'
    expect(map.fields['tone']).toBe('c-tone');
    // b/ (depth 1) wins for 'format' (c/ doesn't define it)
    expect(map.fields['format']).toBe('pdf');
    // a/ (depth 2) wins for 'language' (c/ and b/ don't define it)
    expect(map.fields['language']).toBe('English');
    // WS/ wins for 'purpose' (only WS/ defines it)
    expect(map.fields['purpose']).toBe('root-purpose');
    expect(Object.keys(map.fields)).toHaveLength(4);
  });

  it('C8: Korean-language Overview.md files merge correctly (Unicode keys/values)', async () => {
    const docsDir = wsPath('팀알파', '보고서');
    const teamDir = wsPath('팀알파');
    const docPath = path.join(docsDir, 'Q3-보고서.md');
    const fs = stubFs({
      [overviewOf(docsDir)]: [
        'purpose: 3분기 보고서',
        'tone: 전문적이고 간결하게',
        '',
        '## 금지 표현',
        '실험적, 프로토타입, 미완성',
      ].join('\n'),
      [overviewOf(WS)]: [
        'purpose: 일반 문서',
        'language: 한국어',
        '',
        '## 배경',
        '이 조직의 문서 편집 도구입니다.',
      ].join('\n'),
    });

    const map = await resolveEffectiveOverview(docPath, WS, fs);

    // Closer docs/ purpose wins over workspace root's purpose
    expect(map.fields['purpose']).toBe('3분기 보고서');
    // Workspace root's language is inherited
    expect(map.fields['language']).toBe('한국어');
    // Closer docs/ tone is included
    expect(map.fields['tone']).toBe('전문적이고 간결하게');
    // Sections from both levels
    expect(map.sections['금지 표현']).toBe('실험적, 프로토타입, 미완성');
    expect(map.sections['배경']).toBe('이 조직의 문서 편집 도구입니다.');
  });
});

// ============================================================================
// GROUP D — Rollback-safety and robustness
// ============================================================================

describe('resolveEffectiveOverview — rollback-safety and robustness', () => {
  it('D1: returned map is a new object (input Overview.md content is not mutated)', async () => {
    const subDir = wsPath('sub');
    const docPath = path.join(subDir, 'doc.md');
    const fs = stubFs({ [overviewOf(subDir)]: 'tone: formal' });

    const mapA = await resolveEffectiveOverview(docPath, WS, fs);
    const mapB = await resolveEffectiveOverview(docPath, WS, fs);

    // Each call returns a fresh object
    expect(mapA).not.toBe(mapB);
    expect(mapA.fields).not.toBe(mapB.fields);
    // But the content is equivalent
    expect(mapA.fields).toEqual(mapB.fields);
  });

  it('D2: deleting all Overview.md files never crashes — returns empty map', async () => {
    // Simulates the case where the user removes all Overview.md files mid-session
    const docPath = wsPath('reports', 'doc.md');
    const map = await resolveEffectiveOverview(docPath, WS, alwaysAbsentFs());
    // Must not throw — must return a clean empty map
    expectEmptyMap(map);
  });

  it('D3: mixed hierarchy — only present levels contribute to the merge', async () => {
    // WS/a/b/doc.md — Overview.md only at WS/, nothing at a/ or b/
    const bDir = wsPath('a', 'b');
    const docPath = path.join(bDir, 'doc.md');
    const fs = stubFs({
      [overviewOf(WS)]: 'purpose: root-only',
    });

    const map = await resolveEffectiveOverview(docPath, WS, fs);

    expect(map.fields['purpose']).toBe('root-only');
    expect(Object.keys(map.fields)).toHaveLength(1);
    expectEmptyMap({ fields: {}, sections: {} }); // sanity check helper
  });

  it('D4: two sequential calls return independent maps (no shared state)', async () => {
    const subDir = wsPath('sub');
    const docPath = path.join(subDir, 'doc.md');
    const fs = stubFs({ [overviewOf(subDir)]: 'tone: formal' });

    const map1 = await resolveEffectiveOverview(docPath, WS, fs);
    // Mutate map1 to verify map2 is independent
    map1.fields['injected'] = 'mutation';

    const map2 = await resolveEffectiveOverview(docPath, WS, fs);

    expect(map2.fields).not.toHaveProperty('injected');
    expect(map2.fields['tone']).toBe('formal');
  });

  it('D5: workspaceRoot with trailing slash behaves identically to without', async () => {
    const subDir = wsPath('sub');
    const docPath = path.join(subDir, 'doc.md');
    const fs = stubFs({
      [overviewOf(subDir)]: 'tone: formal',
      [overviewOf(WS)]:     'purpose: report',
    });

    const mapWithSlash    = await resolveEffectiveOverview(docPath, WS + '/', fs);
    const mapWithoutSlash = await resolveEffectiveOverview(docPath, WS, fs);

    expect(mapWithSlash.fields).toEqual(mapWithoutSlash.fields);
    expect(mapWithSlash.sections).toEqual(mapWithoutSlash.sections);
  });
});

// ============================================================================
// GROUP E — Integration / real-world dogfooding scenarios
// ============================================================================

describe('resolveEffectiveOverview — real-world dogfooding scenarios', () => {
  it('E1: meeting-minutes → report scenario: child tone wins over root tone; root language inherited', async () => {
    // Scenario: Developer writing a quarterly report in /workspace/reports/
    // The reports/ folder has its own Overview.md overriding workspace-wide defaults.
    const reportsDir = wsPath('reports');
    const docPath = path.join(reportsDir, 'Q3-minutes.md');
    const fs = stubFs({
      [overviewOf(reportsDir)]: [
        'purpose: Q3 Report for executives',
        'tone: Formal and precise',
      ].join('\n'),
      [overviewOf(WS)]: [
        'purpose: General workspace documents',
        'tone: Conversational',
        'language: Korean',
        '',
        '## Company Background',
        'Leading technology firm.',
      ].join('\n'),
    });

    const map = await resolveEffectiveOverview(docPath, WS, fs);

    // reports/ wins for 'purpose' and 'tone'
    expect(map.fields['purpose']).toBe('Q3 Report for executives');
    expect(map.fields['tone']).toBe('Formal and precise');
    // root workspace's language is inherited (uncontested)
    expect(map.fields['language']).toBe('Korean');
    // root workspace's Background section is inherited
    expect(map.sections['Company Background']).toBe('Leading technology firm.');
    expect(Object.keys(map.fields)).toHaveLength(3);
    expect(Object.keys(map.sections)).toHaveLength(1);
  });

  it('E2: multi-source synthesis: three-level hierarchy collapses to correct single map', async () => {
    // Scenario: Developer synthesizing multiple documents in /workspace/team/docs/
    // Three-level cascade: docs/ → team/ → workspace root
    const docsDir = wsPath('team', 'docs');
    const teamDir = wsPath('team');
    const docPath = path.join(docsDir, 'synthesis.md');
    const fs = stubFs({
      [overviewOf(docsDir)]: [
        'tone: analytical',
        '',
        '## Source Documents',
        'Refer to meeting-notes.md and spec.md.',
      ].join('\n'),
      [overviewOf(teamDir)]: [
        'purpose: Team Alpha documentation',
        'tone: professional',
        '',
        '## Team Context',
        'Cross-functional team covering product and engineering.',
      ].join('\n'),
      [overviewOf(WS)]: [
        'language: English',
        'purpose: Internal workspace',
        '',
        '## Style Guide',
        'Follow AP style guidelines.',
      ].join('\n'),
    });

    const map = await resolveEffectiveOverview(docPath, WS, fs);

    // docs/ wins for 'tone' (closest)
    expect(map.fields['tone']).toBe('analytical');
    // team/ wins for 'purpose' (docs/ does not define it, team/ is next closest)
    expect(map.fields['purpose']).toBe('Team Alpha documentation');
    // WS/ 'language' is inherited (uncontested)
    expect(map.fields['language']).toBe('English');
    // Each section from its level (no conflicts)
    expect(map.sections['Source Documents']).toBe('Refer to meeting-notes.md and spec.md.');
    expect(map.sections['Team Context']).toBe('Cross-functional team covering product and engineering.');
    expect(map.sections['Style Guide']).toBe('Follow AP style guidelines.');
    expect(Object.keys(map.fields)).toHaveLength(3);
    expect(Object.keys(map.sections)).toHaveLength(3);
  });

  it('E3: forbidden-terms section from closest level overrides parent\'s forbidden-terms', async () => {
    // Scenario: The workspace root has a generic forbidden-terms list, but
    // a specific project folder has a more specialized list that should take priority.
    const projectDir = wsPath('sensitive-project');
    const docPath = path.join(projectDir, 'report.md');
    const fs = stubFs({
      [overviewOf(projectDir)]: [
        'purpose: Sensitive project documentation',
        '',
        '## Forbidden Terms',
        'Do not mention: competitor-names, internal-codenames, project-thunder.',
      ].join('\n'),
      [overviewOf(WS)]: [
        'language: English',
        '',
        '## Forbidden Terms',
        'Do not use: slang, informal language.',
        '',
        '## Background',
        'Enterprise-wide document management system.',
      ].join('\n'),
    });

    const map = await resolveEffectiveOverview(docPath, WS, fs);

    // project-level 'Forbidden Terms' section wins over root
    expect(map.sections['Forbidden Terms']).toBe(
      'Do not mention: competitor-names, internal-codenames, project-thunder.',
    );
    // Root 'Background' section is inherited (uncontested)
    expect(map.sections['Background']).toBe('Enterprise-wide document management system.');
    // Root 'language' is inherited
    expect(map.fields['language']).toBe('English');
    // Project's purpose is included
    expect(map.fields['purpose']).toBe('Sensitive project documentation');
    expect(Object.keys(map.sections)).toHaveLength(2);
  });
});
