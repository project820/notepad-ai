/**
 * read-owner.ts — userData reader for Owner.md (Layer 1 of the prompt stack).
 *
 * Phase 1 of notepad-ai v1.1 "Prompt Stack Foundation".
 *
 * `readOwner` reads the user-persona file (`Owner.md`) from the provided
 * `userDataPath` directory.  When the file is absent or unreadable, the
 * function returns a built-in default string so the rest of the prompt-stack
 * pipeline always has a valid Layer-1 string — it never throws, never returns
 * `null`, and never returns `undefined`.
 *
 * ─── Design notes ────────────────────────────────────────────────────────────
 *
 * DEPENDENCY INJECTION — The function accepts an optional {@link FsReader}
 * interface rather than importing `node:fs` directly.  This allows pure
 * in-memory stubs in unit tests without touching the real filesystem.  In
 * production the default `nodeFsReader` (backed by `node:fs/promises`) is used.
 *
 * GRACEFUL FALLBACK — Any I/O error (ENOENT, EACCES, …) causes the function
 * to return `OWNER_DEFAULT` rather than propagating the error.  The caller
 * should only see an error if something structurally impossible went wrong
 * (which should never happen in practice).
 *
 * ROLLBACK SAFETY — This module is purely additive.  Callers guard invocations
 * behind the `promptLayersEnabled` feature toggle.  When the toggle is off,
 * v1.0 code paths are completely unaffected.
 *
 * PROCESS SAFETY — Safe to use in the Electron main process only (filesystem
 * access is not available in the renderer process without IPC).
 *
 * ─── Layer mapping ───────────────────────────────────────────────────────────
 *
 *   Layer 1 — owner  ←  userData/Owner.md  (this file reads that)
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *
 * ```ts
 * // Production (main process) — uses real filesystem
 * import { readOwner } from './prompts/read-owner';
 * const content = await readOwner(app.getPath('userData'));
 *
 * // Tests — inject a stub
 * import { readOwner, type FsReader } from './prompts/read-owner';
 * const stub: FsReader = { readFile: async () => '# About Me\n...' };
 * const content = await readOwner('/any/path', stub);
 * ```
 */

import { promises as nodefs } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Filesystem abstraction (dependency injection)
// ---------------------------------------------------------------------------

/**
 * Minimal filesystem interface required by {@link readOwner}.
 *
 * Production callers rely on the built-in default (`node:fs/promises`).
 * Test stubs satisfy this interface with a plain object:
 *
 * ```ts
 * const stub: FsReader = {
 *   readFile: async (_path, _enc) => '## About Me\nI am a professional writer.',
 * };
 * ```
 */
export interface FsReader {
  /**
   * Reads the entire contents of a file as a string.
   * Must throw any `Error` when the file does not exist or is unreadable.
   *
   * @param filePath  Absolute path to the file to read.
   * @param encoding  Character encoding — always `'utf-8'` in practice.
   * @returns         The file content as a string.
   */
  readFile(filePath: string, encoding: BufferEncoding): Promise<string>;
}

/** Production filesystem reader backed by `node:fs/promises`. */
const nodeFsReader: FsReader = {
  readFile: (filePath, encoding) => nodefs.readFile(filePath, encoding),
};

// ---------------------------------------------------------------------------
// Default content
// ---------------------------------------------------------------------------

/**
 * The built-in fallback content returned when `userData/Owner.md` is
 * absent or unreadable.
 *
 * This default gives any AI surface a minimal user persona so the app is
 * usable even on first launch before the user has configured their own
 * Owner.md.  It is intentionally brief so it does not override the user's
 * intent once they edit the file.
 *
 * Exported so that callers and tests can compare against it without
 * hard-coding the string.
 */
export const OWNER_DEFAULT =
  `# About the Author (default)

I am a professional writer working with Markdown documents.

- I may write in Korean or English depending on the document.
- I value clear, concise, and well-structured writing.
- I work with a range of document types including reports, memos, and articles.`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read the `Owner.md` file from `userDataPath`.
 *
 * | Scenario                               | Return value         |
 * |----------------------------------------|----------------------|
 * | File present, any content              | File content as string |
 * | File absent (ENOENT) or inaccessible   | `OWNER_DEFAULT`      |
 * | Any other I/O error                    | `OWNER_DEFAULT`      |
 *
 * This function **never throws** and **never returns** `null` or `undefined`.
 *
 * @param userDataPath - Absolute path to the Electron `userData` directory.
 *                       The filename `Owner.md` is appended automatically.
 *
 * @param fs           - Optional {@link FsReader} implementation.
 *                       Defaults to the real `node:fs/promises` reader.
 *                       Pass a stub in unit tests.
 *
 * @returns  A `Promise<string>` that resolves to either the file content or
 *           `OWNER_DEFAULT`.  The promise itself never rejects.
 *
 * @example
 * // Production usage
 * import { app } from 'electron';
 * import { readOwner } from './prompts/read-owner';
 *
 * const content = await readOwner(app.getPath('userData'));
 * // content is the file text or OWNER_DEFAULT — never null/undefined
 */
export async function readOwner(
  userDataPath: string,
  fs: FsReader = nodeFsReader,
): Promise<string> {
  const filePath = path.join(userDataPath, 'Owner.md');

  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    // Any error (file absent, permissions, disk error, …) → safe default.
    return OWNER_DEFAULT;
  }
}
