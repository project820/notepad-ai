/**
 * read-systemlaw.test.ts
 *
 * Unit tests for `readSystemlaw(userDataPath, fs?)` and `SYSTEMLAW_DEFAULT`
 * (src/main/prompts/read-systemlaw.ts).
 *
 * Sub-AC 2.1 requirements:
 *   ✓ `readSystemlaw` reads `systemlaw.md` from the given userData directory
 *     when the file exists and returns its content.
 *   ✓ `readSystemlaw` returns `SYSTEMLAW_DEFAULT` when the file is absent.
 *   ✓ At least one test for the file-present path.
 *   ✓ At least one test for the file-absent path.
 *
 * Test groups:
 *   A. File-present path — content returned verbatim
 *   B. File-absent path — SYSTEMLAW_DEFAULT returned
 *   C. SYSTEMLAW_DEFAULT export — content quality checks
 *   D. Path construction — correct path is passed to the reader
 *   E. Error resilience — any I/O error yields the default (never throws)
 *   F. Return-value type guarantees
 *   G. Purity — no mutation of arguments, same input → same output
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  readSystemlaw,
  SYSTEMLAW_DEFAULT,
  type FsReader,
} from '../../src/main/prompts/read-systemlaw';

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
const SYSTEMLAW_PATH = path.join(USER_DATA, 'systemlaw.md');

// ============================================================================
// A. File-present path — content returned verbatim
// ============================================================================

describe('A. File-present path — content returned verbatim', () => {
  it('A1. [file-present] returns the file content when systemlaw.md exists', async () => {
    const content = '# My Rules\nBe helpful and concise.';
    const fs = stubWithFile(SYSTEMLAW_PATH, content);

    const result = await readSystemlaw(USER_DATA, fs);

    expect(result).toBe(content);
  });

  it('A2. [file-present] file content is returned verbatim — not trimmed or modified', async () => {
    const content = '  ## Rules\n\n- Rule 1\n- Rule 2  \n';
    const fs = stubWithFile(SYSTEMLAW_PATH, content);

    const result = await readSystemlaw(USER_DATA, fs);

    expect(result).toBe(content);
  });

  it('A3. [file-present] multi-paragraph content is returned in full', async () => {
    const content = [
      '# AI Conduct Rules',
      '',
      'Be concise.',
      '',
      'Match the user\'s language.',
      '',
      'Preserve formatting.',
    ].join('\n');
    const fs = stubWithFile(SYSTEMLAW_PATH, content);

    const result = await readSystemlaw(USER_DATA, fs);

    expect(result).toBe(content);
  });

  it('A4. [file-present] Korean content is returned correctly (UTF-8 passthrough)', async () => {
    const content = '# AI 행동 규칙\n\n한국어로 응답하세요.\n전문적인 어조를 유지하세요.';
    const fs = stubWithFile(SYSTEMLAW_PATH, content);

    const result = await readSystemlaw(USER_DATA, fs);

    expect(result).toBe(content);
  });

  it('A5. [file-present] empty file content is returned as empty string (not default)', async () => {
    // An empty file IS a valid "present" file — the user explicitly emptied it.
    const fs = stubWithFile(SYSTEMLAW_PATH, '');

    const result = await readSystemlaw(USER_DATA, fs);

    // Empty string is returned; SYSTEMLAW_DEFAULT is NOT used when the file is present.
    expect(result).toBe('');
    expect(result).not.toBe(SYSTEMLAW_DEFAULT);
  });

  it('A6. [file-present] whitespace-only file content is returned as-is (not default)', async () => {
    const content = '   \n\n   ';
    const fs = stubWithFile(SYSTEMLAW_PATH, content);

    const result = await readSystemlaw(USER_DATA, fs);

    expect(result).toBe(content);
    expect(result).not.toBe(SYSTEMLAW_DEFAULT);
  });

  it('A7. [file-present] returns a Promise that resolves to the file content', async () => {
    const content = '## Rules\nAlways respond helpfully.';
    const fs = stubWithFile(SYSTEMLAW_PATH, content);

    const promise = readSystemlaw(USER_DATA, fs);

    // The return value is a thenable (Promise)
    expect(typeof promise.then).toBe('function');
    await expect(promise).resolves.toBe(content);
  });
});

// ============================================================================
// B. File-absent path — SYSTEMLAW_DEFAULT returned
// ============================================================================

describe('B. File-absent path — SYSTEMLAW_DEFAULT returned', () => {
  it('B1. [file-absent] returns SYSTEMLAW_DEFAULT when systemlaw.md does not exist', async () => {
    const result = await readSystemlaw(USER_DATA, stubAbsent());

    expect(result).toBe(SYSTEMLAW_DEFAULT);
  });

  it('B2. [file-absent] returned value is not empty when file is absent', async () => {
    const result = await readSystemlaw(USER_DATA, stubAbsent());

    expect(result.trim().length).toBeGreaterThan(0);
  });

  it('B3. [file-absent] returns a string (not null or undefined) when file is absent', async () => {
    const result = await readSystemlaw(USER_DATA, stubAbsent());

    expect(typeof result).toBe('string');
    expect(result).not.toBeNull();
    expect(result).not.toBeUndefined();
  });

  it('B4. [file-absent] does not throw when the file is missing', async () => {
    await expect(readSystemlaw(USER_DATA, stubAbsent())).resolves.not.toThrow();
  });

  it('B5. [file-absent] SYSTEMLAW_DEFAULT is returned regardless of the userDataPath value', async () => {
    const paths = [
      '/Users/user/Library/Application Support/notepad-ai',
      '/home/user/.config/notepad-ai',
      '/tmp/empty',
      '/',
    ];
    for (const p of paths) {
      const result = await readSystemlaw(p, stubAbsent());
      expect(result).toBe(SYSTEMLAW_DEFAULT);
    }
  });
});

// ============================================================================
// C. SYSTEMLAW_DEFAULT export — content quality checks
// ============================================================================

describe('C. SYSTEMLAW_DEFAULT export — sensible default content', () => {
  it('C1. SYSTEMLAW_DEFAULT is a non-empty string', () => {
    expect(typeof SYSTEMLAW_DEFAULT).toBe('string');
    expect(SYSTEMLAW_DEFAULT.trim().length).toBeGreaterThan(0);
  });

  it('C2. SYSTEMLAW_DEFAULT is at least 50 characters (meaningful content)', () => {
    expect(SYSTEMLAW_DEFAULT.length).toBeGreaterThanOrEqual(50);
  });

  it('C3. SYSTEMLAW_DEFAULT mentions language / responds in the same language', () => {
    // The default should instruct the AI to match the user's language
    // (critical for Korean users using a Korean markdown editor).
    const lower = SYSTEMLAW_DEFAULT.toLowerCase();
    expect(
      lower.includes('language') || lower.includes('korean') || lower.includes('한국어'),
    ).toBe(true);
  });

  it('C4. SYSTEMLAW_DEFAULT does not reference Phase 2 features (overview cascade, @mention)', () => {
    // Phase 1 default must not leak Phase 2 concerns.
    expect(SYSTEMLAW_DEFAULT).not.toContain('@mention');
    expect(SYSTEMLAW_DEFAULT).not.toContain('Overview.md');
    expect(SYSTEMLAW_DEFAULT).not.toContain('cascade');
  });

  it('C5. SYSTEMLAW_DEFAULT is a stable export — same value across multiple imports', () => {
    // Reimport to confirm it is a module-level constant, not a function call.
    // We can only verify it equals itself here (idempotency).
    expect(SYSTEMLAW_DEFAULT).toBe(SYSTEMLAW_DEFAULT);
  });
});

// ============================================================================
// D. Path construction — correct file path is passed to the reader
// ============================================================================

describe('D. Path construction — systemlaw.md path is correctly resolved', () => {
  it('D1. passes path.join(userDataPath, "systemlaw.md") to the reader', async () => {
    const expectedPath = path.join(USER_DATA, 'systemlaw.md');
    const { fs, calls } = spyFs('# Rules');

    await readSystemlaw(USER_DATA, fs);

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe(expectedPath);
  });

  it('D2. passes encoding "utf-8" to the reader', async () => {
    const { fs, calls } = spyFs('# Rules');

    await readSystemlaw(USER_DATA, fs);

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
      await readSystemlaw(dir, fs);
      expect(calls[0].path).toBe(path.join(dir, 'systemlaw.md'));
    }
  });

  it('D4. the reader is called exactly once per readSystemlaw call', async () => {
    const { fs, calls } = spyFs('# Rules');

    await readSystemlaw(USER_DATA, fs);

    expect(calls).toHaveLength(1);
  });
});

// ============================================================================
// E. Error resilience — any I/O error yields the default (never throws)
// ============================================================================

describe('E. Error resilience — any I/O error returns SYSTEMLAW_DEFAULT', () => {
  it('E1. ENOENT error → returns SYSTEMLAW_DEFAULT (not throws)', async () => {
    const result = await readSystemlaw(USER_DATA, stubError(makeErrnoError('ENOENT')));

    expect(result).toBe(SYSTEMLAW_DEFAULT);
  });

  it('E2. EACCES error → returns SYSTEMLAW_DEFAULT (not throws)', async () => {
    const result = await readSystemlaw(USER_DATA, stubError(makeErrnoError('EACCES')));

    expect(result).toBe(SYSTEMLAW_DEFAULT);
  });

  it('E3. EMFILE error → returns SYSTEMLAW_DEFAULT (not re-throws)', async () => {
    // Unlike overview-reader which re-throws EMFILE, readSystemlaw swallows ALL
    // errors and returns the default — the prompt stack must never fail.
    const result = await readSystemlaw(USER_DATA, stubError(makeErrnoError('EMFILE')));

    expect(result).toBe(SYSTEMLAW_DEFAULT);
  });

  it('E4. generic Error with no code → returns SYSTEMLAW_DEFAULT', async () => {
    const result = await readSystemlaw(USER_DATA, stubError(new Error('Unexpected')));

    expect(result).toBe(SYSTEMLAW_DEFAULT);
  });

  it('E5. readSystemlaw never rejects its returned Promise', async () => {
    const errorKinds = [
      makeErrnoError('ENOENT'),
      makeErrnoError('EACCES'),
      makeErrnoError('EMFILE'),
      new Error('Unknown error'),
      new TypeError('Type error'),
    ];
    for (const err of errorKinds) {
      await expect(readSystemlaw(USER_DATA, stubError(err))).resolves.toBeDefined();
    }
  });

  it('E6. result is always a string even when an error occurs', async () => {
    const result = await readSystemlaw(USER_DATA, stubError(new Error('boom')));

    expect(typeof result).toBe('string');
  });
});

// ============================================================================
// F. Return-value type guarantees
// ============================================================================

describe('F. Return-value type guarantees', () => {
  it('F1. [file-present] return type is string', async () => {
    const fs = stubWithFile(SYSTEMLAW_PATH, '# Rules');

    const result = await readSystemlaw(USER_DATA, fs);

    expect(typeof result).toBe('string');
  });

  it('F2. [file-absent] return type is string', async () => {
    const result = await readSystemlaw(USER_DATA, stubAbsent());

    expect(typeof result).toBe('string');
  });

  it('F3. readSystemlaw returns a Promise (thenable)', () => {
    const promise = readSystemlaw(USER_DATA, stubAbsent());

    expect(typeof promise.then).toBe('function');
  });

  it('F4. result is never null or undefined regardless of scenario', async () => {
    const scenarios: FsReader[] = [
      stubWithFile(SYSTEMLAW_PATH, 'content'),
      stubAbsent(),
      stubError(new Error('boom')),
    ];
    for (const fs of scenarios) {
      const result = await readSystemlaw(USER_DATA, fs);
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
    const fs = stubWithFile(SYSTEMLAW_PATH, '# Rules');

    const first = await readSystemlaw(USER_DATA, fs);
    const second = await readSystemlaw(USER_DATA, fs);

    expect(first).toBe(second);
  });

  it('G2. same input always yields the same output (file-absent)', async () => {
    const first = await readSystemlaw(USER_DATA, stubAbsent());
    const second = await readSystemlaw(USER_DATA, stubAbsent());

    expect(first).toBe(second);
  });

  it('G3. calling readSystemlaw does not mutate the userDataPath argument', async () => {
    const original = USER_DATA;
    let captured = USER_DATA;

    await readSystemlaw(captured, stubAbsent());

    expect(captured).toBe(original);
  });

  it('G4. two concurrent calls both resolve correctly', async () => {
    const content = '# Concurrent Rules';
    const fs = stubWithFile(SYSTEMLAW_PATH, content);

    const [a, b] = await Promise.all([
      readSystemlaw(USER_DATA, fs),
      readSystemlaw(USER_DATA, fs),
    ]);

    expect(a).toBe(content);
    expect(b).toBe(content);
  });
});
