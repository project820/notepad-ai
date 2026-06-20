/**
 * file-tree.test.ts
 *
 * Unit tests for the main-process file-tree helpers (G004):
 *   - buildDirectoryListing: noise hidden, directories-first, name-sorted, with
 *     per-entry ext/openable/kind.
 *   - isWithinRoot: path-traversal containment.
 *   - listDirectory: root-containment rejection + a real one-level readdir.
 *   - isSafeLocalAbsolutePath: shell.openPath / open-in-current path gate.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildDirectoryListing,
  isSafeLocalAbsolutePath,
  isWithinRoot,
  listDirectory,
  type FileTreeEntry,
} from '../main/file-tree';

// ============================================================================
// A. buildDirectoryListing (pure: filter + map + sort)
// ============================================================================

describe('buildDirectoryListing', () => {
  const DIR = '/ws/project';
  const raw = [
    { name: 'beta.md', isDir: false },
    { name: 'Zeta', isDir: true },
    { name: '.hidden', isDir: false },
    { name: '.git', isDir: true },
    { name: 'node_modules', isDir: true },
    { name: 'alpha.txt', isDir: false },
    { name: 'apple', isDir: true },
    { name: 'photo.png', isDir: false },
  ];

  it('hides dotfiles, dot-directories, and node_modules', () => {
    const names = buildDirectoryListing(raw, DIR).map((e) => e.name);
    expect(names).not.toContain('.hidden');
    expect(names).not.toContain('.git');
    expect(names).not.toContain('node_modules');
  });

  it('sorts directories first, then names case-insensitively', () => {
    const names = buildDirectoryListing(raw, DIR).map((e) => e.name);
    expect(names).toEqual(['apple', 'Zeta', 'alpha.txt', 'beta.md', 'photo.png']);
  });

  it('builds absolute paths and per-entry ext/openable/kind', () => {
    const byName = new Map(buildDirectoryListing(raw, DIR).map((e) => [e.name, e] as const));

    expect(byName.get('beta.md')).toMatchObject<Partial<FileTreeEntry>>({
      path: path.join(DIR, 'beta.md'),
      isDir: false,
      ext: 'md',
      openable: true,
      kind: 'markdown',
    });
    expect(byName.get('apple')).toMatchObject<Partial<FileTreeEntry>>({
      path: path.join(DIR, 'apple'),
      isDir: true,
      ext: '',
      openable: false,
      kind: 'folder',
    });
    // Non-openable files stay visible but are flagged for shell.openPath.
    expect(byName.get('photo.png')).toMatchObject<Partial<FileTreeEntry>>({
      isDir: false,
      ext: 'png',
      openable: false,
      kind: 'other',
    });
  });
});

// ============================================================================
// B. isWithinRoot (path traversal containment)
// ============================================================================

describe('isWithinRoot', () => {
  it('accepts the root itself and descendants', () => {
    expect(isWithinRoot('/root', '/root')).toBe(true);
    expect(isWithinRoot('/root', '/root/sub')).toBe(true);
    expect(isWithinRoot('/root', '/root/a/b/c')).toBe(true);
    expect(isWithinRoot('/root', '/root/a/../b')).toBe(true); // normalizes to /root/b
  });

  it('rejects traversal escapes and sibling paths', () => {
    expect(isWithinRoot('/root', '/root/..')).toBe(false);
    expect(isWithinRoot('/root', '/root/../etc')).toBe(false);
    expect(isWithinRoot('/root', '/etc/passwd')).toBe(false);
    expect(isWithinRoot('/root', '/rootx')).toBe(false); // prefix, not a child
  });
});

// ============================================================================
// C. listDirectory — containment rejection + real one-level readdir
// ============================================================================

describe('listDirectory', () => {
  let tmpRoot: string;

  beforeAll(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ft-test-'));
    await fs.mkdir(path.join(tmpRoot, 'docs'));
    await fs.mkdir(path.join(tmpRoot, 'node_modules'));
    await fs.mkdir(path.join(tmpRoot, '.git'));
    await fs.writeFile(path.join(tmpRoot, 'README.md'), '# hi');
    await fs.writeFile(path.join(tmpRoot, 'notes.txt'), 'x');
    await fs.writeFile(path.join(tmpRoot, '.env'), 'secret');
    await fs.writeFile(path.join(tmpRoot, 'docs', 'guide.md'), '# guide');
  });

  afterAll(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('rejects a dirPath outside the root (traversal)', async () => {
    await expect(
      listDirectory({ rootPath: tmpRoot, dirPath: path.join(tmpRoot, '..') }),
    ).rejects.toThrow(/path-escapes-root/);
    await expect(
      listDirectory({ rootPath: tmpRoot, dirPath: '/etc' }),
    ).rejects.toThrow(/path-escapes-root/);
  });

  it('lists one level with noise hidden and directories first', async () => {
    const entries = await listDirectory({ rootPath: tmpRoot, dirPath: tmpRoot });
    // Case-insensitive sort: "notes" < "readme", so notes.txt precedes README.md.
    expect(entries.map((e) => e.name)).toEqual(['docs', 'notes.txt', 'README.md']);
    expect(entries[0]).toMatchObject({ isDir: true, kind: 'folder' });
    expect(entries.find((e) => e.name === 'README.md')).toMatchObject({
      openable: true,
      kind: 'markdown',
      path: path.join(tmpRoot, 'README.md'),
    });
  });

  it('lists a nested directory inside the root (lazy expand)', async () => {
    const entries = await listDirectory({ rootPath: tmpRoot, dirPath: path.join(tmpRoot, 'docs') });
    expect(entries.map((e) => e.name)).toEqual(['guide.md']);
  });
});

// ============================================================================
// D. isSafeLocalAbsolutePath (shell.openPath / open-in-current gate)
// ============================================================================

describe('isSafeLocalAbsolutePath', () => {
  it('accepts absolute local paths', () => {
    expect(isSafeLocalAbsolutePath('/Users/me/report.md')).toBe(true);
    expect(isSafeLocalAbsolutePath('/tmp/a b/c.pdf')).toBe(true);
  });

  it('rejects relative paths, URLs, file: URLs, and schemes', () => {
    expect(isSafeLocalAbsolutePath('relative/path.md')).toBe(false);
    expect(isSafeLocalAbsolutePath('https://example.com/x.md')).toBe(false);
    expect(isSafeLocalAbsolutePath('file:///Users/me/x.md')).toBe(false);
    expect(isSafeLocalAbsolutePath('javascript:alert(1)')).toBe(false);
  });

  it('rejects paths containing a .. traversal segment', () => {
    expect(isSafeLocalAbsolutePath('/Users/me/../../etc/passwd')).toBe(false);
    expect(isSafeLocalAbsolutePath('/Users/me/docs/../secret.md')).toBe(false);
    expect(isSafeLocalAbsolutePath('/..')).toBe(false);
    // a directory literally named ".." segment is rejected; legitimate names with
    // dots elsewhere are still fine.
    expect(isSafeLocalAbsolutePath('/Users/me/..hidden/x.md')).toBe(true);
    expect(isSafeLocalAbsolutePath('/Users/me/a..b/x.md')).toBe(true);
  });

  it('rejects empty, control-char, and non-string input', () => {
    expect(isSafeLocalAbsolutePath('')).toBe(false);
    expect(isSafeLocalAbsolutePath('   ')).toBe(false);
    expect(isSafeLocalAbsolutePath('/Users/me/re\nport.md')).toBe(false);
    expect(isSafeLocalAbsolutePath(null as unknown as string)).toBe(false);
    expect(isSafeLocalAbsolutePath(123 as unknown as string)).toBe(false);
  });
});
