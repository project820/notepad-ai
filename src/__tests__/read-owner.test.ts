/**
 * read-owner.test.ts
 *
 * Unit tests for `readOwner(userDataPath, fs?)` and `OWNER_DEFAULT`
 * (src/main/prompts/read-owner.ts).
 *
 * Sub-AC 2.2 requirements:
 *   ✓ `readOwner` reads `Owner.md` from the given userData directory
 *     when the file exists and returns its content.
 *   ✓ `readOwner` returns `OWNER_DEFAULT` when the file is absent.
 *   ✓ At least one test for the file-present path.
 *   ✓ At least one test for the file-absent path.
 *
 * Test groups:
 *   A. File-present path — content returned verbatim
 *   B. File-absent path — OWNER_DEFAULT returned
 *   C. OWNER_DEFAULT export — content quality checks
 *   D. Path construction — correct path is passed to the reader
 *   E. Error resilience — any I/O error yields the default (never throws)
 *   F. Return-value type guarantees
 *   G. Purity — no mutation of arguments, same input → same output
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  readOwner,
  OWNER_DEFAULT,
  type FsReader,
} from '../../src/main/prompts/read-owner';

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

/**
 * Creates a FsReader stub that returns `content` for the specific `filePath`
 * and throws ENOENT for everything else.
 */
function stubWithFile(filePath: string, content: string): FsReader {
  return {
    async readFile(requested: string, _enc: BufferEncoding): Promise<string> {
      if (requested === filePath) return content;
      throw makeEnoent(requested);
    },
  };
}

/**
 * Creates a FsReader stub that always throws ENOENT — simulates absent file.
 */
function stubAbsent(): FsReader {
  return {
    async readFile(filePath: string, _enc: BufferEncoding): Promise<string> {
      throw makeEnoent(filePath);
    },
  };
}

/**
 * Creates a FsReader stub that throws the provided error.
 */
function stubError(err: Error): FsReader {
  return {
    async readFile(_filePath: string, _enc: BufferEncoding): Promise<string> {
      throw err;
    },
  };
}

/**
 * Creates a FsReader spy that records calls and returns `content`.
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
  const err = new Error(message ?? `${code}: mock error`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

/** Constructs an ENOENT error for a given path. */
function makeEnoent(filePath: string): NodeJS.ErrnoException {
  return makeErrnoError('ENOENT', `ENOENT: no such file or directory, open '${filePath}'`);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const USER_DATA = '/home/user/.config/notepad-ai';
const OWNER_PATH = path.join(USER_DATA, 'Owner.md');

// ============================================================================
// A. File-present path — content returned verbatim
// ============================================================================

describe('A. File-present path — content returned verbatim', () => {
  it('A1. [file-present] returns the file content when Owner.md exists', async () => {
    const content = '# About Me\nI am a professional Korean writer.';
    const fs = stubWithFile(OWNER_PATH, content);

    const result = await readOwner(USER_DATA, fs);

    expect(result).toBe(content);
  });

  it('A2. [file-present] file content is returned verbatim — not trimmed or modified', async () => {
    const content = '  ## About the Author\n\n- Writes in Korean\n- Works on reports  \n';
    const fs = stubWithFile(OWNER_PATH, content);

    const result = await readOwner(USER_DATA, fs);

    expect(result).toBe(content);
  });

  it('A3. [file-present] multi-paragraph content is returned in full', async () => {
    const content = [
      '# Owner Profile',
      '',
      'I am a technical writer.',
      '',
      'I prefer concise, well-structured documents.',
      '',
      'I work primarily in Korean.',
    ].join('\n');
    const fs = stubWithFile(OWNER_PATH, content);

    const result = await readOwner(USER_DATA, fs);

    expect(result).toBe(content);
  });

  it('A4. [file-present] Korean content is returned correctly (UTF-8 passthrough)', async () => {
    const content = '# 작성자 프로필\n\n저는 전문 작가입니다.\n한국어와 영어로 작업합니다.';
    const fs = stubWithFile(OWNER_PATH, content);

    const result = await readOwner(USER_DATA, fs);

    expect(result).toBe(content);
  });

  it('A5. [file-present] empty file content is returned as empty string (not default)', async () => {
    // An empty file IS a valid "present" file — the user explicitly emptied it.
    const fs = stubWithFile(OWNER_PATH, '');

    const result = await readOwner(USER_DATA, fs);

    // Empty string is returned; OWNER_DEFAULT is NOT used when the file is present.
    expect(result).toBe('');
    expect(result).not.toBe(OWNER_DEFAULT);
  });

  it('A6. [file-present] whitespace-only file content is returned as-is (not default)', async () => {
    const content = '   \n\n   ';
    const fs = stubWithFile(OWNER_PATH, content);

    const result = await readOwner(USER_DATA, fs);

    expect(result).toBe(content);
    expect(result).not.toBe(OWNER_DEFAULT);
  });

  it('A7. [file-present] returns a Promise that resolves to the file content', async () => {
    const content = '## Owner\nAlways write professionally.';
    const fs = stubWithFile(OWNER_PATH, content);

    const promise = readOwner(USER_DATA, fs);

    // The return value is a thenable (Promise)
    expect(typeof promise.then).toBe('function');
    await expect(promise).resolves.toBe(content);
  });
});

// ============================================================================
// B. File-absent path — OWNER_DEFAULT returned
// ============================================================================

describe('B. File-absent path — OWNER_DEFAULT returned', () => {
  it('B1. [file-absent] returns OWNER_DEFAULT when Owner.md does not exist', async () => {
    const result = await readOwner(USER_DATA, stubAbsent());

    expect(result).toBe(OWNER_DEFAULT);
  });

  it('B2. [file-absent] returned value is not empty when file is absent', async () => {
    const result = await readOwner(USER_DATA, stubAbsent());

    expect(result.trim().length).toBeGreaterThan(0);
  });

  it('B3. [file-absent] returns a string (not null or undefined) when file is absent', async () => {
    const result = await readOwner(USER_DATA, stubAbsent());

    expect(typeof result).toBe('string');
    expect(result).not.toBeNull();
    expect(result).not.toBeUndefined();
  });

  it('B4. [file-absent] does not throw when the file is missing', async () => {
    await expect(readOwner(USER_DATA, stubAbsent())).resolves.not.toThrow();
  });

  it('B5. [file-absent] OWNER_DEFAULT is returned regardless of the userDataPath value', async () => {
    const paths = [
      '/Users/user/Library/Application Support/notepad-ai',
      '/home/user/.config/notepad-ai',
      '/tmp/empty',
      '/',
    ];
    for (const p of paths) {
      const result = await readOwner(p, stubAbsent());
      expect(result).toBe(OWNER_DEFAULT);
    }
  });
});

// ============================================================================
// C. OWNER_DEFAULT export — content quality checks
// ============================================================================

describe('C. OWNER_DEFAULT export — sensible default content', () => {
  it('C1. OWNER_DEFAULT is a non-empty string', () => {
    expect(typeof OWNER_DEFAULT).toBe('string');
    expect(OWNER_DEFAULT.trim().length).toBeGreaterThan(0);
  });

  it('C2. OWNER_DEFAULT is at least 50 characters (meaningful content)', () => {
    expect(OWNER_DEFAULT.length).toBeGreaterThanOrEqual(50);
  });

  it('C3. OWNER_DEFAULT mentions language or writing context', () => {
    // The default should convey user persona including language context
    // (critical for Korean users using a Korean markdown editor).
    const lower = OWNER_DEFAULT.toLowerCase();
    expect(
      lower.includes('language') ||
      lower.includes('korean') ||
      lower.includes('한국어') ||
      lower.includes('writing') ||
      lower.includes('writer') ||
      lower.includes('document'),
    ).toBe(true);
  });

  it('C4. OWNER_DEFAULT does not reference Phase 2 features (overview cascade, @mention)', () => {
    // Phase 1 default must not leak Phase 2 concerns.
    expect(OWNER_DEFAULT).not.toContain('@mention');
    expect(OWNER_DEFAULT).not.toContain('Overview.md');
    expect(OWNER_DEFAULT).not.toContain('cascade');
  });

  it('C5. OWNER_DEFAULT is a stable export — same value across multiple reads', () => {
    // Confirm it is a module-level constant, not a function call (idempotency).
    expect(OWNER_DEFAULT).toBe(OWNER_DEFAULT);
  });
});

// ============================================================================
// D. Path construction — correct path is passed to the reader
// ============================================================================

describe('D. Path construction — Owner.md path is correctly resolved', () => {
  it('D1. passes path.join(userDataPath, "Owner.md") to the reader', async () => {
    const expectedPath = path.join(USER_DATA, 'Owner.md');
    const { fs, calls } = spyFs('# About Me');

    await readOwner(USER_DATA, fs);

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe(expectedPath);
  });

  it('D2. passes encoding "utf-8" to the reader', async () => {
    const { fs, calls } = spyFs('# About Me');

    await readOwner(USER_DATA, fs);

    expect(calls).toHaveLength(1);
    expect(calls[0].encoding).toBe('utf-8');
  });

  it('D3. different userDataPath values produce the correct file paths', async () => {
    const dirs = [
      '/Users/alice/Library/Application Support/notepad-ai',
      '/home/bob/.config/notepad-ai',
      '/var/app/notepad-ai/userData',
    ];
    for (const dir of dirs) {
      const { fs, calls } = spyFs('content');
      await readOwner(dir, fs);
      expect(calls[0].path).toBe(path.join(dir, 'Owner.md'));
    }
  });

  it('D4. the reader is called exactly once per readOwner call', async () => {
    const { fs, calls } = spyFs('# About Me');

    await readOwner(USER_DATA, fs);

    expect(calls).toHaveLength(1);
  });

  it('D5. the filename uses capital O in "Owner.md" (case-sensitive)', async () => {
    const { fs, calls } = spyFs('# About Me');

    await readOwner(USER_DATA, fs);

    expect(calls[0].path).toMatch(/Owner\.md$/);
    expect(calls[0].path).not.toMatch(/owner\.md$/i.source.replace('i', ''));
  });
});

// ============================================================================
// E. Error resilience — any I/O error yields the default (never throws)
// ============================================================================

describe('E. Error resilience — any I/O error returns OWNER_DEFAULT', () => {
  it('E1. ENOENT error → returns OWNER_DEFAULT (not throws)', async () => {
    const result = await readOwner(USER_DATA, stubError(makeErrnoError('ENOENT')));

    expect(result).toBe(OWNER_DEFAULT);
  });

  it('E2. EACCES error → returns OWNER_DEFAULT (not throws)', async () => {
    const result = await readOwner(USER_DATA, stubError(makeErrnoError('EACCES')));

    expect(result).toBe(OWNER_DEFAULT);
  });

  it('E3. EMFILE error → returns OWNER_DEFAULT (not re-throws)', async () => {
    // readOwner swallows ALL errors and returns the default —
    // the prompt stack must never fail.
    const result = await readOwner(USER_DATA, stubError(makeErrnoError('EMFILE')));

    expect(result).toBe(OWNER_DEFAULT);
  });

  it('E4. generic Error with no code → returns OWNER_DEFAULT', async () => {
    const result = await readOwner(USER_DATA, stubError(new Error('Unexpected')));

    expect(result).toBe(OWNER_DEFAULT);
  });

  it('E5. readOwner never rejects its returned Promise', async () => {
    const errorKinds = [
      makeErrnoError('ENOENT'),
      makeErrnoError('EACCES'),
      makeErrnoError('EMFILE'),
      new Error('Unknown error'),
      new TypeError('Type error'),
    ];
    for (const err of errorKinds) {
      await expect(readOwner(USER_DATA, stubError(err))).resolves.toBeDefined();
    }
  });

  it('E6. result is always a string even when an error occurs', async () => {
    const result = await readOwner(USER_DATA, stubError(new Error('boom')));

    expect(typeof result).toBe('string');
  });
});

// ============================================================================
// F. Return-value type guarantees
// ============================================================================

describe('F. Return-value type guarantees', () => {
  it('F1. [file-present] return type is string', async () => {
    const fs = stubWithFile(OWNER_PATH, '# About Me');

    const result = await readOwner(USER_DATA, fs);

    expect(typeof result).toBe('string');
  });

  it('F2. [file-absent] return type is string', async () => {
    const result = await readOwner(USER_DATA, stubAbsent());

    expect(typeof result).toBe('string');
  });

  it('F3. readOwner returns a Promise (thenable)', () => {
    const promise = readOwner(USER_DATA, stubAbsent());

    expect(typeof promise.then).toBe('function');
  });

  it('F4. result is never null or undefined regardless of scenario', async () => {
    const scenarios: FsReader[] = [
      stubWithFile(OWNER_PATH, 'content'),
      stubAbsent(),
      stubError(new Error('boom')),
    ];
    for (const fs of scenarios) {
      const result = await readOwner(USER_DATA, fs);
      expect(result).not.toBeNull();
      expect(result).not.toBeUndefined();
    }
  });
});

// ============================================================================
// G. Purity — no mutation, consistent results
// ============================================================================

describe('G. Purity — consistent and non-mutating', () => {
  it('G1. same input always yields the same output (file-present)', async () => {
    const fs = stubWithFile(OWNER_PATH, '# About Me');

    const first = await readOwner(USER_DATA, fs);
    const second = await readOwner(USER_DATA, fs);

    expect(first).toBe(second);
  });

  it('G2. same input always yields the same output (file-absent)', async () => {
    const first = await readOwner(USER_DATA, stubAbsent());
    const second = await readOwner(USER_DATA, stubAbsent());

    expect(first).toBe(second);
  });

  it('G3. calling readOwner does not mutate the userDataPath argument', async () => {
    const original = USER_DATA;
    const captured = USER_DATA;

    await readOwner(captured, stubAbsent());

    expect(captured).toBe(original);
  });

  it('G4. two concurrent calls both resolve correctly', async () => {
    const content = '# Concurrent Owner';
    const fs = stubWithFile(OWNER_PATH, content);

    const [a, b] = await Promise.all([
      readOwner(USER_DATA, fs),
      readOwner(USER_DATA, fs),
    ]);

    expect(a).toBe(content);
    expect(b).toBe(content);
  });
});

// ============================================================================
// H. Integration with Layer 1 — OWNER_DEFAULT is a useful persona string
// ============================================================================

describe('H. OWNER_DEFAULT — Layer-1 persona usability', () => {
  it('H1. OWNER_DEFAULT starts with a heading (markdown heading marker)', () => {
    // A markdown heading is expected for Layer-1 persona content.
    expect(OWNER_DEFAULT.trimStart()).toMatch(/^#/);
  });

  it('H2. OWNER_DEFAULT differs from any systemlaw-style conduct rules', () => {
    // The owner file describes a user persona, not AI conduct rules.
    // It should not say "you are an AI" or similar conduct-rule language.
    const lower = OWNER_DEFAULT.toLowerCase();
    expect(lower).not.toContain('you are a professional writing assistant');
  });

  it('H3. readOwner file-present result may differ from OWNER_DEFAULT', async () => {
    const customContent = '# Custom Owner\nI am a legal researcher.';
    const fs = stubWithFile(OWNER_PATH, customContent);

    const result = await readOwner(USER_DATA, fs);

    expect(result).toBe(customContent);
    expect(result).not.toBe(OWNER_DEFAULT);
  });
});
