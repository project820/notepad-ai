/**
 * Shared file-type vocabulary — the single source of truth for which document
 * extensions Notepad AI can open, which directory entries are noise, and how a
 * file maps to a visual "kind" (icon/colour) for the file tree.
 *
 * This module is shared between the main process (open dialog filters, kordoc
 * conversion gate, file-tree listing) and the renderer (left-panel file tab).
 * It MUST stay pure: no `electron`, no `node:*`, no DOM. Path handling is done
 * with plain string operations so the same code runs in the browser bundle.
 */

/** Markdown source extensions opened verbatim (no conversion). */
const MARKDOWN_EXTS = ['md', 'markdown', 'mdx'] as const;

/** Plain-text extensions opened verbatim. */
const TEXT_EXTS = ['txt'] as const;

/** Hangul word-processor extensions (kordoc conversion). */
const HWP_EXTS = ['hwp', 'hwpx', 'hwpml'] as const;

/** MS Word extensions (kordoc conversion). */
const WORD_EXTS = ['docx'] as const;

/** PDF extensions (kordoc conversion). */
const PDF_EXTS = ['pdf'] as const;

/** Spreadsheet extensions (kordoc conversion). */
const SPREADSHEET_EXTS = ['xlsx', 'xls'] as const;

/**
 * Extensions that require kordoc conversion to Markdown before editing. Order
 * matches the legacy `main.ts` set so existing open-dialog filters are stable.
 */
export const CONVERTIBLE_EXTS = [
  ...HWP_EXTS,
  ...WORD_EXTS,
  ...PDF_EXTS,
  ...SPREADSHEET_EXTS,
] as const;

/**
 * Every extension Notepad AI knows how to open — markdown/text verbatim plus the
 * convertible document formats. Order matches the legacy "Documents" dialog
 * filter (`md, markdown, mdx, txt, hwp, hwpx, hwpml, docx, pdf, xlsx, xls`).
 */
export const OPENABLE_DOCUMENT_EXTS = [
  ...MARKDOWN_EXTS,
  ...TEXT_EXTS,
  ...CONVERTIBLE_EXTS,
] as const;

/** Visual classification of a tree entry, used to pick an icon/colour. */
export type FileKind =
  | 'folder'
  | 'markdown'
  | 'text'
  | 'hwp'
  | 'word'
  | 'pdf'
  | 'spreadsheet'
  | 'other';

/**
 * A single directory entry returned by the file-tree listing. This is the IPC
 * data contract shared by the main process (producer) and renderer (consumer).
 */
export type FileTreeEntry = {
  /** Base name (e.g. `report.md`). */
  name: string;
  /** Absolute path. */
  path: string;
  /** True for directories. */
  isDir: boolean;
  /** Lower-cased extension without a dot (`''` for directories / no extension). */
  ext: string;
  /** True when this is a file Notepad AI can open in an editor window. */
  openable: boolean;
  /** Visual kind for icon/colour selection. */
  kind: FileKind;
};

const OPENABLE_EXT_SET = new Set<string>(OPENABLE_DOCUMENT_EXTS);
const MARKDOWN_EXT_SET = new Set<string>(MARKDOWN_EXTS);
const HWP_EXT_SET = new Set<string>(HWP_EXTS);
const SPREADSHEET_EXT_SET = new Set<string>(SPREADSHEET_EXTS);

/**
 * Lower-cased extension (no leading dot) for a file name or path. Returns `''`
 * for entries without an extension and for dotfiles like `.gitignore` (a leading
 * dot is not an extension). Uses string ops only so it is browser-safe.
 */
export function extOf(nameOrPath: string): string {
  const base = nameOrPath.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  // `dot <= 0` covers "no dot" and a leading-dot dotfile (e.g. ".gitignore").
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

/** True when `ext` (lower- or mixed-case, no dot) is an openable document type. */
export function isOpenableExt(ext: string): boolean {
  return OPENABLE_EXT_SET.has(ext.toLowerCase());
}

/** True when the file name/path has an extension Notepad AI can open. */
export function isOpenableDocumentPath(nameOrPath: string): boolean {
  return isOpenableExt(extOf(nameOrPath));
}

/**
 * True for directory entries hidden by default in the file tree: dotfiles and
 * dot-directories (`.git`, `.DS_Store`, …) and `node_modules`.
 */
export function isNoiseName(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules';
}

/** Map a (lower- or mixed-case, no dot) extension to its visual file kind. */
export function fileKindForExt(ext: string): FileKind {
  const e = ext.toLowerCase();
  if (MARKDOWN_EXT_SET.has(e)) return 'markdown';
  if (e === 'txt') return 'text';
  if (HWP_EXT_SET.has(e)) return 'hwp';
  if (e === 'docx') return 'word';
  if (e === 'pdf') return 'pdf';
  if (SPREADSHEET_EXT_SET.has(e)) return 'spreadsheet';
  return 'other';
}
