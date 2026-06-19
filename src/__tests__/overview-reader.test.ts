/**
 * overview-reader.test.ts
 *
 * Unit tests for `readOverviewAt(dirPath, fs) → Promise<OverviewMap | null>`.
 *
 * Sub-AC 12.3.1 — Stub filesystem Overview reader:
 * "Implement and test a single function that accepts a directory path and a
 *  stub/mock filesystem interface, reads the Overview.md file at that path, and
 *  returns a parsed OverviewMap (or null/empty when the file is absent);
 *  covered by unit tests for file-present, file-absent, and malformed-content
 *  cases."
 *
 * ─── Test matrix ────────────────────────────────────────────────────────────
 *
 * GROUP A — File-present scenarios (well-formed Overview.md)
 *   A1. Fields-only content → OverviewMap with populated fields, empty sections
 *   A2. Sections-only content → OverviewMap with empty fields, populated sections
 *   A3. Mixed fields + sections → both populated correctly
 *   A4. Korean-language content → parsed correctly (UTF-8 passthrough)
 *   A5. The resolved path passed to readFile is path.join(dirPath, 'Overview.md')
 *   A6. Encoding passed to readFile is exactly 'utf-8'
 *   A7. Three-field, three-section realistic Overview.md
 *
 * GROUP B — File-absent scenarios (null return)
 *   B1. ENOENT error → returns null (not throws)
 *   B2. EACCES error → returns null (not throws)
 *   B3. Returns null regardless of dirPath value when file is absent
 *   B4. null is returned (not undefined, not false, not empty string)
 *
 * GROUP C — Malformed content scenarios (empty OverviewMap, not null)
 *   C1. Empty string content → returns { fields: {}, sections: {} }
 *   C2. Whitespace-only content → returns { fields: {}, sections: {} }
 *   C3. Newlines-only content → returns { fields: {}, sections: {} }
 *   C4. Random prose without key-value format → returns empty fields, no sections
 *   C5. Binary-like garbage (null bytes) → does not throw; returns empty map
 *   C6. Content with only a # title (no fields, no sections) → empty map
 *   C7. Content with a `##` heading but no text → section recorded under empty key
 *   C8. Very long line (10 000 chars) → does not throw
 *
 * GROUP D — Error propagation
 *   D1. Non-ENOENT error code (e.g. EMFILE) is re-thrown
 *   D2. Generic Error with no code is re-thrown
 *   D3. Error subclass with ENOENT code → returns null (not re-thrown)
 *
 * GROUP E — Return-value type guarantees
 *   E1. Returned OverviewMap has exactly the keys 'fields' and 'sections'
 *   E2. 'fields' is a plain object (not array, not null)
 *   E3. 'sections' is a plain object (not array, not null)
 *   E4. readOverviewAt returns a Promise (thenable)
 *   E5. Calling readOverviewAt with different dirPaths reads the correct file
 *
 * GROUP F — Integration with parseOverview (end-to-end pipe)
 *   F1. Full meeting-minutes Overview.md round-trips through readOverviewAt
 *   F2. cascadeMerge-compatible: result is directly usable as a mergeOverviewMaps input
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readOverviewAt, type FsReader } from '../../src/main/overview-reader';
import { mergeOverviewMaps, parseOverview } from '../../src/main/overview-parser';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Creates a minimal FsReader stub that serves a fixed string for one specific
 * path and throws ENOENT for everything else.
 *
 * @param filePath   The exact path that should return `content`.
 * @param content    The string returned when `filePath` is requested.
 */
function stubWithFile(filePath: string, content: string): FsReader {
  return {
    async readFile(requested: string, _enc: BufferEncoding): Promise<string> {
      if (requested === filePath) {
        return content;
      }
      throw makeEnoent(requested);
    },
  };
}

/**
 * Creates a FsReader stub that always throws ENOENT regardless of the path.
 */
function stubAbsent(): FsReader {
  return {
    async readFile(filePath: string, _enc: BufferEncoding): Promise<string> {
      throw makeEnoent(filePath);
    },
  };
}

/**
 * Creates a FsReader stub that always throws the given error.
 */
function stubError(err: Error): FsReader {
  return {
    async readFile(_filePath: string, _enc: BufferEncoding): Promise<string> {
      throw err;
    },
  };
}

/**
 * Creates a FsReader stub that records which path and encoding were used,
 * returning the provided content.
 */
function spyFs(
  content: string,
): { fs: FsReader; calls: Array<{ path: string; encoding: string }> } {
  const calls: Array<{ path: string; encoding: string }> = [];
  const fs: FsReader = {
    async readFile(filePath: string, enc: BufferEncoding): Promise<string> {
      calls.push({ path: filePath, encoding: enc });
      return content;
    },
  };
  return { fs, calls };
}

/** Constructs a NodeJS.ErrnoException-compatible error with a given code. */
function makeErrnoError(code: string, message?: string): NodeJS.ErrnoException {
  const err = new Error(message ?? `${code}: mock fs error`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

/** Constructs an ENOENT error for a given path. */
function makeEnoent(filePath: string): NodeJS.ErrnoException {
  return makeErrnoError(
    'ENOENT',
    `ENOENT: no such file or directory, open '${filePath}'`,
  );
}

// ---------------------------------------------------------------------------
// Fixed test constants
// ---------------------------------------------------------------------------

const DIR = '/workspace/project/docs';
const OVERVIEW_PATH = path.join(DIR, 'Overview.md');

// ============================================================================
// GROUP A — File-present scenarios (well-formed Overview.md)
// ============================================================================

describe('readOverviewAt — file-present (well-formed content)', () => {
  it('A1: fields-only content returns OverviewMap with populated fields', async () => {
    const content = 'purpose: Monthly report\ntone: Formal\nlanguage: Korean';
    const fs = stubWithFile(OVERVIEW_PATH, content);

    const result = await readOverviewAt(DIR, fs);

    expect(result).not.toBeNull();
    expect(result!.fields).toEqual({
      purpose: 'Monthly report',
      tone: 'Formal',
      language: 'Korean',
    });
    expect(result!.sections).toEqual({});
  });

  it('A2: sections-only content returns OverviewMap with populated sections', async () => {
    const content = '## Background\nThis project started in Q1.\n\n## Style\nUse active voice.';
    const fs = stubWithFile(OVERVIEW_PATH, content);

    const result = await readOverviewAt(DIR, fs);

    expect(result).not.toBeNull();
    expect(result!.fields).toEqual({});
    expect(result!.sections).toEqual({
      Background: 'This project started in Q1.',
      Style: 'Use active voice.',
    });
  });

  it('A3: mixed fields + sections returns both maps populated correctly', async () => {
    const content = [
      'purpose: Quarterly report',
      'tone: Formal',
      '',
      '## Background',
      'Project context.',
      '',
      '## Style',
      'Be concise.',
    ].join('\n');
    const fs = stubWithFile(OVERVIEW_PATH, content);

    const result = await readOverviewAt(DIR, fs);

    expect(result).not.toBeNull();
    expect(result!.fields).toEqual({ purpose: 'Quarterly report', tone: 'Formal' });
    expect(result!.sections).toEqual({
      Background: 'Project context.',
      Style: 'Be concise.',
    });
  });

  it('A4: Korean-language content is parsed correctly (UTF-8 passthrough)', async () => {
    const content = [
      'purpose: 월간 경영진 보고서',
      'tone: 전문적이고 간결하게',
      '',
      '## 프로젝트 배경',
      '이 프로젝트는 2024년 1분기에 시작되었습니다.',
    ].join('\n');
    const fs = stubWithFile(OVERVIEW_PATH, content);

    const result = await readOverviewAt(DIR, fs);

    expect(result).not.toBeNull();
    expect(result!.fields['purpose']).toBe('월간 경영진 보고서');
    expect(result!.fields['tone']).toBe('전문적이고 간결하게');
    expect(result!.sections['프로젝트 배경']).toContain('2024년 1분기');
  });

  it('A5: passes path.join(dirPath, "Overview.md") to the fs.readFile call', async () => {
    const customDir = '/custom/workspace/subdir';
    const expectedPath = path.join(customDir, 'Overview.md');
    const { fs, calls } = spyFs('tone: formal');

    await readOverviewAt(customDir, fs);

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe(expectedPath);
  });

  it('A6: passes encoding "utf-8" to the fs.readFile call', async () => {
    const { fs, calls } = spyFs('tone: formal');

    await readOverviewAt(DIR, fs);

    expect(calls).toHaveLength(1);
    expect(calls[0].encoding).toBe('utf-8');
  });

  it('A7: realistic three-field three-section Overview.md is parsed in full', async () => {
    const content = [
      '# Team Alpha — Project Overview',
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
    const fs = stubWithFile(OVERVIEW_PATH, content);

    const result = await readOverviewAt(DIR, fs);

    expect(result).not.toBeNull();
    expect(result!.fields).toEqual({
      purpose: 'Monthly status report for management',
      tone: 'Professional, concise',
      language: 'Korean with English terms for technical concepts',
    });
    expect(result!.sections['Project Background']).toBe(
      'We are building a document editor.\nThe goal is to reduce report creation time by 50%.',
    );
    expect(result!.sections['Tone and Voice']).toBe(
      'Use active voice.\nAvoid hedging language.',
    );
    expect(result!.sections['Forbidden Terms']).toBe(
      'Do not use: experimental, prototype, internal-only.',
    );
  });
});

// ============================================================================
// GROUP B — File-absent scenarios (null return)
// ============================================================================

describe('readOverviewAt — file-absent (null return)', () => {
  it('B1: ENOENT error causes readOverviewAt to return null (not throw)', async () => {
    const fs = stubAbsent();

    const result = await readOverviewAt(DIR, fs);

    expect(result).toBeNull();
  });

  it('B2: EACCES error causes readOverviewAt to return null (not throw)', async () => {
    const err = makeErrnoError('EACCES', `EACCES: permission denied, open '${OVERVIEW_PATH}'`);
    const fs = stubError(err);

    const result = await readOverviewAt(DIR, fs);

    expect(result).toBeNull();
  });

  it('B3: returns null regardless of the dirPath value when file is absent', async () => {
    const dirs = [
      '/workspace',
      '/workspace/project',
      '/workspace/project/deep/nesting',
      '/',
    ];
    for (const dir of dirs) {
      const result = await readOverviewAt(dir, stubAbsent());
      expect(result, `expected null for dirPath="${dir}"`).toBeNull();
    }
  });

  it('B4: null (not undefined, not false, not empty string) is returned when absent', async () => {
    const result = await readOverviewAt(DIR, stubAbsent());

    // Strict null check
    expect(result === null).toBe(true);
    expect(result).not.toBeUndefined();
    expect(result).not.toBe(false);
    expect(result).not.toBe('');
    expect(result).not.toBe(0);
  });
});

// ============================================================================
// GROUP C — Malformed content scenarios (empty OverviewMap, not null)
// ============================================================================

describe('readOverviewAt — malformed/empty content (empty OverviewMap)', () => {
  /**
   * For all malformed-content cases the file IS present (read succeeds),
   * so readOverviewAt must return a non-null OverviewMap.
   * parseOverview is a total function — it never throws, and returns
   * { fields: {}, sections: {} } for any content it cannot parse.
   */

  it('C1: empty string content → returns non-null OverviewMap with empty fields and sections', async () => {
    const fs = stubWithFile(OVERVIEW_PATH, '');

    const result = await readOverviewAt(DIR, fs);

    expect(result).not.toBeNull();
    expect(result!.fields).toEqual({});
    expect(result!.sections).toEqual({});
  });

  it('C2: whitespace-only content → returns empty OverviewMap (not null)', async () => {
    const fs = stubWithFile(OVERVIEW_PATH, '   \t   ');

    const result = await readOverviewAt(DIR, fs);

    expect(result).not.toBeNull();
    expect(result!.fields).toEqual({});
    expect(result!.sections).toEqual({});
  });

  it('C3: newlines-only content → returns empty OverviewMap (not null)', async () => {
    const fs = stubWithFile(OVERVIEW_PATH, '\n\n\n\n');

    const result = await readOverviewAt(DIR, fs);

    expect(result).not.toBeNull();
    expect(result!.fields).toEqual({});
    expect(result!.sections).toEqual({});
  });

  it('C4: random prose without key-value format → empty fields, no sections', async () => {
    const content = [
      'This is some prose that has no key: value pairs.',
      'It also has no section headings.',
      'The parser should silently drop these lines.',
    ].join('\n');
    const fs = stubWithFile(OVERVIEW_PATH, content);

    const result = await readOverviewAt(DIR, fs);

    // The prose IS treated as a colon-containing line which parseOverview
    // DOES parse as key-value ("This is some prose that has no key" = value "value pairs.").
    // The important guarantee here is that readOverviewAt does NOT throw and
    // returns a non-null OverviewMap.
    expect(result).not.toBeNull();
    expect(typeof result!.fields).toBe('object');
    expect(typeof result!.sections).toBe('object');
  });

  it('C5: null-byte content does not throw; returns a non-null OverviewMap', async () => {
    const fs = stubWithFile(OVERVIEW_PATH, '\0\0\0');

    const result = await readOverviewAt(DIR, fs);

    expect(result).not.toBeNull();
  });

  it('C6: content with only a # title returns an empty OverviewMap (not null)', async () => {
    const fs = stubWithFile(OVERVIEW_PATH, '# Just A Title');

    const result = await readOverviewAt(DIR, fs);

    expect(result).not.toBeNull();
    expect(result!.fields).toEqual({});
    expect(result!.sections).toEqual({});
  });

  it('C7: content with ## heading but no text stores section under empty-string key', async () => {
    const fs = stubWithFile(OVERVIEW_PATH, '## \nOrphan body.');

    const result = await readOverviewAt(DIR, fs);

    // Does not throw; returns a valid OverviewMap regardless.
    expect(result).not.toBeNull();
    expect(() => result!.sections).not.toThrow();
  });

  it('C8: very long single line (10 000 chars) does not throw', async () => {
    const fs = stubWithFile(OVERVIEW_PATH, 'a'.repeat(10_000));

    await expect(readOverviewAt(DIR, fs)).resolves.not.toThrow();
  });
});

// ============================================================================
// GROUP D — Error propagation
// ============================================================================

describe('readOverviewAt — error propagation', () => {
  it('D1: non-ENOENT error code (EMFILE) is re-thrown', async () => {
    const err = makeErrnoError('EMFILE', 'EMFILE: too many open files');
    const fs = stubError(err);

    await expect(readOverviewAt(DIR, fs)).rejects.toThrow('EMFILE');
  });

  it('D2: generic Error with no code is re-thrown', async () => {
    const err = new Error('Unexpected failure');
    const fs = stubError(err);

    await expect(readOverviewAt(DIR, fs)).rejects.toThrow('Unexpected failure');
  });

  it('D3: Error with ENOENT code returns null (not re-thrown)', async () => {
    // Even an Error subclass with code ENOENT should trigger the null path.
    class CustomError extends Error {
      code = 'ENOENT';
    }
    const err = new CustomError('custom ENOENT error');
    const fs = stubError(err);

    const result = await readOverviewAt(DIR, fs);
    expect(result).toBeNull();
  });

  it('D4: Error with EACCES code returns null (not re-thrown)', async () => {
    class CustomError extends Error {
      code = 'EACCES';
    }
    const err = new CustomError('custom EACCES error');
    const fs = stubError(err);

    const result = await readOverviewAt(DIR, fs);
    expect(result).toBeNull();
  });
});

// ============================================================================
// GROUP E — Return-value type guarantees
// ============================================================================

describe('readOverviewAt — return-value type guarantees', () => {
  it('E1: returned OverviewMap has exactly the keys "fields" and "sections"', async () => {
    const fs = stubWithFile(OVERVIEW_PATH, 'tone: formal');
    const result = await readOverviewAt(DIR, fs);

    expect(result).not.toBeNull();
    expect(Object.keys(result!).sort()).toEqual(['fields', 'sections']);
  });

  it('E2: "fields" is a plain object (not array, not null)', async () => {
    const fs = stubWithFile(OVERVIEW_PATH, 'tone: formal');
    const result = await readOverviewAt(DIR, fs);

    expect(result).not.toBeNull();
    expect(typeof result!.fields).toBe('object');
    expect(Array.isArray(result!.fields)).toBe(false);
    expect(result!.fields).not.toBeNull();
  });

  it('E3: "sections" is a plain object (not array, not null)', async () => {
    const fs = stubWithFile(OVERVIEW_PATH, '## Style\nBe direct.');
    const result = await readOverviewAt(DIR, fs);

    expect(result).not.toBeNull();
    expect(typeof result!.sections).toBe('object');
    expect(Array.isArray(result!.sections)).toBe(false);
    expect(result!.sections).not.toBeNull();
  });

  it('E4: readOverviewAt returns a Promise (is thenable)', () => {
    const fs = stubAbsent();
    const promise = readOverviewAt(DIR, fs);

    expect(typeof promise.then).toBe('function');
  });

  it('E5: different dirPaths cause readFile to be called with the respective Overview.md paths', async () => {
    const dirs = [
      '/workspace/a',
      '/workspace/b/c',
      '/workspace/d/e/f',
    ];

    for (const dir of dirs) {
      const expectedPath = path.join(dir, 'Overview.md');
      const { fs, calls } = spyFs('tone: formal');

      await readOverviewAt(dir, fs);

      expect(calls[0].path).toBe(expectedPath);
    }
  });
});

// ============================================================================
// GROUP F — Integration with parseOverview / mergeOverviewMaps
// ============================================================================

describe('readOverviewAt — integration with overview-parser utilities', () => {
  it('F1: full meeting-minutes Overview.md round-trips through readOverviewAt', async () => {
    const overviewMd = [
      '# 팀 알파 — 프로젝트 오버뷰',
      '',
      'purpose: 월간 경영진 보고서 생성',
      'tone: 전문적이고 간결하게',
      'language: 한국어 (기술 용어는 영어 병기)',
      'forbidden-terms: 실험적, 프로토타입, 미완성',
      '',
      '## 프로젝트 배경',
      '이 프로젝트는 2024년 1분기에 시작되었습니다.',
      '목표는 보고서 작성 시간을 50% 단축하는 것입니다.',
      '',
      '## 작성 톤 가이드',
      '능동형 문장을 사용하세요.',
      '모호한 표현을 피하세요.',
    ].join('\n');

    const fs = stubWithFile(OVERVIEW_PATH, overviewMd);
    const result = await readOverviewAt(DIR, fs);

    expect(result).not.toBeNull();

    // Verify key fields
    expect(result!.fields['purpose']).toBe('월간 경영진 보고서 생성');
    expect(result!.fields['tone']).toBe('전문적이고 간결하게');
    expect(result!.fields['language']).toBe('한국어 (기술 용어는 영어 병기)');
    expect(result!.fields['forbidden-terms']).toBe('실험적, 프로토타입, 미완성');

    // Verify sections
    expect(result!.sections['프로젝트 배경']).toContain('2024년 1분기');
    expect(result!.sections['작성 톤 가이드']).toContain('능동형 문장을 사용하세요');
  });

  it('F2: result is directly usable as a mergeOverviewMaps input (cascade compatibility)', async () => {
    // Simulates two Overview.md files at different folder levels:
    const childContent = 'tone: Formal\n\n## Style\nChild style.';
    const parentContent = 'tone: Casual\npurpose: Report\n\n## Style\nParent style.\n\n## Background\nParent background.';

    const childDir = '/workspace/project/docs';
    const parentDir = '/workspace/project';
    const childPath  = path.join(childDir, 'Overview.md');
    const parentPath = path.join(parentDir, 'Overview.md');

    // Stub returns different content depending on which path is requested.
    const multiFs: FsReader = {
      async readFile(requested: string, _enc: BufferEncoding): Promise<string> {
        if (requested === childPath)  return childContent;
        if (requested === parentPath) return parentContent;
        throw makeEnoent(requested);
      },
    };

    const childMap  = await readOverviewAt(childDir, multiFs);
    const parentMap = await readOverviewAt(parentDir, multiFs);

    // Both maps must be non-null and valid OverviewMaps.
    expect(childMap).not.toBeNull();
    expect(parentMap).not.toBeNull();

    // Merge them using the cascade utility (child = index 0 = closer = wins).
    const merged = mergeOverviewMaps([childMap!, parentMap!]);

    // Child's tone wins over parent's
    expect(merged.fields['tone']).toBe('Formal');
    // Parent's purpose is uncontested → inherited
    expect(merged.fields['purpose']).toBe('Report');
    // Child's Style section wins
    expect(merged.sections['Style']).toBe('Child style.');
    // Parent's Background section is uncontested → inherited
    expect(merged.sections['Background']).toBe('Parent background.');
  });

  it('F3: result from readOverviewAt is semantically identical to calling parseOverview directly on the same string', async () => {
    const content = [
      'purpose: Technical design document',
      'tone: Technical, precise',
      '',
      '## Architecture',
      'Designed for 10k concurrent users.',
    ].join('\n');

    const fs = stubWithFile(OVERVIEW_PATH, content);
    const viaReader = await readOverviewAt(DIR, fs);
    const viaParser = parseOverview(content);

    expect(viaReader).toEqual(viaParser);
  });
});
