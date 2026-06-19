import { extname, join } from 'node:path';
import type { ScanScope, ScanSummary, UnreadableItem } from './types';

type ScanDirent = {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
};

type ScanStat = {
  size: number;
};

export type ScanFs = {
  readdir(dir: string, options: { withFileTypes: true }): Promise<ScanDirent[]>;
  readFile(filePath: string, encoding: 'utf8'): Promise<string>;
  stat(filePath: string): Promise<ScanStat>;
};

const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', '.notepad-ai']);
const SUPPORTED_DOCUMENT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.csv', '.json']);
const SUPPORTED_CODEX_FULL_EXTENSIONS = new Set([
  ...SUPPORTED_DOCUMENT_EXTENSIONS,
  '.c',
  '.cpp',
  '.css',
  '.go',
  '.h',
  '.hpp',
  '.html',
  '.java',
  '.js',
  '.jsx',
  '.kt',
  '.mjs',
  '.py',
  '.rb',
  '.rs',
  '.sh',
  '.sql',
  '.swift',
  '.toml',
  '.ts',
  '.tsx',
  '.xml',
  '.yaml',
  '.yml',
  '.zsh',
]);
const MAX_DOCUMENT_BYTES = 512_000;
const MAX_EXCERPT_CHARS = 4_000;

export async function scanProjectFolder(
  projectFolder: string,
  scope: ScanScope,
  scannedAt: string,
  fs: ScanFs,
): Promise<ScanSummary> {
  const summary: ScanSummary = {
    scope,
    projectFolder,
    scannedAt,
    filesSeen: [],
    documentsRead: [],
    unreadableItems: [],
  };

  if (scope === 'manual_explanation') {
    return summary;
  }

  await scanDirectory(projectFolder, scope, fs, summary);

  summary.filesSeen.sort(comparePath);
  summary.documentsRead.sort((a, b) => comparePath(a.path, b.path));
  summary.unreadableItems.sort((a, b) => comparePath(a.path, b.path));

  return summary;
}

async function scanDirectory(dir: string, scope: ScanScope, fs: ScanFs, summary: ScanSummary): Promise<void> {
  let entries: ScanDirent[];

  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    summary.unreadableItems.push(readError(dir, error));
    return;
  }

  for (const entry of entries) {
    const itemPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        await scanDirectory(itemPath, scope, fs, summary);
      }
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    summary.filesSeen.push(itemPath);

    if (scope === 'fast_structure') {
      continue;
    }

    await readSupportedDocument(itemPath, scope, fs, summary);
  }
}

async function readSupportedDocument(
  filePath: string,
  scope: ScanScope,
  fs: ScanFs,
  summary: ScanSummary,
): Promise<void> {
  const supportedExtensions = scope === 'codex_full' ? SUPPORTED_CODEX_FULL_EXTENSIONS : SUPPORTED_DOCUMENT_EXTENSIONS;

  if (!supportedExtensions.has(extname(filePath).toLowerCase())) {
    summary.unreadableItems.push({
      path: filePath,
      reason: 'unsupported',
      critical: false,
    });
    return;
  }

  let stat: ScanStat;

  try {
    stat = await fs.stat(filePath);
  } catch (error) {
    summary.unreadableItems.push(readError(filePath, error));
    return;
  }

  if (stat.size > MAX_DOCUMENT_BYTES) {
    summary.unreadableItems.push({
      path: filePath,
      reason: 'too_large',
      critical: false,
    });
    return;
  }

  try {
    const content = await fs.readFile(filePath, 'utf8');
    summary.documentsRead.push({
      path: filePath,
      excerpt: content.slice(0, MAX_EXCERPT_CHARS),
    });
  } catch (error) {
    summary.unreadableItems.push(readError(filePath, error));
  }
}

function readError(path: string, error: unknown): UnreadableItem {
  return {
    path,
    reason: 'read_error',
    critical: false,
    note: error instanceof Error ? error.message : undefined,
  };
}

function comparePath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
