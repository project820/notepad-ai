/**
 * read-systemlaw.ts — userData reader for systemlaw.md (Layer 0 of the prompt stack).
 *
 * Phase 1 of notepad-ai v1.1 "Prompt Stack Foundation".
 *
 * `readSystemlaw` reads the global AI conduct rules file (`systemlaw.md`) from
 * the provided `userDataPath` directory.  When the file is absent or unreadable,
 * the function returns a built-in default string so the rest of the prompt-stack
 * pipeline always has a valid Layer-0 string — it never throws, never returns
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
 * to return `SYSTEMLAW_DEFAULT` rather than propagating the error.  The caller
 * should only see an error if something structurally impossible went wrong (which
 * should never happen in practice).
 *
 * ROLLBACK SAFETY — This module is purely additive.  Callers guard invocations
 * behind the `promptLayersEnabled` feature toggle.  When the toggle is off, v1.0
 * code paths are completely unaffected.
 *
 * PROCESS SAFETY — Safe to use in the Electron main process only (filesystem
 * access is not available in the renderer process without IPC).
 *
 * ─── Layer mapping ───────────────────────────────────────────────────────────
 *
 *   Layer 0 — systemlaw  ←  userData/systemlaw.md  (this file reads that)
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *
 * ```ts
 * // Production (main process) — uses real filesystem
 * import { readSystemlaw } from './prompts/read-systemlaw';
 * const content = await readSystemlaw(app.getPath('userData'));
 *
 * // Tests — inject a stub
 * import { readSystemlaw, type FsReader } from './prompts/read-systemlaw';
 * const stub: FsReader = { readFile: async () => '# My Rules\n...' };
 * const content = await readSystemlaw('/any/path', stub);
 * ```
 */

import { promises as nodefs } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Filesystem abstraction (dependency injection)
// ---------------------------------------------------------------------------

/**
 * Minimal filesystem interface required by {@link readSystemlaw}.
 *
 * Production callers rely on the built-in default (`node:fs/promises`).
 * Test stubs satisfy this interface with a plain object:
 *
 * ```ts
 * const stub: FsReader = {
 *   readFile: async (_path, _enc) => '## Rules\nBe helpful.',
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
 * The built-in fallback content returned when `userData/systemlaw.md` is
 * absent or unreadable.
 *
 * This default gives any AI surface a minimal set of sensible conduct rules so
 * the app is usable even on first launch before the user has configured their
 * own systemlaw.  It is intentionally brief so it does not override the user's
 * intent once they edit the file.
 *
 * Exported so that callers and tests can compare against it without
 * hard-coding the string.
 */
export const SYSTEMLAW_DEFAULT =
  `# AI Conduct Rules (default)

You are a professional writing assistant embedded in a Markdown editor.

- Respond in the same language the user is writing in (Korean or English).
- Be concise, accurate, and helpful.
- Preserve the user's original intent, structure, and formatting.
- When editing, maintain the professional register of the original text.`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read the `systemlaw.md` file from `userDataPath`.
 *
 * | Scenario                               | Return value             |
 * |----------------------------------------|--------------------------|
 * | File present, any content              | File content as string   |
 * | File absent (ENOENT) or inaccessible   | `SYSTEMLAW_DEFAULT`      |
 * | Any other I/O error                    | `SYSTEMLAW_DEFAULT`      |
 *
 * This function **never throws** and **never returns** `null` or `undefined`.
 *
 * @param userDataPath - Absolute path to the Electron `userData` directory.
 *                       The filename `systemlaw.md` is appended automatically.
 *
 * @param fs           - Optional {@link FsReader} implementation.
 *                       Defaults to the real `node:fs/promises` reader.
 *                       Pass a stub in unit tests.
 *
 * @returns  A `Promise<string>` that resolves to either the file content or
 *           `SYSTEMLAW_DEFAULT`.  The promise itself never rejects.
 *
 * @example
 * // Production usage
 * import { app } from 'electron';
 * import { readSystemlaw } from './prompts/read-systemlaw';
 *
 * const content = await readSystemlaw(app.getPath('userData'));
 * // content is the file text or SYSTEMLAW_DEFAULT — never null/undefined
 */
export async function readSystemlaw(
  userDataPath: string,
  fs: FsReader = nodeFsReader,
): Promise<string> {
  const filePath = path.join(userDataPath, 'systemlaw.md');

  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    // Any error (file absent, permissions, disk error, …) → safe default.
    return SYSTEMLAW_DEFAULT;
  }
}
