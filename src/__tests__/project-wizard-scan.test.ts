import { describe, it, expect, vi } from 'vitest';
import { scanProjectFolder, type ScanFs } from '../main/project-wizard/scan';

const fs: ScanFs = {
  readdir: vi.fn(async (dir) => {
    if (dir === '/project') {
      return [
        { name: 'docs', isDirectory: () => true, isFile: () => false },
        { name: 'node_modules', isDirectory: () => true, isFile: () => false },
        { name: '.git', isDirectory: () => true, isFile: () => false },
        { name: '.notepad-ai', isDirectory: () => true, isFile: () => false },
        { name: 'src', isDirectory: () => true, isFile: () => false },
        { name: 'README.md', isDirectory: () => false, isFile: () => true },
        { name: 'config.yaml', isDirectory: () => false, isFile: () => true },
        { name: 'image.png', isDirectory: () => false, isFile: () => true },
      ] as any;
    }
    if (dir === '/project/docs') {
      return [
        { name: 'large.md', isDirectory: () => false, isFile: () => true },
        { name: 'plan.txt', isDirectory: () => false, isFile: () => true },
      ] as any;
    }
    if (dir === '/project/src') {
      return [{ name: 'index.ts', isDirectory: () => false, isFile: () => true }] as any;
    }
    if (dir === '/project/node_modules' || dir === '/project/.git' || dir === '/project/.notepad-ai') {
      throw new Error(`should not scan ${dir}`);
    }
    return [];
  }),
  readFile: vi.fn(async (filePath) => {
    return filePath.endsWith('.png') ? Buffer.from([1, 2, 3]).toString() : `content:${filePath}`;
  }),
  stat: vi.fn(async (filePath) => {
    return { size: filePath.endsWith('large.md') ? 600_000 : 128 } as any;
  }),
};

describe('scanProjectFolder', () => {
  it('fast_structure records paths but reads no file content', async () => {
    vi.mocked(fs.readFile).mockClear();
    vi.mocked(fs.stat).mockClear();

    const summary = await scanProjectFolder('/project', 'fast_structure', '2026-05-15T14:40:32+09:00', fs);

    expect(summary.filesSeen).toContain('/project/README.md');
    expect(summary.documentsRead).toEqual([]);
    expect(fs.readFile).not.toHaveBeenCalled();
    expect(fs.stat).not.toHaveBeenCalled();
  });

  it('document_centered reads supported document content only', async () => {
    const summary = await scanProjectFolder('/project', 'document_centered', '2026-05-15T14:40:32+09:00', fs);
    expect(summary.documentsRead.map((d) => d.path)).toEqual(['/project/README.md', '/project/docs/plan.txt']);
    expect(summary.unreadableItems).toEqual([
      { path: '/project/config.yaml', reason: 'unsupported', critical: false },
      { path: '/project/docs/large.md', reason: 'too_large', critical: false },
      { path: '/project/image.png', reason: 'unsupported', critical: false },
      { path: '/project/src/index.ts', reason: 'unsupported', critical: false },
    ]);
  });

  it('codex_full reads supported code and config text files', async () => {
    const summary = await scanProjectFolder('/project', 'codex_full', '2026-05-15T14:40:32+09:00', fs);

    expect(summary.filesSeen).toEqual([
      '/project/README.md',
      '/project/config.yaml',
      '/project/docs/large.md',
      '/project/docs/plan.txt',
      '/project/image.png',
      '/project/src/index.ts',
    ]);
    expect(summary.documentsRead.map((d) => d.path)).toEqual([
      '/project/README.md',
      '/project/config.yaml',
      '/project/docs/plan.txt',
      '/project/src/index.ts',
    ]);
    expect(summary.unreadableItems).toEqual([
      { path: '/project/docs/large.md', reason: 'too_large', critical: false },
      { path: '/project/image.png', reason: 'unsupported', critical: false },
    ]);
  });

  it('manual_explanation performs no scan', async () => {
    vi.mocked(fs.readdir).mockClear();

    const summary = await scanProjectFolder('/project', 'manual_explanation', '2026-05-15T14:40:32+09:00', fs);

    expect(summary.filesSeen).toEqual([]);
    expect(summary.documentsRead).toEqual([]);
    expect(summary.unreadableItems).toEqual([]);
    expect(fs.readdir).not.toHaveBeenCalled();
  });
});
