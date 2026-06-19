/**
 * overview-reader.ts
 *
 * Filesystem-backed reader for a single Overview.md file at a given directory.
 * Returns a parsed {@link OverviewMap} when the file is present, or `null`
 * when the file is absent (ENOENT / EACCES).
 *
 * ─── Design notes ───────────────────────────────────────────────────────────
 * DEPENDENCY INJECTION — The function accepts a {@link FsReader} interface
 * rather than importing `node:fs` directly.  This enables pure in-memory stubs
 * in unit tests without touching the real filesystem.
 *
 * PURE DATA — The returned {@link OverviewMap} is produced by the pure
 * {@link parseOverview} function which never throws.  Malformed or empty files
 * therefore return an empty-but-valid map (`{ fields: {}, sections: {} }`) rather
 * than `null`.  Only a missing file (ENOENT) or inaccessible file (EACCES) yields
 * `null`.
 *
 * ROLLBACK SAFETY — This module is purely additive.  Callers guard invocations
 * behind the `promptLayersEnabled` feature toggle.  Absent or disabled, v1.0
 * code paths are completely unaffected.  The module itself has no toggle
 * awareness and is independently disable-able by simply not calling it.
 *
 * PROCESS SAFETY — Safe to use in the Electron main process only (filesystem
 * access is not available in the renderer process without IPC).
 */

import path from 'node:path';
import { parseOverview, type OverviewMap } from './overview-parser';

// ---------------------------------------------------------------------------
// Filesystem abstraction
// ---------------------------------------------------------------------------

/**
 * Minimal filesystem interface required by {@link readOverviewAt}.
 *
 * Production callers pass the `node:fs/promises` module directly:
 * ```ts
 * import { promises as nodefs } from 'node:fs';
 * const map = await readOverviewAt(dirPath, nodefs);
 * ```
 *
 * Test stubs satisfy this interface with a plain object:
 * ```ts
 * const stubFs: FsReader = {
 *   readFile: async (p, _enc) => myStubContent,
 * };
 * ```
 */
export interface FsReader {
  /**
   * Reads the entire contents of a file.
   * Must throw an `ErrnoException`-compatible error with `code === 'ENOENT'`
   * when the file does not exist, so that {@link readOverviewAt} can
   * distinguish "absent" from other failure modes.
   *
   * @param filePath  Absolute path to the file to read.
   * @param encoding  Character encoding — always `'utf-8'` in practice.
   * @returns         The file content as a string.
   */
  readFile(filePath: string, encoding: BufferEncoding): Promise<string>;
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

/**
 * Narrows `unknown` to `NodeJS.ErrnoException` for safe `code` access.
 */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return (
    err instanceof Error &&
    'code' in err &&
    typeof (err as NodeJS.ErrnoException).code === 'string'
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reads the `Overview.md` file in the given directory using the provided
 * filesystem interface and returns a parsed {@link OverviewMap}.
 *
 * Behaviour by case:
 * | Scenario                              | Return value                        |
 * |---------------------------------------|-------------------------------------|
 * | File present, well-formed content     | Populated `OverviewMap`             |
 * | File present, empty / malformed       | `{ fields: {}, sections: {} }`      |
 * | File absent (ENOENT)                  | `null`                              |
 * | File inaccessible (EACCES)            | `null`                              |
 * | Other I/O error                       | Re-throws the original error        |
 *
 * @param dirPath - Absolute path to the directory that may contain an
 *                  `Overview.md` file.  The filename `Overview.md` is
 *                  appended automatically via `path.join`.
 *
 * @param fs      - A {@link FsReader} implementation.  Pass `node:fs/promises`
 *                  in production code, or a stub object in unit tests.
 *
 * @returns A {@link OverviewMap} when the file exists (possibly empty when
 *          the content is malformed or whitespace-only), or `null` when the
 *          file is absent or inaccessible.
 *
 * @throws Re-throws any I/O error that is NOT an `ENOENT` / `EACCES` condition
 *         (e.g. `EMFILE`, `EIO`, unexpected errors from a stub).
 *
 * @example
 * // Production usage (main process only)
 * import { promises as nodefs } from 'node:fs';
 * const map = await readOverviewAt('/workspace/project', nodefs);
 * if (map !== null) {
 *   // inject map into prompt stack
 * }
 *
 * @example
 * // Test usage with an in-memory stub
 * const stub: FsReader = {
 *   readFile: async () => 'tone: formal\n\n## Style\nBe direct.',
 * };
 * const map = await readOverviewAt('/any/dir', stub);
 * // map.fields.tone === 'formal'
 */
export async function readOverviewAt(
  dirPath: string,
  fs: FsReader,
): Promise<OverviewMap | null> {
  const overviewPath = path.join(dirPath, 'Overview.md');

  let content: string;
  try {
    content = await fs.readFile(overviewPath, 'utf-8');
  } catch (err: unknown) {
    if (isErrnoException(err) && (err.code === 'ENOENT' || err.code === 'EACCES')) {
      // File is absent or inaccessible — signal "not found" to callers.
      return null;
    }
    // Unexpected I/O errors propagate so callers can decide how to handle them.
    throw err;
  }

  // parseOverview is a total function — it never throws regardless of content.
  return parseOverview(content);
}
