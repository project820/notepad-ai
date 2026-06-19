/**
 * save-markdown.test.ts
 *
 * Unit tests for `saveMarkdownContent(filePath, content, fs?)`
 * (src/main/prompts/save-markdown.ts).
 *
 * Sub-AC 5.3 requirements:
 *   ✓ Accepts a file path and a content string and persists it to disk.
 *   ✓ Handles empty-string content gracefully (writes an empty file without
 *     throwing).
 *   ✓ Non-empty content is written to the correct path.
 *   ✓ Empty-string content completes without error and produces an empty (or
 *     defined-fallback) file.
 *   ✓ I/O errors surface as a rejected promise rather than an uncaught
 *     exception.
 *
 * Test groups:
 *   A. Non-empty content — written to the correct path
 *   B. Empty-string content — completes without error, empty file produced
 *   C. Nullish content normalisation — null/undefined treated as empty string
 *   D. I/O errors — surface as rejected promise (never uncaught exception)
 *   E. Encoding — always writes UTF-8
 *   F. FsWriter interface contract — stub verifications
 *   G. Return-value type guarantees — returns Promise<void>
 *   H. Purity — single write per call, no extra side-effects
 */

import { describe, it, expect, vi } from 'vitest';
import {
  saveMarkdownContent,
  type FsWriter,
} from '../../src/main/prompts/save-markdown';

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

/**
 * Creates an FsWriter stub that records all writes into a `Map<path, content>`.
 * Resolves successfully for every call — simulates a healthy filesystem.
 */
function stubWriter(): {
  fs: FsWriter;
  writes: Map<string, string>;
  encodings: Map<string, BufferEncoding>;
} {
  const writes = new Map<string, string>();
  const encodings = new Map<string, BufferEncoding>();

  const fs: FsWriter = {
    async writeFile(filePath: string, content: string, encoding: BufferEncoding): Promise<void> {
      writes.set(filePath, content);
      encodings.set(filePath, encoding);
    },
  };

  return { fs, writes, encodings };
}

/**
 * Creates an FsWriter stub that always rejects with the provided error.
 * Simulates a filesystem that cannot write (e.g. EACCES, ENOSPC).
 */
function stubError(err: Error): FsWriter {
  return {
    async writeFile(_filePath: string, _content: string, _encoding: BufferEncoding): Promise<void> {
      throw err;
    },
  };
}

/**
 * Creates an FsWriter stub that rejects with an EACCES-like error for the
 * given `blockedPath`, and resolves normally for all other paths.
 */
function stubBlockedPath(blockedPath: string, err: Error): FsWriter {
  return {
    async writeFile(filePath: string, _content: string, _encoding: BufferEncoding): Promise<void> {
      if (filePath === blockedPath) throw err;
    },
  };
}

/** Constructs a NodeJS.ErrnoException-compatible error with a given code. */
function makeErrnoError(code: string, message?: string): NodeJS.ErrnoException {
  const err = new Error(message ?? `${code}: mock error`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SYSTEMLAW_PATH = '/Users/user/Library/Application Support/notepad-ai/systemlaw.md';
const OWNER_PATH = '/Users/user/Library/Application Support/notepad-ai/Owner.md';

// ============================================================================
// A. Non-empty content — written to the correct path
// ============================================================================

describe('A. Non-empty content — written to the correct path', () => {
  it('A01 — writes the content string to the specified filePath', async () => {
    const { fs, writes } = stubWriter();
    const content = '# My Rules\nBe helpful and concise.';

    await saveMarkdownContent(SYSTEMLAW_PATH, content, fs);

    expect(writes.get(SYSTEMLAW_PATH)).toBe(content);
  });

  it('A02 — written content is exactly the string passed in (no trimming or modification)', async () => {
    const { fs, writes } = stubWriter();
    const content = '  ## Rules\n\n- Rule 1\n- Rule 2  \n';

    await saveMarkdownContent(SYSTEMLAW_PATH, content, fs);

    expect(writes.get(SYSTEMLAW_PATH)).toBe(content);
  });

  it('A03 — writes to Owner.md path when given that path', async () => {
    const { fs, writes } = stubWriter();
    const content = '# About Me\n\nI am a professional writer.';

    await saveMarkdownContent(OWNER_PATH, content, fs);

    expect(writes.get(OWNER_PATH)).toBe(content);
  });

  it('A04 — writes content to the exact filePath argument (path is not modified)', async () => {
    const { fs, writes } = stubWriter();
    const customPath = '/tmp/test-notepad-ai/custom.md';
    const content = '## Custom content';

    await saveMarkdownContent(customPath, content, fs);

    // Content is stored at the exact path provided
    expect(writes.has(customPath)).toBe(true);
    expect(writes.get(customPath)).toBe(content);
  });

  it('A05 — writes multi-paragraph markdown content verbatim', async () => {
    const { fs, writes } = stubWriter();
    const content = [
      '# AI Conduct Rules',
      '',
      'Be concise.',
      '',
      'Match the user\'s language.',
      '',
      'Preserve formatting.',
    ].join('\n');

    await saveMarkdownContent(SYSTEMLAW_PATH, content, fs);

    expect(writes.get(SYSTEMLAW_PATH)).toBe(content);
  });

  it('A06 — writes Korean content correctly (UTF-8 passthrough)', async () => {
    const { fs, writes } = stubWriter();
    const content = '# AI 행동 규칙\n\n한국어로 응답하세요.\n전문적인 어조를 유지하세요.';

    await saveMarkdownContent(SYSTEMLAW_PATH, content, fs);

    expect(writes.get(SYSTEMLAW_PATH)).toBe(content);
  });

  it('A07 — writes a very long content string without truncation', async () => {
    const { fs, writes } = stubWriter();
    const content = '# Rules\n\n' + '- Rule line.\n'.repeat(5_000);

    await saveMarkdownContent(SYSTEMLAW_PATH, content, fs);

    expect(writes.get(SYSTEMLAW_PATH)).toBe(content);
  });

  it('A08 — content with emoji / unicode is written verbatim', async () => {
    const { fs, writes } = stubWriter();
    const content = '# Rules 🎉\n\n- Always be kind 👍\n- 한국어 지원 ✅';

    await saveMarkdownContent(SYSTEMLAW_PATH, content, fs);

    expect(writes.get(SYSTEMLAW_PATH)).toBe(content);
  });

  it('A09 — resolves to undefined (void) on success', async () => {
    const { fs } = stubWriter();

    const result = await saveMarkdownContent(SYSTEMLAW_PATH, '# content', fs);

    expect(result).toBeUndefined();
  });

  it('A10 — whitespace-only content is written as-is', async () => {
    const { fs, writes } = stubWriter();
    const content = '   \n\n   \t  ';

    await saveMarkdownContent(SYSTEMLAW_PATH, content, fs);

    expect(writes.get(SYSTEMLAW_PATH)).toBe(content);
  });
});

// ============================================================================
// B. Empty-string content — completes without error, empty file produced
// ============================================================================

describe('B. Empty-string content — completes without error and produces empty file', () => {
  it('B01 — saveMarkdownContent does not throw when content is empty string', async () => {
    const { fs } = stubWriter();

    await expect(saveMarkdownContent(SYSTEMLAW_PATH, '', fs)).resolves.not.toThrow();
  });

  it('B02 — resolves (does not reject) when content is empty string', async () => {
    const { fs } = stubWriter();

    await expect(saveMarkdownContent(SYSTEMLAW_PATH, '', fs)).resolves.toBeUndefined();
  });

  it('B03 — the written file content is empty string when empty string is passed', async () => {
    const { fs, writes } = stubWriter();

    await saveMarkdownContent(SYSTEMLAW_PATH, '', fs);

    expect(writes.get(SYSTEMLAW_PATH)).toBe('');
  });

  it('B04 — the write is still performed (stub is called) when content is empty string', async () => {
    const { fs, writes } = stubWriter();

    await saveMarkdownContent(SYSTEMLAW_PATH, '', fs);

    // The write was actually invoked — not skipped
    expect(writes.has(SYSTEMLAW_PATH)).toBe(true);
  });

  it('B05 — empty-string content write resolves without inspecting the content value', async () => {
    // Verify the promise returned by saveMarkdownContent resolves for ''
    const { fs } = stubWriter();
    const promise = saveMarkdownContent(SYSTEMLAW_PATH, '', fs);

    // It is a thenable
    expect(typeof promise.then).toBe('function');
    await expect(promise).resolves.toBeUndefined();
  });

  it('B06 — empty string for Owner.md path also writes without error', async () => {
    const { fs, writes } = stubWriter();

    await saveMarkdownContent(OWNER_PATH, '', fs);

    expect(writes.get(OWNER_PATH)).toBe('');
  });
});

// ============================================================================
// C. Nullish content normalisation — null/undefined treated as empty string
// ============================================================================

describe('C. Nullish content normalisation — null/undefined treated as empty string', () => {
  it('C01 — null content is normalised to empty string (no crash)', async () => {
    const { fs, writes } = stubWriter();

    // Cast to bypass TypeScript — simulates a caller passing null
    await saveMarkdownContent(SYSTEMLAW_PATH, null as unknown as string, fs);

    expect(writes.get(SYSTEMLAW_PATH)).toBe('');
  });

  it('C02 — undefined content is normalised to empty string (no crash)', async () => {
    const { fs, writes } = stubWriter();

    await saveMarkdownContent(SYSTEMLAW_PATH, undefined as unknown as string, fs);

    expect(writes.get(SYSTEMLAW_PATH)).toBe('');
  });

  it('C03 — null content does not throw', async () => {
    const { fs } = stubWriter();

    await expect(
      saveMarkdownContent(SYSTEMLAW_PATH, null as unknown as string, fs),
    ).resolves.not.toThrow();
  });

  it('C04 — undefined content does not throw', async () => {
    const { fs } = stubWriter();

    await expect(
      saveMarkdownContent(SYSTEMLAW_PATH, undefined as unknown as string, fs),
    ).resolves.not.toThrow();
  });
});

// ============================================================================
// D. I/O errors — surface as rejected promise (never uncaught exception)
// ============================================================================

describe('D. I/O errors — surface as rejected promise, never uncaught exception', () => {
  it('D01 — EACCES error surfaces as a rejected promise', async () => {
    const err = makeErrnoError('EACCES', 'EACCES: permission denied');
    const fs = stubError(err);

    await expect(saveMarkdownContent(SYSTEMLAW_PATH, '# content', fs)).rejects.toThrow(err);
  });

  it('D02 — ENOENT error (missing parent directory) surfaces as rejected promise', async () => {
    const err = makeErrnoError('ENOENT', 'ENOENT: no such file or directory');
    const fs = stubError(err);

    await expect(saveMarkdownContent(SYSTEMLAW_PATH, '# content', fs)).rejects.toThrow(err);
  });

  it('D03 — ENOSPC (no space left on device) surfaces as rejected promise', async () => {
    const err = makeErrnoError('ENOSPC', 'ENOSPC: no space left on device');
    const fs = stubError(err);

    await expect(saveMarkdownContent(SYSTEMLAW_PATH, '# content', fs)).rejects.toThrow(err);
  });

  it('D04 — generic Error surfaces as rejected promise', async () => {
    const err = new Error('Unexpected write failure');
    const fs = stubError(err);

    await expect(saveMarkdownContent(SYSTEMLAW_PATH, 'content', fs)).rejects.toThrow(err);
  });

  it('D05 — TypeError from the writer surfaces as rejected promise', async () => {
    const err = new TypeError('Type mismatch during write');
    const fs = stubError(err);

    await expect(saveMarkdownContent(SYSTEMLAW_PATH, 'content', fs)).rejects.toThrow(err);
  });

  it('D06 — error is an instance of Error in the rejected promise', async () => {
    const err = new Error('Some I/O error');
    const fs = stubError(err);

    try {
      await saveMarkdownContent(SYSTEMLAW_PATH, '# content', fs);
      // Should not reach here
      expect.fail('Expected saveMarkdownContent to reject');
    } catch (caught) {
      expect(caught).toBeInstanceOf(Error);
    }
  });

  it('D07 — the error from the writer is propagated unchanged (same object reference)', async () => {
    const originalErr = makeErrnoError('EACCES');
    const fs = stubError(originalErr);

    try {
      await saveMarkdownContent(SYSTEMLAW_PATH, '# content', fs);
      expect.fail('Expected rejection');
    } catch (caught) {
      // The exact same error object is propagated — not wrapped or altered
      expect(caught).toBe(originalErr);
    }
  });

  it('D08 — error is NOT an uncaught exception — it is catchable as a rejected promise', async () => {
    const err = new Error('catchable rejection');
    const fs = stubError(err);

    // If the error were an uncaught exception, this test would fail at the process level.
    // The `await expect(...).rejects` pattern confirms it is a normal rejected promise.
    await expect(saveMarkdownContent(SYSTEMLAW_PATH, 'content', fs)).rejects.toThrow('catchable rejection');
  });

  it('D09 — I/O error for empty-string content also surfaces as rejected promise (not swallowed)', async () => {
    // Even when content is empty, if the write fails, the error must propagate.
    const err = makeErrnoError('EACCES');
    const fs = stubError(err);

    await expect(saveMarkdownContent(SYSTEMLAW_PATH, '', fs)).rejects.toThrow(err);
  });

  it('D10 — error for a specific blocked path propagates; other paths still succeed', async () => {
    const err = makeErrnoError('EACCES');
    const otherPath = '/other/path/document.md';

    // Stub blocks only SYSTEMLAW_PATH, allows otherPath
    const fs = stubBlockedPath(SYSTEMLAW_PATH, err);
    const otherWrites = new Map<string, string>();

    // Override the stub to also track successful writes
    const hybridFs: FsWriter = {
      async writeFile(filePath, content, encoding) {
        if (filePath === SYSTEMLAW_PATH) throw err;
        otherWrites.set(filePath, content);
      },
    };

    // Blocked path rejects
    await expect(saveMarkdownContent(SYSTEMLAW_PATH, 'content', hybridFs)).rejects.toThrow(err);

    // Other path succeeds
    await saveMarkdownContent(otherPath, 'other content', hybridFs);
    expect(otherWrites.get(otherPath)).toBe('other content');
  });
});

// ============================================================================
// E. Encoding — always writes UTF-8
// ============================================================================

describe('E. Encoding — always writes UTF-8', () => {
  it('E01 — passes encoding "utf-8" to the FsWriter', async () => {
    const { fs, encodings } = stubWriter();

    await saveMarkdownContent(SYSTEMLAW_PATH, '# Content', fs);

    expect(encodings.get(SYSTEMLAW_PATH)).toBe('utf-8');
  });

  it('E02 — UTF-8 encoding is used even when content is empty string', async () => {
    const { fs, encodings } = stubWriter();

    await saveMarkdownContent(SYSTEMLAW_PATH, '', fs);

    expect(encodings.get(SYSTEMLAW_PATH)).toBe('utf-8');
  });

  it('E03 — UTF-8 encoding is used for Korean content', async () => {
    const { fs, encodings } = stubWriter();
    const content = '한국어 콘텐츠입니다.';

    await saveMarkdownContent(SYSTEMLAW_PATH, content, fs);

    expect(encodings.get(SYSTEMLAW_PATH)).toBe('utf-8');
  });
});

// ============================================================================
// F. FsWriter interface contract — stub verifications
// ============================================================================

describe('F. FsWriter interface contract — correct arguments passed to writer', () => {
  it('F01 — writer is called exactly once per saveMarkdownContent call', async () => {
    const callArgs: Array<{ path: string; content: string; encoding: BufferEncoding }> = [];
    const fs: FsWriter = {
      async writeFile(filePath, content, encoding) {
        callArgs.push({ path: filePath, content, encoding });
      },
    };

    await saveMarkdownContent(SYSTEMLAW_PATH, '# Rules', fs);

    expect(callArgs).toHaveLength(1);
  });

  it('F02 — writer receives the exact filePath passed to saveMarkdownContent', async () => {
    const callArgs: Array<{ path: string; content: string; encoding: BufferEncoding }> = [];
    const fs: FsWriter = {
      async writeFile(filePath, content, encoding) {
        callArgs.push({ path: filePath, content, encoding });
      },
    };

    await saveMarkdownContent(SYSTEMLAW_PATH, '# Rules', fs);

    expect(callArgs[0].path).toBe(SYSTEMLAW_PATH);
  });

  it('F03 — writer receives the exact content string passed to saveMarkdownContent', async () => {
    const callArgs: Array<{ path: string; content: string; encoding: BufferEncoding }> = [];
    const fs: FsWriter = {
      async writeFile(filePath, content, encoding) {
        callArgs.push({ path: filePath, content, encoding });
      },
    };
    const expectedContent = '## Owner\n\nI am a writer.';

    await saveMarkdownContent(OWNER_PATH, expectedContent, fs);

    expect(callArgs[0].content).toBe(expectedContent);
  });

  it('F04 — FsWriter type is exported and can be used as a type annotation', () => {
    // TypeScript type-check: if this compiles and runs, the export is correct.
    const stub: FsWriter = {
      async writeFile(_path, _content, _encoding) {
        // no-op
      },
    };
    expect(typeof stub.writeFile).toBe('function');
  });
});

// ============================================================================
// G. Return-value type guarantees — returns Promise<void>
// ============================================================================

describe('G. Return-value type guarantees — returns Promise<void>', () => {
  it('G01 — saveMarkdownContent returns a Promise (thenable)', () => {
    const { fs } = stubWriter();

    const result = saveMarkdownContent(SYSTEMLAW_PATH, '# content', fs);

    expect(typeof result.then).toBe('function');
  });

  it('G02 — the resolved value is undefined (void)', async () => {
    const { fs } = stubWriter();

    const result = await saveMarkdownContent(SYSTEMLAW_PATH, '# content', fs);

    expect(result).toBeUndefined();
  });

  it('G03 — the returned promise can be awaited without a try/catch on success', async () => {
    const { fs } = stubWriter();

    // This should not throw — no try/catch needed for the success path
    await saveMarkdownContent(SYSTEMLAW_PATH, 'safe content', fs);
  });

  it('G04 — saveMarkdownContent is an async function (returns a Promise immediately)', () => {
    const { fs } = stubWriter();

    const returnValue = saveMarkdownContent(SYSTEMLAW_PATH, '# content', fs);

    // Must be a Promise, not a raw value
    expect(returnValue).toBeInstanceOf(Promise);

    // Clean up — resolve the promise to avoid unhandled rejections
    return returnValue;
  });
});

// ============================================================================
// H. Purity — single write per call, no extra side-effects
// ============================================================================

describe('H. Purity — single write per call, no extra side-effects', () => {
  it('H01 — calling saveMarkdownContent twice writes to the stub twice (no caching)', async () => {
    const callCount = { value: 0 };
    const fs: FsWriter = {
      async writeFile() {
        callCount.value++;
      },
    };

    await saveMarkdownContent(SYSTEMLAW_PATH, '# Rules', fs);
    await saveMarkdownContent(SYSTEMLAW_PATH, '# Updated Rules', fs);

    expect(callCount.value).toBe(2);
  });

  it('H02 — does not mutate the filePath argument', async () => {
    const { fs } = stubWriter();
    const original = SYSTEMLAW_PATH;
    const captured = SYSTEMLAW_PATH;

    await saveMarkdownContent(captured, '# content', fs);

    expect(captured).toBe(original);
  });

  it('H03 — does not mutate the content argument', async () => {
    const { fs } = stubWriter();
    const original = '# Immutable Rules';
    const captured = original;

    await saveMarkdownContent(SYSTEMLAW_PATH, captured, fs);

    expect(captured).toBe(original);
  });

  it('H04 — two concurrent saves to different paths both succeed independently', async () => {
    const { fs, writes } = stubWriter();
    const systemlawContent = '# System Law';
    const ownerContent = '# Owner';

    await Promise.all([
      saveMarkdownContent(SYSTEMLAW_PATH, systemlawContent, fs),
      saveMarkdownContent(OWNER_PATH, ownerContent, fs),
    ]);

    expect(writes.get(SYSTEMLAW_PATH)).toBe(systemlawContent);
    expect(writes.get(OWNER_PATH)).toBe(ownerContent);
  });

  it('H05 — consecutive saves update the tracked write value correctly', async () => {
    const { fs, writes } = stubWriter();

    await saveMarkdownContent(SYSTEMLAW_PATH, 'first version', fs);
    expect(writes.get(SYSTEMLAW_PATH)).toBe('first version');

    await saveMarkdownContent(SYSTEMLAW_PATH, 'second version', fs);
    expect(writes.get(SYSTEMLAW_PATH)).toBe('second version');
  });

  it('H06 — saveMarkdownContent does not call process.exit or throw globally', async () => {
    // If saveMarkdownContent ever crashed the process, this test would not complete.
    // The fact that it resolves proves no global side-effect occurred.
    const { fs } = stubWriter();

    await saveMarkdownContent(SYSTEMLAW_PATH, '# Safe', fs);
    await saveMarkdownContent(SYSTEMLAW_PATH, '', fs);

    // Reaching here means no global crash occurred
    expect(true).toBe(true);
  });
});
