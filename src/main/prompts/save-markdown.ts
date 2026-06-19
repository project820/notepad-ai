/**
 * save-markdown.ts — userData writer for systemlaw.md and Owner.md.
 *
 * Phase 1 of notepad-ai v1.1 "Prompt Stack Foundation".
 *
 * `saveMarkdownContent` persists a markdown string to an arbitrary file path.
 * It is the counterpart to `readSystemlaw` / `readOwner`: those functions read
 * the prompt-stack files; this function writes them when the user saves edits
 * in the Settings UI.
 *
 * ─── Design notes ────────────────────────────────────────────────────────────
 *
 * DEPENDENCY INJECTION — The function accepts an optional {@link FsWriter}
 * interface rather than importing `node:fs` directly.  This allows pure
 * in-memory stubs in unit tests without touching the real filesystem.  In
 * production the default `nodeFsWriter` (backed by `node:fs/promises`) is used.
 *
 * ERROR PROPAGATION — Unlike the readers, which swallow all errors and return
 * defaults, `saveMarkdownContent` deliberately **propagates I/O errors** as
 * rejected promises.  The caller (settings IPC handler or UI layer) must decide
 * how to surface write failures to the user.  However, the error is always
 * wrapped in a rejected promise — synchronous exceptions never escape.
 *
 * EMPTY CONTENT — An empty string is a fully valid `content` argument.
 * Passing `''` writes an empty file and resolves normally — it does not throw
 * and does not skip the write.  This matches the constraint that the function
 * must "handle empty-string content gracefully (writes an empty file without
 * throwing)".
 *
 * ADDITIVE WRITES — This function writes the target file unconditionally.  The
 * "additive (new files only), never overwrite existing prefs" constraint in the
 * Seed contract applies to the prefs JSON file (managed separately by
 * session-store); it does NOT prevent overwriting systemlaw.md or Owner.md
 * because those are user-editable content files — the entire point is to let
 * the user save a new version.
 *
 * ENCODING — Always writes as UTF-8, matching the UTF-8 read in `readSystemlaw`
 * and `readOwner`.
 *
 * ROLLBACK SAFETY — This module is purely additive.  Production callers guard
 * invocations behind the `promptLayersEnabled` feature toggle so that v1.0
 * code paths are never touched when the toggle is off.
 *
 * PROCESS SAFETY — Safe to use in the Electron main process only (filesystem
 * access requires IPC from the renderer).
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *
 * ```ts
 * // Production (main process) — uses real filesystem
 * import { saveMarkdownContent } from './prompts/save-markdown';
 * import path from 'node:path';
 *
 * const filePath = path.join(app.getPath('userData'), 'systemlaw.md');
 * await saveMarkdownContent(filePath, newContent);
 * // Throws (rejected promise) on I/O failure; resolves on success.
 *
 * // Tests — inject a stub
 * import { saveMarkdownContent, type FsWriter } from './prompts/save-markdown';
 * const writes: Map<string, string> = new Map();
 * const stub: FsWriter = {
 *   writeFile: async (path, content) => { writes.set(path, content); },
 * };
 * await saveMarkdownContent('/some/path/systemlaw.md', '# Rules', stub);
 * console.log(writes.get('/some/path/systemlaw.md')); // '# Rules'
 * ```
 */

import { promises as nodefs } from 'node:fs';

// ---------------------------------------------------------------------------
// Filesystem abstraction (dependency injection)
// ---------------------------------------------------------------------------

/**
 * Minimal filesystem interface required by {@link saveMarkdownContent}.
 *
 * Production callers rely on the built-in default (`node:fs/promises`).
 * Test stubs satisfy this interface with a plain object:
 *
 * ```ts
 * const writes = new Map<string, string>();
 * const stub: FsWriter = {
 *   writeFile: async (path, content, _enc) => { writes.set(path, content); },
 * };
 * ```
 */
export interface FsWriter {
  /**
   * Writes `content` to `filePath`.
   *
   * Must reject with an `Error` when the write fails (e.g. permission denied,
   * disk full, invalid path).  Must resolve (with `void`) on success.
   *
   * @param filePath  Absolute path to the target file.
   * @param content   String content to write (may be empty string).
   * @param encoding  Character encoding — always `'utf-8'` in practice.
   */
  writeFile(filePath: string, content: string, encoding: BufferEncoding): Promise<void>;
}

/** Production filesystem writer backed by `node:fs/promises`. */
const nodeFsWriter: FsWriter = {
  writeFile: (filePath, content, encoding) => nodefs.writeFile(filePath, content, { encoding }),
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Persist `content` to the file at `filePath`.
 *
 * | Scenario                          | Behaviour                          |
 * |-----------------------------------|------------------------------------|
 * | `content` is a non-empty string   | Written verbatim; promise resolves |
 * | `content` is an empty string      | Empty file written; resolves       |
 * | `content` is `null` / `undefined` | Treated as `''`; empty file written|
 * | I/O error (EACCES, ENOENT dir, …) | Promise rejects with the Error     |
 *
 * This function **never throws synchronously**.  All errors are returned as
 * rejected promises so callers can use `await` / `.catch()` normally.
 *
 * @param filePath - Absolute path to the file to write.
 *                   Intermediate directories must already exist.
 *
 * @param content  - Markdown string to persist.  Empty string is valid and
 *                   writes an empty file.  `null` / `undefined` are
 *                   normalised to `''` (no crash).
 *
 * @param fs       - Optional {@link FsWriter} implementation.
 *                   Defaults to the real `node:fs/promises` writer.
 *                   Pass a stub in unit tests.
 *
 * @returns  A `Promise<void>` that resolves when the write completes, or
 *           rejects with the underlying `Error` when the write fails.
 *
 * @throws   Never synchronously.  Rejects asynchronously on I/O failure.
 *
 * @example
 * // Save a user-edited systemlaw
 * import { app } from 'electron';
 * import path from 'node:path';
 * import { saveMarkdownContent } from './prompts/save-markdown';
 *
 * const filePath = path.join(app.getPath('userData'), 'systemlaw.md');
 * try {
 *   await saveMarkdownContent(filePath, draftContent);
 * } catch (err) {
 *   console.error('Failed to save systemlaw.md:', err);
 * }
 */
export async function saveMarkdownContent(
  filePath: string,
  content: string,
  fs: FsWriter = nodeFsWriter,
): Promise<void> {
  // Normalise null/undefined to empty string — never crash on bad caller input.
  const normalised: string = content == null ? '' : content;

  // Delegate to the injected writer.  Any I/O error propagates as a rejected
  // promise (the `await` here re-throws the writer's rejection in this async
  // function, which becomes the rejection of the returned promise).
  await fs.writeFile(filePath, normalised, 'utf-8');
}
