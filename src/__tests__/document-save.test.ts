import { describe, expect, it } from 'vitest';
import { saveDocumentAtomically } from '../main/document-save';
import type { AtomicWriteBackend } from '../main/atomic-write';

function fakeBackend(files: Map<string, string>, calls: string[], failWrite = false): AtomicWriteBackend {
  return {
    async mkdir() {
      calls.push('mkdir');
    },
    async writeFile(target, data, mode) {
      calls.push(`writeFile:${mode.toString(8)}`);
      if (failWrite) throw new Error('disk full');
      files.set(target, String(data));
    },
    async fsyncFile() {
      calls.push('fsyncFile');
    },
    async rename(from, target) {
      calls.push('rename');
      files.set(target, files.get(from) ?? '');
      files.delete(from);
    },
    async unlink(target) {
      calls.push('unlink');
      files.delete(target);
    },
    randomId() {
      return 'tmp';
    },
  };
}

describe('saveDocumentAtomically', () => {
  it('preserves the existing document when writing the temporary file fails', async () => {
    const files = new Map([['/docs/note.md', 'old']]);
    const calls: string[] = [];

    await expect(
      saveDocumentAtomically('/docs/note.md', 'new', {
        fs: { async stat() { return { mode: 0o640 }; } },
        backend: fakeBackend(files, calls, true),
      }),
    ).rejects.toThrow('disk full');

    expect(files.get('/docs/note.md')).toBe('old');
    expect(calls).toContain('unlink');
  });

  it('commits documents through rename and preserves an existing mode', async () => {
    const files = new Map<string, string>();
    const calls: string[] = [];

    await saveDocumentAtomically('/docs/note.md', 'new', {
      fs: { async stat() { return { mode: 0o640 }; } },
      backend: fakeBackend(files, calls),
    });

    expect(files.get('/docs/note.md')).toBe('new');
    expect(calls).toEqual(['mkdir', 'writeFile:640', 'fsyncFile', 'rename']);
  });

  it('uses mode 0o644 for a new document', async () => {
    const files = new Map<string, string>();
    const calls: string[] = [];
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });

    await saveDocumentAtomically('/docs/new.md', 'new', {
      fs: { async stat() { throw missing; } },
      backend: fakeBackend(files, calls),
    });

    expect(calls).toContain('writeFile:644');
  });
});
