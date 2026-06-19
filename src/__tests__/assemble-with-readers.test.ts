/**
 * assemble-with-readers.test.ts
 *
 * Integration tests for the full reader → assembler pipeline.
 *
 * Sub-AC 6.2 requirements:
 *   ✓ `assemblePrompt` returns a structurally valid, non-empty string when called
 *     with any combination of fallback/sentinel inputs produced by the layer readers.
 *   ✓ Tests use mocked FsReader stubs — no real filesystem access.
 *   ✓ Covers: both-fallback, one-fallback/one-real, both-real, empty-file, I/O errors.
 *   ✓ Verified across all four AI surfaces (BlockAI, SideChat, BottomChat, QualityDial).
 *   ✓ Layer ordering is preserved when reader-supplied content feeds assemblePrompt.
 *
 * "Fallback / sentinel inputs" are the values the readers return when files are
 * absent or unreadable:
 *   - readSystemlaw → SYSTEMLAW_DEFAULT   (a non-empty string)
 *   - readOwner     → OWNER_DEFAULT       (a non-empty string)
 *
 * Pipeline under test:
 *   FsReader stub → readSystemlaw / readOwner → assemblePrompt → AssembledPrompt
 *
 * Test groups:
 *   A. Both readers return fallback defaults (files absent)
 *   B. systemlaw real content, owner returns fallback
 *   C. systemlaw fallback, owner real content
 *   D. Both readers return real file content
 *   E. Empty-file sentinel (file present but empty)
 *   F. All four AI surfaces with fallback readers
 *   G. I/O error sentinel — readers throw → fallback → assemblePrompt
 *   H. Reader content + surface-level fields (full pipeline)
 *   I. Return-type structural validity across all combinations
 *   J. Layer ordering preserved through reader integration
 */

import { describe, it, expect } from 'vitest';
import {
  readSystemlaw,
  SYSTEMLAW_DEFAULT,
  type FsReader as SystemlawFsReader,
} from '../../src/main/prompts/read-systemlaw';
import {
  readOwner,
  OWNER_DEFAULT,
  type FsReader as OwnerFsReader,
} from '../../src/main/prompts/read-owner';
import {
  assemblePrompt,
  type AssemblyRequest,
  type AssembledPrompt,
} from '../../src/main/prompts/assemble';
import type { AISurface } from '../../src/main/prompts/resolve';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Stub factory helpers
// ---------------------------------------------------------------------------

const USER_DATA = '/home/user/.config/notepad-ai';
const SYSTEMLAW_PATH = path.join(USER_DATA, 'systemlaw.md');
const OWNER_PATH = path.join(USER_DATA, 'Owner.md');

/**
 * FsReader stub that returns `content` when the exact path matches,
 * and throws ENOENT for any other path.
 */
function stubFile<T extends SystemlawFsReader | OwnerFsReader>(
  filePath: string,
  content: string,
): T {
  return {
    async readFile(requested: string, _enc: BufferEncoding): Promise<string> {
      if (requested === filePath) return content;
      const err = new Error(
        `ENOENT: no such file or directory, open '${requested}'`,
      ) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    },
  } as unknown as T;
}

/**
 * FsReader stub that always throws ENOENT — simulates absent file.
 */
function stubAbsent<T extends SystemlawFsReader | OwnerFsReader>(): T {
  return {
    async readFile(filePath: string, _enc: BufferEncoding): Promise<string> {
      const err = new Error(
        `ENOENT: no such file or directory, open '${filePath}'`,
      ) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    },
  } as unknown as T;
}

/**
 * FsReader stub that throws the given error (for I/O error scenarios).
 */
function stubError<T extends SystemlawFsReader | OwnerFsReader>(err: Error): T {
  return {
    async readFile(): Promise<string> {
      throw err;
    },
  } as unknown as T;
}

/** Build a NodeJS.ErrnoException with the given code. */
function makeErrnoError(code: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: mock I/O error`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

// ---------------------------------------------------------------------------
// Fixture content — real (non-default) file content
// ---------------------------------------------------------------------------

const REAL_SYSTEMLAW = `# Custom AI Conduct Rules
- Always respond in Korean for Korean documents.
- Be extremely concise.
- Never invent facts.`;

const REAL_OWNER = `# Owner Profile
Name: 김동인
Role: Senior Technical Writer
Context: I primarily write government-grade reports in Korean.`;

const SURFACE_PROMPT = '## Surface\nYou are a professional editing assistant specialised in Korean.';
const QUALITY_DIRECTIVE = '## Quality\nWrite at a professional government reading level.';
const DOCUMENT_TEXT = '## Document\n# Quarterly Report\nQ1 results show 15% growth.';
const USER_INSTRUCTION = '## Instruction\nSummarise this document in three bullet points.';

// ---------------------------------------------------------------------------
// Helper: assert A appears before B in `text`
// ---------------------------------------------------------------------------

function assertOrder(text: string, earlier: string, later: string): void {
  const idxA = text.indexOf(earlier);
  const idxB = text.indexOf(later);
  expect(idxA).toBeGreaterThanOrEqual(0);
  expect(idxB).toBeGreaterThanOrEqual(0);
  expect(idxA).toBeLessThan(idxB);
}

// ===========================================================================
// A. Both readers return fallback defaults (files absent)
// ===========================================================================

describe('A. Both readers return fallback defaults — files absent', () => {
  it('A1. readSystemlaw returns SYSTEMLAW_DEFAULT when file is absent', async () => {
    const sl = await readSystemlaw(USER_DATA, stubAbsent<SystemlawFsReader>());
    expect(sl).toBe(SYSTEMLAW_DEFAULT);
  });

  it('A2. readOwner returns OWNER_DEFAULT when file is absent', async () => {
    const owner = await readOwner(USER_DATA, stubAbsent<OwnerFsReader>());
    expect(owner).toBe(OWNER_DEFAULT);
  });

  it('A3. assemblePrompt with both defaults is a string', async () => {
    const sl = await readSystemlaw(USER_DATA, stubAbsent<SystemlawFsReader>());
    const owner = await readOwner(USER_DATA, stubAbsent<OwnerFsReader>());
    const result: AssembledPrompt = assemblePrompt({
      surface: 'BlockAI',
      systemlawContent: sl,
      ownerContent: owner,
    });
    expect(typeof result).toBe('string');
  });

  it('A4. assemblePrompt with both defaults is non-empty', async () => {
    const sl = await readSystemlaw(USER_DATA, stubAbsent<SystemlawFsReader>());
    const owner = await readOwner(USER_DATA, stubAbsent<OwnerFsReader>());
    const result = assemblePrompt({
      surface: 'BlockAI',
      systemlawContent: sl,
      ownerContent: owner,
    });
    expect(result.trim().length).toBeGreaterThan(0);
  });

  it('A5. assembled output contains SYSTEMLAW_DEFAULT text', async () => {
    const sl = await readSystemlaw(USER_DATA, stubAbsent<SystemlawFsReader>());
    const owner = await readOwner(USER_DATA, stubAbsent<OwnerFsReader>());
    const result = assemblePrompt({
      surface: 'SideChat',
      systemlawContent: sl,
      ownerContent: owner,
    });
    // SYSTEMLAW_DEFAULT is a multi-line string — check a distinctive substring
    expect(result).toContain('AI Conduct Rules');
  });

  it('A6. assembled output contains OWNER_DEFAULT text', async () => {
    const sl = await readSystemlaw(USER_DATA, stubAbsent<SystemlawFsReader>());
    const owner = await readOwner(USER_DATA, stubAbsent<OwnerFsReader>());
    const result = assemblePrompt({
      surface: 'SideChat',
      systemlawContent: sl,
      ownerContent: owner,
    });
    // OWNER_DEFAULT contains "About the Author"
    expect(result).toContain('About the Author');
  });

  it('A7. SYSTEMLAW_DEFAULT content appears before OWNER_DEFAULT in assembled output', async () => {
    const sl = await readSystemlaw(USER_DATA, stubAbsent<SystemlawFsReader>());
    const owner = await readOwner(USER_DATA, stubAbsent<OwnerFsReader>());
    const result = assemblePrompt({
      surface: 'BlockAI',
      systemlawContent: sl,
      ownerContent: owner,
    });
    // systemlaw (layer 0) must appear before owner (layer 1)
    assertOrder(result, SYSTEMLAW_DEFAULT, OWNER_DEFAULT);
  });

  it('A8. result is not null or undefined with both fallback defaults', async () => {
    const sl = await readSystemlaw(USER_DATA, stubAbsent<SystemlawFsReader>());
    const owner = await readOwner(USER_DATA, stubAbsent<OwnerFsReader>());
    const result = assemblePrompt({
      surface: 'BottomChat',
      systemlawContent: sl,
      ownerContent: owner,
    });
    expect(result).not.toBeNull();
    expect(result).not.toBeUndefined();
  });

  it('A9. result equals SYSTEMLAW_DEFAULT + \\n\\n + OWNER_DEFAULT', async () => {
    const sl = await readSystemlaw(USER_DATA, stubAbsent<SystemlawFsReader>());
    const owner = await readOwner(USER_DATA, stubAbsent<OwnerFsReader>());
    const result = assemblePrompt({
      surface: 'QualityDial',
      systemlawContent: sl,
      ownerContent: owner,
    });
    expect(result).toBe(`${SYSTEMLAW_DEFAULT}\n\n${OWNER_DEFAULT}`);
  });
});

// ===========================================================================
// B. systemlaw returns real content, owner returns fallback
// ===========================================================================

describe('B. systemlaw real content, owner returns fallback', () => {
  it('B1. assemblePrompt result is non-empty', async () => {
    const sl = await readSystemlaw(
      USER_DATA,
      stubFile<SystemlawFsReader>(SYSTEMLAW_PATH, REAL_SYSTEMLAW),
    );
    const owner = await readOwner(USER_DATA, stubAbsent<OwnerFsReader>());

    const result = assemblePrompt({
      surface: 'BlockAI',
      systemlawContent: sl,
      ownerContent: owner,
    });

    expect(result.trim().length).toBeGreaterThan(0);
  });

  it('B2. assembled output contains real systemlaw content', async () => {
    const sl = await readSystemlaw(
      USER_DATA,
      stubFile<SystemlawFsReader>(SYSTEMLAW_PATH, REAL_SYSTEMLAW),
    );
    const owner = await readOwner(USER_DATA, stubAbsent<OwnerFsReader>());

    const result = assemblePrompt({
      surface: 'SideChat',
      systemlawContent: sl,
      ownerContent: owner,
    });

    expect(result).toContain(REAL_SYSTEMLAW);
  });

  it('B3. assembled output contains OWNER_DEFAULT (the owner fallback)', async () => {
    const sl = await readSystemlaw(
      USER_DATA,
      stubFile<SystemlawFsReader>(SYSTEMLAW_PATH, REAL_SYSTEMLAW),
    );
    const owner = await readOwner(USER_DATA, stubAbsent<OwnerFsReader>());

    const result = assemblePrompt({
      surface: 'SideChat',
      systemlawContent: sl,
      ownerContent: owner,
    });

    expect(result).toContain(OWNER_DEFAULT);
  });

  it('B4. real systemlaw appears before OWNER_DEFAULT (layer ordering preserved)', async () => {
    const sl = await readSystemlaw(
      USER_DATA,
      stubFile<SystemlawFsReader>(SYSTEMLAW_PATH, REAL_SYSTEMLAW),
    );
    const owner = await readOwner(USER_DATA, stubAbsent<OwnerFsReader>());

    const result = assemblePrompt({
      surface: 'BlockAI',
      systemlawContent: sl,
      ownerContent: owner,
    });

    assertOrder(result, REAL_SYSTEMLAW, OWNER_DEFAULT);
  });

  it('B5. does not contain SYSTEMLAW_DEFAULT (real file overrides fallback)', async () => {
    const sl = await readSystemlaw(
      USER_DATA,
      stubFile<SystemlawFsReader>(SYSTEMLAW_PATH, REAL_SYSTEMLAW),
    );
    const owner = await readOwner(USER_DATA, stubAbsent<OwnerFsReader>());

    const result = assemblePrompt({
      surface: 'BottomChat',
      systemlawContent: sl,
      ownerContent: owner,
    });

    // Real content was used; the default should not appear
    expect(result).not.toContain(SYSTEMLAW_DEFAULT);
  });
});

// ===========================================================================
// C. systemlaw fallback, owner real content
// ===========================================================================

describe('C. systemlaw fallback, owner real content', () => {
  it('C1. assemblePrompt result is non-empty', async () => {
    const sl = await readSystemlaw(USER_DATA, stubAbsent<SystemlawFsReader>());
    const owner = await readOwner(
      USER_DATA,
      stubFile<OwnerFsReader>(OWNER_PATH, REAL_OWNER),
    );

    const result = assemblePrompt({
      surface: 'BlockAI',
      systemlawContent: sl,
      ownerContent: owner,
    });

    expect(result.trim().length).toBeGreaterThan(0);
  });

  it('C2. assembled output contains SYSTEMLAW_DEFAULT', async () => {
    const sl = await readSystemlaw(USER_DATA, stubAbsent<SystemlawFsReader>());
    const owner = await readOwner(
      USER_DATA,
      stubFile<OwnerFsReader>(OWNER_PATH, REAL_OWNER),
    );

    const result = assemblePrompt({
      surface: 'SideChat',
      systemlawContent: sl,
      ownerContent: owner,
    });

    expect(result).toContain(SYSTEMLAW_DEFAULT);
  });

  it('C3. assembled output contains real owner content', async () => {
    const sl = await readSystemlaw(USER_DATA, stubAbsent<SystemlawFsReader>());
    const owner = await readOwner(
      USER_DATA,
      stubFile<OwnerFsReader>(OWNER_PATH, REAL_OWNER),
    );

    const result = assemblePrompt({
      surface: 'SideChat',
      systemlawContent: sl,
      ownerContent: owner,
    });

    expect(result).toContain(REAL_OWNER);
  });

  it('C4. SYSTEMLAW_DEFAULT appears before real owner content (layer ordering)', async () => {
    const sl = await readSystemlaw(USER_DATA, stubAbsent<SystemlawFsReader>());
    const owner = await readOwner(
      USER_DATA,
      stubFile<OwnerFsReader>(OWNER_PATH, REAL_OWNER),
    );

    const result = assemblePrompt({
      surface: 'BottomChat',
      systemlawContent: sl,
      ownerContent: owner,
    });

    assertOrder(result, SYSTEMLAW_DEFAULT, REAL_OWNER);
  });

  it('C5. does not contain OWNER_DEFAULT (real file overrides fallback)', async () => {
    const sl = await readSystemlaw(USER_DATA, stubAbsent<SystemlawFsReader>());
    const owner = await readOwner(
      USER_DATA,
      stubFile<OwnerFsReader>(OWNER_PATH, REAL_OWNER),
    );

    const result = assemblePrompt({
      surface: 'QualityDial',
      systemlawContent: sl,
      ownerContent: owner,
    });

    expect(result).not.toContain(OWNER_DEFAULT);
  });
});

// ===========================================================================
// D. Both readers return real file content
// ===========================================================================

describe('D. Both readers return real file content', () => {
  it('D1. assemblePrompt result is non-empty', async () => {
    const sl = await readSystemlaw(
      USER_DATA,
      stubFile<SystemlawFsReader>(SYSTEMLAW_PATH, REAL_SYSTEMLAW),
    );
    const owner = await readOwner(
      USER_DATA,
      stubFile<OwnerFsReader>(OWNER_PATH, REAL_OWNER),
    );

    const result = assemblePrompt({
      surface: 'BlockAI',
      systemlawContent: sl,
      ownerContent: owner,
    });

    expect(result.trim().length).toBeGreaterThan(0);
  });

  it('D2. assembled output contains real systemlaw content', async () => {
    const sl = await readSystemlaw(
      USER_DATA,
      stubFile<SystemlawFsReader>(SYSTEMLAW_PATH, REAL_SYSTEMLAW),
    );
    const owner = await readOwner(
      USER_DATA,
      stubFile<OwnerFsReader>(OWNER_PATH, REAL_OWNER),
    );

    const result = assemblePrompt({
      surface: 'SideChat',
      systemlawContent: sl,
      ownerContent: owner,
    });

    expect(result).toContain(REAL_SYSTEMLAW);
  });

  it('D3. assembled output contains real owner content', async () => {
    const sl = await readSystemlaw(
      USER_DATA,
      stubFile<SystemlawFsReader>(SYSTEMLAW_PATH, REAL_SYSTEMLAW),
    );
    const owner = await readOwner(
      USER_DATA,
      stubFile<OwnerFsReader>(OWNER_PATH, REAL_OWNER),
    );

    const result = assemblePrompt({
      surface: 'SideChat',
      systemlawContent: sl,
      ownerContent: owner,
    });

    expect(result).toContain(REAL_OWNER);
  });

  it('D4. real systemlaw appears before real owner content (layer 0 < layer 1)', async () => {
    const sl = await readSystemlaw(
      USER_DATA,
      stubFile<SystemlawFsReader>(SYSTEMLAW_PATH, REAL_SYSTEMLAW),
    );
    const owner = await readOwner(
      USER_DATA,
      stubFile<OwnerFsReader>(OWNER_PATH, REAL_OWNER),
    );

    const result = assemblePrompt({
      surface: 'BlockAI',
      systemlawContent: sl,
      ownerContent: owner,
    });

    assertOrder(result, REAL_SYSTEMLAW, REAL_OWNER);
  });

  it('D5. neither default value appears when both real files are present', async () => {
    const sl = await readSystemlaw(
      USER_DATA,
      stubFile<SystemlawFsReader>(SYSTEMLAW_PATH, REAL_SYSTEMLAW),
    );
    const owner = await readOwner(
      USER_DATA,
      stubFile<OwnerFsReader>(OWNER_PATH, REAL_OWNER),
    );

    const result = assemblePrompt({
      surface: 'BottomChat',
      systemlawContent: sl,
      ownerContent: owner,
    });

    // Neither default should be present — the real files replaced them
    expect(result).not.toContain(SYSTEMLAW_DEFAULT);
    expect(result).not.toContain(OWNER_DEFAULT);
  });

  it('D6. assembled output equals real systemlaw + \\n\\n + real owner', async () => {
    const sl = await readSystemlaw(
      USER_DATA,
      stubFile<SystemlawFsReader>(SYSTEMLAW_PATH, REAL_SYSTEMLAW),
    );
    const owner = await readOwner(
      USER_DATA,
      stubFile<OwnerFsReader>(OWNER_PATH, REAL_OWNER),
    );

    const result = assemblePrompt({
      surface: 'QualityDial',
      systemlawContent: sl,
      ownerContent: owner,
    });

    expect(result).toBe(`${REAL_SYSTEMLAW}\n\n${REAL_OWNER}`);
  });
});

// ===========================================================================
// E. Empty-file sentinel — file present but empty
// ===========================================================================

describe('E. Empty-file sentinel — file present but content is empty string', () => {
  it('E1. systemlaw empty file + owner fallback → non-empty (owner default contributes)', async () => {
    // The user explicitly emptied systemlaw.md — readSystemlaw returns ''.
    // Owner.md is absent — readOwner returns OWNER_DEFAULT.
    const sl = await readSystemlaw(
      USER_DATA,
      stubFile<SystemlawFsReader>(SYSTEMLAW_PATH, ''),
    );
    const owner = await readOwner(USER_DATA, stubAbsent<OwnerFsReader>());

    // sl is '' — the empty file content (not the default)
    expect(sl).toBe('');

    const result = assemblePrompt({
      surface: 'BlockAI',
      systemlawContent: sl,
      ownerContent: owner,
    });

    // Result should be non-empty — OWNER_DEFAULT fills it
    expect(result.trim().length).toBeGreaterThan(0);
    expect(result).toContain(OWNER_DEFAULT);
  });

  it('E2. systemlaw fallback + owner empty file → non-empty (systemlaw default contributes)', async () => {
    const sl = await readSystemlaw(USER_DATA, stubAbsent<SystemlawFsReader>());
    const owner = await readOwner(
      USER_DATA,
      stubFile<OwnerFsReader>(OWNER_PATH, ''),
    );

    expect(owner).toBe('');

    const result = assemblePrompt({
      surface: 'SideChat',
      systemlawContent: sl,
      ownerContent: owner,
    });

    expect(result.trim().length).toBeGreaterThan(0);
    expect(result).toContain(SYSTEMLAW_DEFAULT);
  });

  it('E3. both readers return empty string → surface prompt keeps result non-empty', async () => {
    const sl = await readSystemlaw(
      USER_DATA,
      stubFile<SystemlawFsReader>(SYSTEMLAW_PATH, ''),
    );
    const owner = await readOwner(
      USER_DATA,
      stubFile<OwnerFsReader>(OWNER_PATH, ''),
    );

    const result = assemblePrompt({
      surface: 'BottomChat',
      systemlawContent: sl,
      ownerContent: owner,
      surfacePrompt: SURFACE_PROMPT,
    });

    // systemlaw and owner are empty; surface prompt keeps it non-empty
    expect(result.trim().length).toBeGreaterThan(0);
    expect(result).toContain(SURFACE_PROMPT);
  });

  it('E4. whitespace-only systemlaw file is excluded from output (silently dropped)', async () => {
    const sl = await readSystemlaw(
      USER_DATA,
      stubFile<SystemlawFsReader>(SYSTEMLAW_PATH, '   \n\n  '),
    );
    const owner = await readOwner(USER_DATA, stubAbsent<OwnerFsReader>());

    const result = assemblePrompt({
      surface: 'BlockAI',
      systemlawContent: sl,
      ownerContent: owner,
    });

    // Whitespace systemlaw is dropped; OWNER_DEFAULT remains
    expect(result.trim().length).toBeGreaterThan(0);
    expect(result.trim()).toBe(OWNER_DEFAULT.trim());
  });

  it('E5. empty systemlaw + empty owner + user instruction → non-empty (instruction contributes)', async () => {
    const sl = await readSystemlaw(
      USER_DATA,
      stubFile<SystemlawFsReader>(SYSTEMLAW_PATH, ''),
    );
    const owner = await readOwner(
      USER_DATA,
      stubFile<OwnerFsReader>(OWNER_PATH, ''),
    );

    const result = assemblePrompt({
      surface: 'QualityDial',
      systemlawContent: sl,
      ownerContent: owner,
      userInstruction: USER_INSTRUCTION,
    });

    expect(result.trim().length).toBeGreaterThan(0);
    expect(result).toBe(USER_INSTRUCTION);
  });
});

// ===========================================================================
// F. All four AI surfaces with fallback readers
// ===========================================================================

describe('F. All four AI surfaces — fallback readers produce non-empty output', () => {
  const surfaces: AISurface[] = ['BlockAI', 'SideChat', 'BottomChat', 'QualityDial'];

  for (const surface of surfaces) {
    it(`F-${surface}. ${surface} with both readers absent → non-empty assembled output`, async () => {
      const sl = await readSystemlaw(USER_DATA, stubAbsent<SystemlawFsReader>());
      const owner = await readOwner(USER_DATA, stubAbsent<OwnerFsReader>());

      const result = assemblePrompt({
        surface,
        systemlawContent: sl,
        ownerContent: owner,
      });

      expect(typeof result).toBe('string');
      expect(result.trim().length).toBeGreaterThan(0);
    });
  }

  it('F5. all four surfaces produce identical output for identical reader content', async () => {
    const sl = await readSystemlaw(USER_DATA, stubAbsent<SystemlawFsReader>());
    const owner = await readOwner(USER_DATA, stubAbsent<OwnerFsReader>());

    const results = surfaces.map((surface) =>
      assemblePrompt({ surface, systemlawContent: sl, ownerContent: owner }),
    );

    // All four surfaces should produce the same assembled string (Phase 1 — no
    // surface-specific logic affects reader-sourced global layers).
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toBe(results[0]);
    }
  });

  it('F6. all four surfaces with real file content are non-empty', async () => {
    const sl = await readSystemlaw(
      USER_DATA,
      stubFile<SystemlawFsReader>(SYSTEMLAW_PATH, REAL_SYSTEMLAW),
    );
    const owner = await readOwner(
      USER_DATA,
      stubFile<OwnerFsReader>(OWNER_PATH, REAL_OWNER),
    );

    for (const surface of surfaces) {
      const result = assemblePrompt({
        surface,
        systemlawContent: sl,
        ownerContent: owner,
      });
      expect(result.trim().length).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// G. I/O error sentinel — readers throw → fallback → assemblePrompt
// ===========================================================================

describe('G. I/O error sentinel — reader fallback path integrates correctly', () => {
  it('G1. ENOENT on systemlaw → SYSTEMLAW_DEFAULT → assemblePrompt non-empty', async () => {
    const sl = await readSystemlaw(
      USER_DATA,
      stubError<SystemlawFsReader>(makeErrnoError('ENOENT')),
    );
    const owner = await readOwner(USER_DATA, stubAbsent<OwnerFsReader>());

    expect(sl).toBe(SYSTEMLAW_DEFAULT);

    const result = assemblePrompt({
      surface: 'BlockAI',
      systemlawContent: sl,
      ownerContent: owner,
    });

    expect(result.trim().length).toBeGreaterThan(0);
  });

  it('G2. EACCES on owner → OWNER_DEFAULT → assemblePrompt non-empty', async () => {
    const sl = await readSystemlaw(USER_DATA, stubAbsent<SystemlawFsReader>());
    const owner = await readOwner(
      USER_DATA,
      stubError<OwnerFsReader>(makeErrnoError('EACCES')),
    );

    expect(owner).toBe(OWNER_DEFAULT);

    const result = assemblePrompt({
      surface: 'SideChat',
      systemlawContent: sl,
      ownerContent: owner,
    });

    expect(result.trim().length).toBeGreaterThan(0);
  });

  it('G3. EMFILE on systemlaw → SYSTEMLAW_DEFAULT → assemblePrompt non-empty', async () => {
    const sl = await readSystemlaw(
      USER_DATA,
      stubError<SystemlawFsReader>(makeErrnoError('EMFILE')),
    );
    const owner = await readOwner(USER_DATA, stubAbsent<OwnerFsReader>());

    expect(sl).toBe(SYSTEMLAW_DEFAULT);

    const result = assemblePrompt({
      surface: 'BottomChat',
      systemlawContent: sl,
      ownerContent: owner,
    });

    expect(result.trim().length).toBeGreaterThan(0);
  });

  it('G4. generic Error on owner → OWNER_DEFAULT → assemblePrompt non-empty', async () => {
    const sl = await readSystemlaw(USER_DATA, stubAbsent<SystemlawFsReader>());
    const owner = await readOwner(
      USER_DATA,
      stubError<OwnerFsReader>(new Error('Disk error')),
    );

    expect(owner).toBe(OWNER_DEFAULT);

    const result = assemblePrompt({
      surface: 'QualityDial',
      systemlawContent: sl,
      ownerContent: owner,
    });

    expect(result.trim().length).toBeGreaterThan(0);
  });

  it('G5. both readers throw → both fallbacks → assembled result is non-empty', async () => {
    const sl = await readSystemlaw(
      USER_DATA,
      stubError<SystemlawFsReader>(makeErrnoError('ENOENT')),
    );
    const owner = await readOwner(
      USER_DATA,
      stubError<OwnerFsReader>(makeErrnoError('EACCES')),
    );

    expect(sl).toBe(SYSTEMLAW_DEFAULT);
    expect(owner).toBe(OWNER_DEFAULT);

    const result = assemblePrompt({
      surface: 'BlockAI',
      systemlawContent: sl,
      ownerContent: owner,
    });

    expect(result.trim().length).toBeGreaterThan(0);
    expect(result).toBe(`${SYSTEMLAW_DEFAULT}\n\n${OWNER_DEFAULT}`);
  });

  it('G6. TypeError on systemlaw → SYSTEMLAW_DEFAULT → assemblePrompt non-empty', async () => {
    const sl = await readSystemlaw(
      USER_DATA,
      stubError<SystemlawFsReader>(new TypeError('unexpected type')),
    );
    const owner = await readOwner(USER_DATA, stubAbsent<OwnerFsReader>());

    expect(sl).toBe(SYSTEMLAW_DEFAULT);

    const result = assemblePrompt({
      surface: 'SideChat',
      systemlawContent: sl,
      ownerContent: owner,
    });

    expect(result.trim().length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// H. Reader content + surface-level fields (full pipeline)
// ===========================================================================

describe('H. Reader content + surface-level fields — full pipeline', () => {
  it('H1. fallback readers + surface prompt → non-empty, ordered correctly', async () => {
    const sl = await readSystemlaw(USER_DATA, stubAbsent<SystemlawFsReader>());
    const owner = await readOwner(USER_DATA, stubAbsent<OwnerFsReader>());

    const result = assemblePrompt({
      surface: 'BlockAI',
      systemlawContent: sl,
      ownerContent: owner,
      surfacePrompt: SURFACE_PROMPT,
    });

    expect(result.trim().length).toBeGreaterThan(0);
    expect(result).toContain(SYSTEMLAW_DEFAULT);
    expect(result).toContain(OWNER_DEFAULT);
    expect(result).toContain(SURFACE_PROMPT);
    // Ordering: systemlaw (0) before owner (1) before surface (3)
    assertOrder(result, SYSTEMLAW_DEFAULT, OWNER_DEFAULT);
    assertOrder(result, OWNER_DEFAULT, SURFACE_PROMPT);
  });

  it('H2. fallback readers + all surface fields → all layers present', async () => {
    const sl = await readSystemlaw(USER_DATA, stubAbsent<SystemlawFsReader>());
    const owner = await readOwner(USER_DATA, stubAbsent<OwnerFsReader>());

    const result = assemblePrompt({
      surface: 'BottomChat',
      systemlawContent: sl,
      ownerContent: owner,
      surfacePrompt: SURFACE_PROMPT,
      qualityDirective: QUALITY_DIRECTIVE,
      documentText: DOCUMENT_TEXT,
      userInstruction: USER_INSTRUCTION,
    });

    expect(result.trim().length).toBeGreaterThan(0);
    // All 6 non-overview layers should be present
    expect(result).toContain(SYSTEMLAW_DEFAULT);
    expect(result).toContain(OWNER_DEFAULT);
    expect(result).toContain(SURFACE_PROMPT);
    expect(result).toContain(QUALITY_DIRECTIVE);
    expect(result).toContain(DOCUMENT_TEXT);
    expect(result).toContain(USER_INSTRUCTION);
  });

  it('H3. fallback readers + all surface fields → full canonical ordering', async () => {
    const sl = await readSystemlaw(USER_DATA, stubAbsent<SystemlawFsReader>());
    const owner = await readOwner(USER_DATA, stubAbsent<OwnerFsReader>());

    const result = assemblePrompt({
      surface: 'SideChat',
      systemlawContent: sl,
      ownerContent: owner,
      surfacePrompt: SURFACE_PROMPT,
      qualityDirective: QUALITY_DIRECTIVE,
      documentText: DOCUMENT_TEXT,
      userInstruction: USER_INSTRUCTION,
    });

    // Verify complete chain: systemlaw → owner → surface → quality → document → instruction
    assertOrder(result, SYSTEMLAW_DEFAULT, OWNER_DEFAULT);
    assertOrder(result, OWNER_DEFAULT, SURFACE_PROMPT);
    assertOrder(result, SURFACE_PROMPT, QUALITY_DIRECTIVE);
    assertOrder(result, QUALITY_DIRECTIVE, DOCUMENT_TEXT);
    assertOrder(result, DOCUMENT_TEXT, USER_INSTRUCTION);
  });

  it('H4. real readers + all surface fields → full canonical ordering', async () => {
    const sl = await readSystemlaw(
      USER_DATA,
      stubFile<SystemlawFsReader>(SYSTEMLAW_PATH, REAL_SYSTEMLAW),
    );
    const owner = await readOwner(
      USER_DATA,
      stubFile<OwnerFsReader>(OWNER_PATH, REAL_OWNER),
    );

    const result = assemblePrompt({
      surface: 'BlockAI',
      systemlawContent: sl,
      ownerContent: owner,
      surfacePrompt: SURFACE_PROMPT,
      qualityDirective: QUALITY_DIRECTIVE,
      documentText: DOCUMENT_TEXT,
      userInstruction: USER_INSTRUCTION,
    });

    // Ordering with real reader content
    assertOrder(result, REAL_SYSTEMLAW, REAL_OWNER);
    assertOrder(result, REAL_OWNER, SURFACE_PROMPT);
    assertOrder(result, SURFACE_PROMPT, QUALITY_DIRECTIVE);
    assertOrder(result, QUALITY_DIRECTIVE, DOCUMENT_TEXT);
    assertOrder(result, DOCUMENT_TEXT, USER_INSTRUCTION);
  });

  it('H5. fallback readers + quality directive only → quality after reader layers', async () => {
    const sl = await readSystemlaw(USER_DATA, stubAbsent<SystemlawFsReader>());
    const owner = await readOwner(USER_DATA, stubAbsent<OwnerFsReader>());

    const result = assemblePrompt({
      surface: 'QualityDial',
      systemlawContent: sl,
      ownerContent: owner,
      qualityDirective: QUALITY_DIRECTIVE,
    });

    // systemlaw → owner → quality
    assertOrder(result, SYSTEMLAW_DEFAULT, QUALITY_DIRECTIVE);
    assertOrder(result, OWNER_DEFAULT, QUALITY_DIRECTIVE);
  });

  it('H6. 6 layers from full pipeline — all six layer contents are present in result', async () => {
    // Note: SYSTEMLAW_DEFAULT and OWNER_DEFAULT contain \n\n internally, so
    // counting \n\n occurrences in the assembled string is not a reliable
    // separator-count proxy.  Instead we verify that all six layer contents
    // are present (no layers were dropped by the assembler).
    const sl = await readSystemlaw(USER_DATA, stubAbsent<SystemlawFsReader>());
    const owner = await readOwner(USER_DATA, stubAbsent<OwnerFsReader>());

    const result = assemblePrompt({
      surface: 'BlockAI',
      systemlawContent: sl,
      ownerContent: owner,
      surfacePrompt: SURFACE_PROMPT,
      qualityDirective: QUALITY_DIRECTIVE,
      documentText: DOCUMENT_TEXT,
      userInstruction: USER_INSTRUCTION,
    });

    // All 6 non-overview layers must appear in the output
    expect(result).toContain(SYSTEMLAW_DEFAULT);
    expect(result).toContain(OWNER_DEFAULT);
    expect(result).toContain(SURFACE_PROMPT);
    expect(result).toContain(QUALITY_DIRECTIVE);
    expect(result).toContain(DOCUMENT_TEXT);
    expect(result).toContain(USER_INSTRUCTION);
  });
});

// ===========================================================================
// I. Return-type structural validity across all combinations
// ===========================================================================

describe('I. Return-type structural validity — all combinations', () => {
  /**
   * The matrix of (systemlaw-reader, owner-reader) combinations to test.
   * Each pair represents a real-world scenario:
   *   - 'absent': file does not exist → reader returns default
   *   - 'real':   file exists with custom content
   *   - 'empty':  file exists but is empty → reader returns ''
   *   - 'error':  I/O error → reader returns default
   */
  const scenarios: Array<{
    name: string;
    getSlContent: () => Promise<string>;
    getOwnerContent: () => Promise<string>;
  }> = [
    {
      name: 'absent/absent (both defaults)',
      getSlContent: () => readSystemlaw(USER_DATA, stubAbsent<SystemlawFsReader>()),
      getOwnerContent: () => readOwner(USER_DATA, stubAbsent<OwnerFsReader>()),
    },
    {
      name: 'real/absent',
      getSlContent: () =>
        readSystemlaw(USER_DATA, stubFile<SystemlawFsReader>(SYSTEMLAW_PATH, REAL_SYSTEMLAW)),
      getOwnerContent: () => readOwner(USER_DATA, stubAbsent<OwnerFsReader>()),
    },
    {
      name: 'absent/real',
      getSlContent: () => readSystemlaw(USER_DATA, stubAbsent<SystemlawFsReader>()),
      getOwnerContent: () =>
        readOwner(USER_DATA, stubFile<OwnerFsReader>(OWNER_PATH, REAL_OWNER)),
    },
    {
      name: 'real/real',
      getSlContent: () =>
        readSystemlaw(USER_DATA, stubFile<SystemlawFsReader>(SYSTEMLAW_PATH, REAL_SYSTEMLAW)),
      getOwnerContent: () =>
        readOwner(USER_DATA, stubFile<OwnerFsReader>(OWNER_PATH, REAL_OWNER)),
    },
    {
      name: 'empty/absent',
      getSlContent: () =>
        readSystemlaw(USER_DATA, stubFile<SystemlawFsReader>(SYSTEMLAW_PATH, '')),
      getOwnerContent: () => readOwner(USER_DATA, stubAbsent<OwnerFsReader>()),
    },
    {
      name: 'absent/empty',
      getSlContent: () => readSystemlaw(USER_DATA, stubAbsent<SystemlawFsReader>()),
      getOwnerContent: () =>
        readOwner(USER_DATA, stubFile<OwnerFsReader>(OWNER_PATH, '')),
    },
    {
      name: 'error/absent',
      getSlContent: () =>
        readSystemlaw(USER_DATA, stubError<SystemlawFsReader>(makeErrnoError('ENOENT'))),
      getOwnerContent: () => readOwner(USER_DATA, stubAbsent<OwnerFsReader>()),
    },
    {
      name: 'absent/error',
      getSlContent: () => readSystemlaw(USER_DATA, stubAbsent<SystemlawFsReader>()),
      getOwnerContent: () =>
        readOwner(USER_DATA, stubError<OwnerFsReader>(makeErrnoError('EACCES'))),
    },
    {
      name: 'error/error',
      getSlContent: () =>
        readSystemlaw(USER_DATA, stubError<SystemlawFsReader>(makeErrnoError('EMFILE'))),
      getOwnerContent: () =>
        readOwner(USER_DATA, stubError<OwnerFsReader>(new Error('Boom'))),
    },
  ];

  for (const { name, getSlContent, getOwnerContent } of scenarios) {
    it(`I1-[${name}]. result is a string — never null or undefined`, async () => {
      const sl = await getSlContent();
      const owner = await getOwnerContent();
      const result: AssembledPrompt = assemblePrompt({
        surface: 'BlockAI',
        systemlawContent: sl,
        ownerContent: owner,
        surfacePrompt: SURFACE_PROMPT,
      });
      expect(typeof result).toBe('string');
      expect(result).not.toBeNull();
      expect(result).not.toBeUndefined();
    });
  }

  it('I2. assemblePrompt never throws regardless of reader output combination', async () => {
    const combinations: AssemblyRequest[] = [
      { surface: 'BlockAI',    systemlawContent: SYSTEMLAW_DEFAULT, ownerContent: OWNER_DEFAULT },
      { surface: 'SideChat',   systemlawContent: '',                ownerContent: OWNER_DEFAULT },
      { surface: 'BottomChat', systemlawContent: SYSTEMLAW_DEFAULT, ownerContent: '' },
      { surface: 'QualityDial', systemlawContent: '',               ownerContent: '' },
      { surface: 'BlockAI',    systemlawContent: REAL_SYSTEMLAW,    ownerContent: REAL_OWNER },
      { surface: 'SideChat',   systemlawContent: '   \n  ',         ownerContent: '  \t  ' },
      { surface: 'BottomChat', systemlawContent: SYSTEMLAW_DEFAULT, ownerContent: REAL_OWNER },
      { surface: 'QualityDial', systemlawContent: REAL_SYSTEMLAW,   ownerContent: OWNER_DEFAULT },
    ];
    for (const req of combinations) {
      expect(() => assemblePrompt(req)).not.toThrow();
    }
  });

  it('I3. fallback-default path always yields non-empty output (SYSTEMLAW_DEFAULT and OWNER_DEFAULT are both non-empty)', async () => {
    // Structural invariant: the fallback sentinel values from both readers
    // are non-empty strings, so any pipeline that hits both fallbacks
    // guarantees a non-empty assembled output.
    expect(SYSTEMLAW_DEFAULT.trim().length).toBeGreaterThan(0);
    expect(OWNER_DEFAULT.trim().length).toBeGreaterThan(0);

    const sl = await readSystemlaw(
      USER_DATA,
      stubError<SystemlawFsReader>(makeErrnoError('ENOENT')),
    );
    const owner = await readOwner(
      USER_DATA,
      stubError<OwnerFsReader>(makeErrnoError('ENOENT')),
    );

    const result = assemblePrompt({
      surface: 'BlockAI',
      systemlawContent: sl,
      ownerContent: owner,
    });

    expect(result.trim().length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// J. Layer ordering preserved through reader integration
// ===========================================================================

describe('J. Layer ordering preserved through reader integration', () => {
  it('J1. SYSTEMLAW_DEFAULT (layer 0) precedes OWNER_DEFAULT (layer 1) in output', async () => {
    const sl = await readSystemlaw(USER_DATA, stubAbsent<SystemlawFsReader>());
    const owner = await readOwner(USER_DATA, stubAbsent<OwnerFsReader>());

    const result = assemblePrompt({
      surface: 'BlockAI',
      systemlawContent: sl,
      ownerContent: owner,
    });

    assertOrder(result, SYSTEMLAW_DEFAULT, OWNER_DEFAULT);
  });

  it('J2. reader content (layers 0-1) precedes surface-supplied content (layers 3-6)', async () => {
    const sl = await readSystemlaw(USER_DATA, stubAbsent<SystemlawFsReader>());
    const owner = await readOwner(USER_DATA, stubAbsent<OwnerFsReader>());

    const result = assemblePrompt({
      surface: 'SideChat',
      systemlawContent: sl,
      ownerContent: owner,
      userInstruction: USER_INSTRUCTION,
    });

    // SYSTEMLAW_DEFAULT (layer 0) before USER_INSTRUCTION (layer 6)
    assertOrder(result, SYSTEMLAW_DEFAULT, USER_INSTRUCTION);
    // OWNER_DEFAULT (layer 1) before USER_INSTRUCTION (layer 6)
    assertOrder(result, OWNER_DEFAULT, USER_INSTRUCTION);
  });

  it('J3. real systemlaw (layer 0) precedes real owner (layer 1) precedes quality (layer 4)', async () => {
    const sl = await readSystemlaw(
      USER_DATA,
      stubFile<SystemlawFsReader>(SYSTEMLAW_PATH, REAL_SYSTEMLAW),
    );
    const owner = await readOwner(
      USER_DATA,
      stubFile<OwnerFsReader>(OWNER_PATH, REAL_OWNER),
    );

    const result = assemblePrompt({
      surface: 'BottomChat',
      systemlawContent: sl,
      ownerContent: owner,
      qualityDirective: QUALITY_DIRECTIVE,
    });

    assertOrder(result, REAL_SYSTEMLAW, REAL_OWNER);
    assertOrder(result, REAL_OWNER, QUALITY_DIRECTIVE);
  });

  it('J4. overview stub (layer 2) is always absent — no triple-newline between reader layers', async () => {
    // Use single-line content so we can reliably count inter-layer separators.
    // SYSTEMLAW_DEFAULT and OWNER_DEFAULT themselves contain \n\n internally,
    // so we use simple stub content here to keep the separator assertion clean.
    const SIMPLE_SL = 'SL-CONTENT-SINGLE-LINE';
    const SIMPLE_OW = 'OW-CONTENT-SINGLE-LINE';

    const sl = await readSystemlaw(
      USER_DATA,
      stubFile<SystemlawFsReader>(SYSTEMLAW_PATH, SIMPLE_SL),
    );
    const owner = await readOwner(
      USER_DATA,
      stubFile<OwnerFsReader>(OWNER_PATH, SIMPLE_OW),
    );

    const result = assemblePrompt({
      surface: 'BlockAI',
      systemlawContent: sl,
      ownerContent: owner,
    });

    // Two layers joined by exactly one \n\n — no triple newline from empty overview slot
    expect(result).not.toContain('\n\n\n');
    // Exactly one \n\n separator for two single-line layers
    const seps = result.match(/\n\n/g);
    expect(seps).toHaveLength(1);
    expect(result).toBe(`${SIMPLE_SL}\n\n${SIMPLE_OW}`);
  });

  it('J5. concurrent reader + assemble calls produce consistent ordered output', async () => {
    const [sl, owner] = await Promise.all([
      readSystemlaw(USER_DATA, stubAbsent<SystemlawFsReader>()),
      readOwner(USER_DATA, stubAbsent<OwnerFsReader>()),
    ]);

    const [r1, r2, r3] = await Promise.all([
      Promise.resolve(assemblePrompt({ surface: 'BlockAI',    systemlawContent: sl, ownerContent: owner })),
      Promise.resolve(assemblePrompt({ surface: 'SideChat',   systemlawContent: sl, ownerContent: owner })),
      Promise.resolve(assemblePrompt({ surface: 'BottomChat', systemlawContent: sl, ownerContent: owner })),
    ]);

    expect(r1).toBe(r2);
    expect(r2).toBe(r3);
  });

  it('J6. reader-sourced systemlaw starts the assembled string (position 0)', async () => {
    const sl = await readSystemlaw(
      USER_DATA,
      stubFile<SystemlawFsReader>(SYSTEMLAW_PATH, REAL_SYSTEMLAW),
    );
    const owner = await readOwner(USER_DATA, stubAbsent<OwnerFsReader>());

    const result = assemblePrompt({
      surface: 'QualityDial',
      systemlawContent: sl,
      ownerContent: owner,
    });

    // systemlaw is layer 0 — it starts the assembled output
    expect(result.startsWith(REAL_SYSTEMLAW)).toBe(true);
  });
});
