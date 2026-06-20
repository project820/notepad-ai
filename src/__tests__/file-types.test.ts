/**
 * file-types.test.ts
 *
 * Pure unit tests for the shared file-type vocabulary (G004 — file tree).
 * Verifies the openable-document allowlist, the noise (dotfiles / node_modules)
 * filter, extension extraction, and the visual-kind classification.
 */

import { describe, it, expect } from 'vitest';
import {
  CONVERTIBLE_EXTS,
  OPENABLE_DOCUMENT_EXTS,
  extOf,
  fileKindForExt,
  isNoiseName,
  isOpenableDocumentPath,
  isOpenableExt,
} from '../shared/file-types';

// ============================================================================
// A. Extension constants (the open-dialog refactor depends on exact contents)
// ============================================================================

describe('extension constants', () => {
  it('OPENABLE_DOCUMENT_EXTS matches the plan list and order', () => {
    expect([...OPENABLE_DOCUMENT_EXTS]).toEqual([
      'md', 'markdown', 'mdx', 'txt', 'hwp', 'hwpx', 'hwpml', 'docx', 'pdf', 'xlsx', 'xls',
    ]);
  });

  it('CONVERTIBLE_EXTS matches the legacy main.ts kordoc set and order', () => {
    expect([...CONVERTIBLE_EXTS]).toEqual([
      'hwp', 'hwpx', 'hwpml', 'docx', 'pdf', 'xlsx', 'xls',
    ]);
  });
});

// ============================================================================
// B. extOf — lower-cased extension, dotfiles have none
// ============================================================================

describe('extOf', () => {
  it('lower-cases the extension', () => {
    expect(extOf('Report.MD')).toBe('md');
    expect(extOf('SHEET.XLSX')).toBe('xlsx');
  });

  it('uses the basename so directory dots are ignored', () => {
    expect(extOf('/Users/me/dir.with.dot/notes.txt')).toBe('txt');
    expect(extOf('/Users/me/dir.with.dot/Makefile')).toBe('');
  });

  it('returns "" for files without an extension and for dotfiles', () => {
    expect(extOf('README')).toBe('');
    expect(extOf('.gitignore')).toBe('');
    expect(extOf('.env')).toBe('');
  });

  it('returns the final segment for multi-dot names', () => {
    expect(extOf('archive.tar.gz')).toBe('gz');
  });
});

// ============================================================================
// C. openable detection
// ============================================================================

describe('isOpenableExt / isOpenableDocumentPath', () => {
  it('accepts every openable extension (case-insensitive)', () => {
    for (const ext of OPENABLE_DOCUMENT_EXTS) {
      expect(isOpenableExt(ext)).toBe(true);
      expect(isOpenableExt(ext.toUpperCase())).toBe(true);
      expect(isOpenableDocumentPath(`/root/file.${ext}`)).toBe(true);
    }
  });

  it('rejects unknown and missing extensions', () => {
    expect(isOpenableExt('png')).toBe(false);
    expect(isOpenableExt('')).toBe(false);
    expect(isOpenableDocumentPath('/root/image.png')).toBe(false);
    expect(isOpenableDocumentPath('/root/README')).toBe(false);
    expect(isOpenableDocumentPath('/root/.gitignore')).toBe(false);
  });
});

// ============================================================================
// D. noise (hidden) detection
// ============================================================================

describe('isNoiseName', () => {
  it('hides dotfiles, dot-directories, and node_modules', () => {
    expect(isNoiseName('.git')).toBe(true);
    expect(isNoiseName('.DS_Store')).toBe(true);
    expect(isNoiseName('.env.local')).toBe(true);
    expect(isNoiseName('node_modules')).toBe(true);
  });

  it('keeps ordinary files and folders visible', () => {
    expect(isNoiseName('src')).toBe(false);
    expect(isNoiseName('Notes.md')).toBe(false);
    expect(isNoiseName('node_modules_backup')).toBe(false);
  });
});

// ============================================================================
// E. visual file kind
// ============================================================================

describe('fileKindForExt', () => {
  it('classifies each family for icon/colour selection', () => {
    expect(fileKindForExt('md')).toBe('markdown');
    expect(fileKindForExt('markdown')).toBe('markdown');
    expect(fileKindForExt('mdx')).toBe('markdown');
    expect(fileKindForExt('txt')).toBe('text');
    expect(fileKindForExt('hwp')).toBe('hwp');
    expect(fileKindForExt('hwpx')).toBe('hwp');
    expect(fileKindForExt('hwpml')).toBe('hwp');
    expect(fileKindForExt('docx')).toBe('word');
    expect(fileKindForExt('pdf')).toBe('pdf');
    expect(fileKindForExt('xlsx')).toBe('spreadsheet');
    expect(fileKindForExt('xls')).toBe('spreadsheet');
  });

  it('is case-insensitive and falls back to "other"', () => {
    expect(fileKindForExt('MD')).toBe('markdown');
    expect(fileKindForExt('png')).toBe('other');
    expect(fileKindForExt('')).toBe('other');
  });
});
