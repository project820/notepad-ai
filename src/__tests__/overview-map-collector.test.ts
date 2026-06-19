/**
 * overview-map-collector.test.ts
 *
 * Unit tests for `collectOverviewMaps(docPath, workspaceRoot, fs) → Promise<OverviewMap[]>`.
 *
 * Sub-AC 12.3.2 — Traversal-backed OverviewMap collector:
 * "Implement and test a function that accepts a document path and the stub
 *  filesystem reader from Sub-AC 3a, uses the ancestor traversal (AC 12.1) to
 *  walk each ancestor directory, invokes the reader at each level, and returns
 *  an ordered list of non-null OverviewMaps; covered by unit tests for
 *  all-absent, one-present, and multiple-present hierarchy cases."
 *
 * ─── Test matrix ────────────────────────────────────────────────────────────
 *
 * GROUP A — All-absent scenarios (no Overview.md in any ancestor)
 *   A1. Flat workspace, no Overview.md anywhere → []
 *   A2. Two-level nesting, no Overview.md at either level → []
 *   A3. Three-level nesting, no Overview.md at any level → []
 *   A4. FsReader always throws ENOENT → []
 *   A5. FsReader always throws EACCES → []
 *
 * GROUP B — One-present scenarios (exactly one Overview.md in the hierarchy)
 *   B1. Overview.md only at the document's immediate directory (depth 0)
 *   B2. Overview.md only at one ancestor directory (depth 1)
 *   B3. Overview.md only at the workspace root (deepest ancestor)
 *   B4. Three-level nesting, Overview.md only at the workspace root
 *   B5. Single-level workspace (doc lives at root), Overview.md present
 *
 * GROUP C — Multiple-present scenarios (multiple Overview.md files in hierarchy)
 *   C1. Two-level: Overview.md at doc's dir AND workspace root → [closer, root]
 *   C2. Three-level: Overview.md at every level → [depth0, depth1, depth2]
 *   C3. Three-level: Overview.md at depth 0 and depth 2 (skipping depth 1) → [depth0, depth2]
 *   C4. Three-level: Overview.md at depth 1 and depth 2 (skipping depth 0) → [depth1, depth2]
 *   C5. Four-level: all four levels present → ordered closest-first
 *
 * GROUP D — Ordering and content correctness
 *   D1. Closest-first ordering is preserved (index 0 = closest)
 *   D2. OverviewMap content matches the content served by the reader
 *   D3. Fields from different levels are present in separate maps (not merged)
 *   D4. Malformed (empty) Overview.md still appears in result (null vs empty map)
 *
 * GROUP E — Boundary / guard cases
 *   E1. Document outside workspace root → [] immediately
 *   E2. Trailing slash on workspaceRoot is normalised correctly
 *   E3. Document directly inside workspace root (no subdirectory)
 *   E4. workspaceRoot equals docPath's directory
 *   E5. Safety valve: traversal stops at filesystem root (simulated via path.dirname returning same)
 *
 * GROUP F — Reader invocation contract
 *   F1. Reader is called with path.join(dir, 'Overview.md') for each directory
 *   F2. Reader is called in closest-first order (doc dir first)
 *   F3. Reader is called for every ancestor including workspaceRoot
 *   F4. Reader is NOT called for directories above workspaceRoot
 *   F5. Reader receives 'utf-8' encoding (delegated through readOverviewAt)
 *
 * GROUP G — Integration: result is usable by mergeOverviewMaps
 *   G1. Two-level result feeds directly into mergeOverviewMaps (closest wins)
 *   G2. Empty result (all-absent) feeds mergeOverviewMaps as [] → empty merged map
 *   G3. Single-level result feeds mergeOverviewMaps as passthrough
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { collectOverviewMaps, type FsReader } from '../../src/main/overview-map-collector';
import { mergeOverviewMaps, type OverviewMap } from '../../src/main/overview-parser';

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

/**
 * A FsReader that always throws ENOENT regardless of path.
 */
function alwaysAbsentFs(): FsReader {
  return {
    async readFile(filePath: string, _enc: BufferEncoding): Promise<string> {
      throw makeEnoent(filePath);
    },
  };
}

/**
 * A FsReader that always throws EACCES regardless of path.
 */
function alwaysAccessDeniedFs(): FsReader {
  return {
    async readFile(filePath: string, _enc: BufferEncoding): Promise<string> {
      const err = new Error(`EACCES: permission denied, open '${filePath}'`) as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    },
  };
}

/**
 * A spy FsReader that records all (path, encoding) pairs passed to readFile,
 * backed by the given file table.
 */
function spyFs(fileTable: Record<string, string>): {
  fs: FsReader;
  calls: Array<{ path: string; encoding: string }>;
} {
  const calls: Array<{ path: string; encoding: string }> = [];
  const fs: FsReader = {
    async readFile(filePath: string, enc: BufferEncoding): Promise<string> {
      calls.push({ path: filePath, encoding: enc });
      if (Object.prototype.hasOwnProperty.call(fileTable, filePath)) {
        return fileTable[filePath];
      }
      throw makeEnoent(filePath);
    },
  };
  return { fs, calls };
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

/**
 * Returns a stable fake workspace root path (posix-style on this OS).
 * Using absolute paths that won't collide with the real filesystem keeps
 * tests hermetic: the stub FS never touches real files.
 */
const WS = '/ws';

/** Joins workspace root + segments to form an absolute path. */
function wsPath(...segments: string[]): string {
  return path.join(WS, ...segments);
}

/** Overview.md path inside a directory. */
function overviewOf(dirPath: string): string {
  return path.join(dirPath, 'Overview.md');
}

// ============================================================================
// GROUP A — All-absent scenarios
// ============================================================================

describe('collectOverviewMaps — all-absent (no Overview.md in any ancestor)', () => {
  it('A1: flat workspace with no Overview.md returns []', async () => {
    // WS/doc.md — no Overview.md anywhere
    const docPath = wsPath('doc.md');
    const result = await collectOverviewMaps(docPath, WS, alwaysAbsentFs());
    expect(result).toEqual([]);
  });

  it('A2: two-level nesting with no Overview.md at either level returns []', async () => {
    // WS/sub/doc.md — no Overview.md in sub/ or WS/
    const docPath = wsPath('sub', 'doc.md');
    const result = await collectOverviewMaps(docPath, WS, alwaysAbsentFs());
    expect(result).toEqual([]);
  });

  it('A3: three-level nesting with no Overview.md at any level returns []', async () => {
    // WS/a/b/doc.md — no Overview.md in b/, a/, or WS/
    const docPath = wsPath('a', 'b', 'doc.md');
    const result = await collectOverviewMaps(docPath, WS, alwaysAbsentFs());
    expect(result).toEqual([]);
  });

  it('A4: FsReader that always throws ENOENT returns []', async () => {
    const docPath = wsPath('deep', 'nested', 'doc.md');
    const result = await collectOverviewMaps(docPath, WS, alwaysAbsentFs());
    expect(result).toEqual([]);
  });

  it('A5: FsReader that always throws EACCES returns []', async () => {
    const docPath = wsPath('reports', 'doc.md');
    const result = await collectOverviewMaps(docPath, WS, alwaysAccessDeniedFs());
    expect(result).toEqual([]);
  });
});

// ============================================================================
// GROUP B — One-present scenarios
// ============================================================================

describe('collectOverviewMaps — one-present (exactly one Overview.md in the hierarchy)', () => {
  it('B1: Overview.md only at doc\'s immediate directory → [that map]', async () => {
    // WS/sub/doc.md — Overview.md in sub/ only
    const subDir = wsPath('sub');
    const docPath = path.join(subDir, 'doc.md');
    const fs = stubFs({ [overviewOf(subDir)]: 'tone: formal' });

    const result = await collectOverviewMaps(docPath, WS, fs);

    expect(result).toHaveLength(1);
    expect(result[0].fields).toEqual({ tone: 'formal' });
  });

  it('B2: Overview.md only at one ancestor level (depth 1) → [that map]', async () => {
    // WS/a/b/doc.md — Overview.md in a/ only
    const aDir = wsPath('a');
    const bDir = wsPath('a', 'b');
    const docPath = path.join(bDir, 'doc.md');
    const fs = stubFs({ [overviewOf(aDir)]: 'purpose: report' });

    const result = await collectOverviewMaps(docPath, WS, fs);

    expect(result).toHaveLength(1);
    expect(result[0].fields).toEqual({ purpose: 'report' });
  });

  it('B3: Overview.md only at workspace root → [that map]', async () => {
    // WS/sub/doc.md — Overview.md in WS/ only
    const docPath = wsPath('sub', 'doc.md');
    const fs = stubFs({ [overviewOf(WS)]: 'language: Korean' });

    const result = await collectOverviewMaps(docPath, WS, fs);

    expect(result).toHaveLength(1);
    expect(result[0].fields).toEqual({ language: 'Korean' });
  });

  it('B4: three-level nesting, Overview.md only at workspace root → [root map]', async () => {
    // WS/a/b/c/doc.md — Overview.md only in WS/
    const docPath = wsPath('a', 'b', 'c', 'doc.md');
    const fs = stubFs({ [overviewOf(WS)]: 'tone: concise' });

    const result = await collectOverviewMaps(docPath, WS, fs);

    expect(result).toHaveLength(1);
    expect(result[0].fields).toEqual({ tone: 'concise' });
  });

  it('B5: single-level workspace (doc lives at root), Overview.md present → [root map]', async () => {
    // WS/doc.md — workspaceRoot is the same directory as the doc
    const docPath = wsPath('doc.md');
    const fs = stubFs({ [overviewOf(WS)]: 'purpose: notes' });

    const result = await collectOverviewMaps(docPath, WS, fs);

    expect(result).toHaveLength(1);
    expect(result[0].fields).toEqual({ purpose: 'notes' });
  });
});

// ============================================================================
// GROUP C — Multiple-present scenarios
// ============================================================================

describe('collectOverviewMaps — multiple-present (multiple Overview.md files)', () => {
  it('C1: Overview.md at doc dir AND workspace root → [closer, root] (length 2)', async () => {
    // WS/sub/doc.md
    // - Overview.md in sub/ → closer
    // - Overview.md in WS/ → root
    const subDir = wsPath('sub');
    const docPath = path.join(subDir, 'doc.md');
    const fs = stubFs({
      [overviewOf(subDir)]: 'tone: formal',
      [overviewOf(WS)]: 'purpose: report',
    });

    const result = await collectOverviewMaps(docPath, WS, fs);

    expect(result).toHaveLength(2);
    // First element = closest (sub/)
    expect(result[0].fields).toEqual({ tone: 'formal' });
    // Second element = workspace root (WS/)
    expect(result[1].fields).toEqual({ purpose: 'report' });
  });

  it('C2: three-level: Overview.md at every level → [depth0, depth1, depth2]', async () => {
    // WS/a/b/doc.md
    // - WS/a/b/Overview.md (depth 0, closest)
    // - WS/a/Overview.md   (depth 1)
    // - WS/Overview.md     (depth 2, workspace root)
    const bDir = wsPath('a', 'b');
    const aDir = wsPath('a');
    const docPath = path.join(bDir, 'doc.md');
    const fs = stubFs({
      [overviewOf(bDir)]: 'tone: technical',
      [overviewOf(aDir)]: 'tone: formal',
      [overviewOf(WS)]: 'purpose: quarterly-report',
    });

    const result = await collectOverviewMaps(docPath, WS, fs);

    expect(result).toHaveLength(3);
    expect(result[0].fields).toEqual({ tone: 'technical' });    // b/
    expect(result[1].fields).toEqual({ tone: 'formal' });       // a/
    expect(result[2].fields).toEqual({ purpose: 'quarterly-report' }); // WS/
  });

  it('C3: three-level: Overview.md at depth 0 and depth 2, skipping depth 1 → [depth0, depth2]', async () => {
    // WS/a/b/doc.md
    // - WS/a/b/Overview.md (depth 0, present)
    // - WS/a/ (depth 1, absent)
    // - WS/Overview.md     (depth 2, present)
    const bDir = wsPath('a', 'b');
    const docPath = path.join(bDir, 'doc.md');
    const fs = stubFs({
      [overviewOf(bDir)]: 'tone: concise',
      [overviewOf(WS)]: 'language: Korean',
    });

    const result = await collectOverviewMaps(docPath, WS, fs);

    expect(result).toHaveLength(2);
    expect(result[0].fields).toEqual({ tone: 'concise' });
    expect(result[1].fields).toEqual({ language: 'Korean' });
  });

  it('C4: three-level: Overview.md at depth 1 and depth 2, absent at depth 0 → [depth1, depth2]', async () => {
    // WS/a/b/doc.md
    // - WS/a/b/ (depth 0, absent)
    // - WS/a/Overview.md (depth 1, present)
    // - WS/Overview.md   (depth 2, present)
    const bDir = wsPath('a', 'b');
    const aDir = wsPath('a');
    const docPath = path.join(bDir, 'doc.md');
    const fs = stubFs({
      [overviewOf(aDir)]: 'purpose: internal-report',
      [overviewOf(WS)]: 'tone: professional',
    });

    const result = await collectOverviewMaps(docPath, WS, fs);

    expect(result).toHaveLength(2);
    expect(result[0].fields).toEqual({ purpose: 'internal-report' }); // a/
    expect(result[1].fields).toEqual({ tone: 'professional' });        // WS/
  });

  it('C5: four-level workspace: all four levels present → closest-first ordering', async () => {
    // WS/a/b/c/doc.md
    // - WS/a/b/c/Overview.md (depth 0)
    // - WS/a/b/Overview.md   (depth 1)
    // - WS/a/Overview.md     (depth 2)
    // - WS/Overview.md       (depth 3, workspace root)
    const cDir = wsPath('a', 'b', 'c');
    const bDir = wsPath('a', 'b');
    const aDir = wsPath('a');
    const docPath = path.join(cDir, 'doc.md');
    const fs = stubFs({
      [overviewOf(cDir)]: 'tone: c-level',
      [overviewOf(bDir)]: 'tone: b-level',
      [overviewOf(aDir)]: 'tone: a-level',
      [overviewOf(WS)]:   'purpose: root-report',
    });

    const result = await collectOverviewMaps(docPath, WS, fs);

    expect(result).toHaveLength(4);
    expect(result[0].fields['tone']).toBe('c-level');
    expect(result[1].fields['tone']).toBe('b-level');
    expect(result[2].fields['tone']).toBe('a-level');
    expect(result[3].fields['purpose']).toBe('root-report');
  });
});

// ============================================================================
// GROUP D — Ordering and content correctness
// ============================================================================

describe('collectOverviewMaps — ordering and content correctness', () => {
  it('D1: result[0] is always the closest-to-document entry', async () => {
    const subDir = wsPath('project', 'docs');
    const docPath = path.join(subDir, 'report.md');
    const fs = stubFs({
      [overviewOf(subDir)]:              'tone: docs-formal',
      [overviewOf(wsPath('project'))]:   'tone: project-casual',
      [overviewOf(WS)]:                  'purpose: workspace-level',
    });

    const result = await collectOverviewMaps(docPath, WS, fs);

    expect(result).toHaveLength(3);
    expect(result[0].fields['tone']).toBe('docs-formal');        // docs/ (closest)
    expect(result[1].fields['tone']).toBe('project-casual');     // project/
    expect(result[2].fields['purpose']).toBe('workspace-level'); // WS/ (farthest)
  });

  it('D2: OverviewMap fields correctly reflect reader-served content', async () => {
    const subDir = wsPath('reports');
    const docPath = path.join(subDir, 'q3.md');
    const overviewContent = [
      'purpose: Q3 Quarterly Report',
      'tone: Formal and executive-focused',
      'language: Korean with English terms',
      '',
      '## Forbidden Terms',
      'Do not use: prototype, experimental, WIP.',
    ].join('\n');
    const fs = stubFs({ [overviewOf(subDir)]: overviewContent });

    const result = await collectOverviewMaps(docPath, WS, fs);

    expect(result).toHaveLength(1);
    expect(result[0].fields).toEqual({
      purpose: 'Q3 Quarterly Report',
      tone: 'Formal and executive-focused',
      language: 'Korean with English terms',
    });
    expect(result[0].sections['Forbidden Terms']).toBe(
      'Do not use: prototype, experimental, WIP.',
    );
  });

  it('D3: maps at different levels contain their own fields (no premature merge)', async () => {
    const subDir = wsPath('sub');
    const docPath = path.join(subDir, 'doc.md');
    const fs = stubFs({
      [overviewOf(subDir)]: 'tone: formal',
      [overviewOf(WS)]:     'purpose: report',
    });

    const result = await collectOverviewMaps(docPath, WS, fs);

    expect(result).toHaveLength(2);
    // Each map only contains its own keys — merging is the caller's responsibility.
    expect(Object.keys(result[0].fields)).toEqual(['tone']);
    expect(Object.keys(result[1].fields)).toEqual(['purpose']);
  });

  it('D4: empty Overview.md content yields non-null empty map (included in result)', async () => {
    // An empty file is NOT absent — it parses to { fields: {}, sections: {} }.
    // It must appear in the result (not be filtered out).
    const subDir = wsPath('sub');
    const docPath = path.join(subDir, 'doc.md');
    const fs = stubFs({ [overviewOf(subDir)]: '' });

    const result = await collectOverviewMaps(docPath, WS, fs);

    expect(result).toHaveLength(1);
    expect(result[0].fields).toEqual({});
    expect(result[0].sections).toEqual({});
  });
});

// ============================================================================
// GROUP E — Boundary / guard cases
// ============================================================================

describe('collectOverviewMaps — boundary and guard cases', () => {
  it('E1: document outside workspaceRoot returns [] immediately', async () => {
    // /other is completely separate from WS
    const docPath = '/other/project/doc.md';
    const fs = stubFs({
      '/other/project/Overview.md': 'purpose: outside',
    });

    const result = await collectOverviewMaps(docPath, WS, fs);

    expect(result).toEqual([]);
  });

  it('E2: trailing slash on workspaceRoot is normalised correctly', async () => {
    const subDir = wsPath('sub');
    const docPath = path.join(subDir, 'doc.md');
    const fs = stubFs({ [overviewOf(subDir)]: 'tone: formal' });

    // Both with and without trailing slash must behave identically.
    const resultWithSlash    = await collectOverviewMaps(docPath, WS + '/', fs);
    const resultWithoutSlash = await collectOverviewMaps(docPath, WS, fs);

    expect(resultWithSlash).toHaveLength(resultWithoutSlash.length);
    expect(resultWithSlash[0].fields).toEqual(resultWithoutSlash[0].fields);
  });

  it('E3: document directly inside workspace root (no subdirectory) is handled correctly', async () => {
    const docPath = wsPath('doc.md');
    const fs = stubFs({ [overviewOf(WS)]: 'tone: root-level' });

    const result = await collectOverviewMaps(docPath, WS, fs);

    expect(result).toHaveLength(1);
    expect(result[0].fields).toEqual({ tone: 'root-level' });
  });

  it('E4: workspaceRoot equals the document\'s parent directory → checks root once', async () => {
    // Document is inside WS/ and WS/ is the workspace root.
    const docPath = wsPath('doc.md');
    const { fs, calls } = spyFs({ [overviewOf(WS)]: 'tone: minimal' });

    const result = await collectOverviewMaps(docPath, WS, fs);

    // Traversal should check exactly one directory (WS/ itself).
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe(overviewOf(WS));
    expect(result).toHaveLength(1);
  });

  it('E5: docPath not under workspaceRoot returns [] without calling reader', async () => {
    const docPath = '/completely/different/root/doc.md';
    const { fs, calls } = spyFs({});

    const result = await collectOverviewMaps(docPath, WS, fs);

    expect(result).toEqual([]);
    // Guard should prevent any readFile calls.
    expect(calls).toHaveLength(0);
  });
});

// ============================================================================
// GROUP F — Reader invocation contract
// ============================================================================

describe('collectOverviewMaps — reader invocation contract', () => {
  it('F1: reader is called with path.join(dir, "Overview.md") for each directory', async () => {
    // WS/a/b/doc.md → expect calls for b/, a/, WS/
    const bDir = wsPath('a', 'b');
    const aDir = wsPath('a');
    const docPath = path.join(bDir, 'doc.md');
    const { fs, calls } = spyFs({});

    await collectOverviewMaps(docPath, WS, fs);

    const calledPaths = calls.map((c) => c.path);
    expect(calledPaths).toEqual([
      path.join(bDir, 'Overview.md'),
      path.join(aDir, 'Overview.md'),
      path.join(WS, 'Overview.md'),
    ]);
  });

  it('F2: reader is called in closest-first order (doc dir first, workspace root last)', async () => {
    const bDir = wsPath('a', 'b');
    const aDir = wsPath('a');
    const docPath = path.join(bDir, 'doc.md');
    const { fs, calls } = spyFs({});

    await collectOverviewMaps(docPath, WS, fs);

    // Verify ordering of paths in the spy call log.
    expect(calls[0].path).toBe(path.join(bDir, 'Overview.md')); // closest (b/)
    expect(calls[1].path).toBe(path.join(aDir, 'Overview.md')); // mid (a/)
    expect(calls[2].path).toBe(path.join(WS, 'Overview.md'));   // farthest (WS/)
  });

  it('F3: reader is called for every ancestor level including workspaceRoot', async () => {
    const subDir = wsPath('sub');
    const docPath = path.join(subDir, 'doc.md');
    const { fs, calls } = spyFs({});

    await collectOverviewMaps(docPath, WS, fs);

    // Two directories: sub/ and WS/
    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.path === path.join(WS, 'Overview.md'))).toBe(true);
    expect(calls.some((c) => c.path === path.join(subDir, 'Overview.md'))).toBe(true);
  });

  it('F4: reader is NOT called for directories above workspaceRoot', async () => {
    const subDir = wsPath('sub');
    const docPath = path.join(subDir, 'doc.md');
    const { fs, calls } = spyFs({});

    await collectOverviewMaps(docPath, WS, fs);

    const calledPaths = calls.map((c) => c.path);
    // Verify that paths that are ABOVE WS/ (e.g. '/' or '/ws/..' = '/') are not called.
    for (const p of calledPaths) {
      expect(p.startsWith(WS)).toBe(true);
    }
  });

  it('F5: total reader call count equals the number of ancestor directories (inclusive of root)', async () => {
    // WS/a/b/c/doc.md → 4 directories: c/, b/, a/, WS/
    const cDir = wsPath('a', 'b', 'c');
    const docPath = path.join(cDir, 'doc.md');
    const { fs, calls } = spyFs({});

    await collectOverviewMaps(docPath, WS, fs);

    expect(calls).toHaveLength(4);
  });
});

// ============================================================================
// GROUP G — Integration: result feeds into mergeOverviewMaps
// ============================================================================

describe('collectOverviewMaps — integration with mergeOverviewMaps', () => {
  it('G1: two-level result feeds mergeOverviewMaps with closer-wins semantics', async () => {
    // Child (closer) defines 'tone'; parent (WS/) defines 'purpose' + 'tone'.
    // After merge: child's 'tone' wins; parent's 'purpose' is inherited.
    const subDir = wsPath('docs');
    const docPath = path.join(subDir, 'report.md');
    const fs = stubFs({
      [overviewOf(subDir)]: 'tone: formal\n\n## Style\nChild style.',
      [overviewOf(WS)]:     'tone: casual\npurpose: Report\n\n## Style\nParent style.\n\n## Background\nParent background.',
    });

    const maps = await collectOverviewMaps(docPath, WS, fs);
    const merged = mergeOverviewMaps(maps);

    // Child's tone wins.
    expect(merged.fields['tone']).toBe('formal');
    // Parent's purpose is uncontested → inherited.
    expect(merged.fields['purpose']).toBe('Report');
    // Child's Style section wins.
    expect(merged.sections['Style']).toBe('Child style.');
    // Parent's Background section is uncontested → inherited.
    expect(merged.sections['Background']).toBe('Parent background.');
  });

  it('G2: all-absent result feeds mergeOverviewMaps as [] → empty merged map', async () => {
    const docPath = wsPath('doc.md');
    const maps = await collectOverviewMaps(docPath, WS, alwaysAbsentFs());
    const merged = mergeOverviewMaps(maps);

    expect(merged.fields).toEqual({});
    expect(merged.sections).toEqual({});
  });

  it('G3: single-level result feeds mergeOverviewMaps as identity passthrough', async () => {
    const subDir = wsPath('sub');
    const docPath = path.join(subDir, 'doc.md');
    const fs = stubFs({
      [overviewOf(subDir)]: 'purpose: testing\ntone: concise',
    });

    const maps = await collectOverviewMaps(docPath, WS, fs);
    const merged = mergeOverviewMaps(maps);

    expect(merged.fields).toEqual({ purpose: 'testing', tone: 'concise' });
    expect(merged.sections).toEqual({});
  });

  it('G4: Korean-language Overview.md in multi-level hierarchy merges correctly', async () => {
    // Realistic dogfooding scenario: meeting minutes → report
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

    const maps = await collectOverviewMaps(docPath, WS, fs);
    const merged = mergeOverviewMaps(maps);

    // Closer doc's purpose wins over workspace root's purpose.
    expect(merged.fields['purpose']).toBe('3분기 보고서');
    // Workspace root's language is inherited.
    expect(merged.fields['language']).toBe('한국어');
    // Closer doc's tone is included.
    expect(merged.fields['tone']).toBe('전문적이고 간결하게');
    // Sections from both levels.
    expect(merged.sections['금지 표현']).toBe('실험적, 프로토타입, 미완성');
    expect(merged.sections['배경']).toBe('이 조직의 문서 편집 도구입니다.');
  });
});
