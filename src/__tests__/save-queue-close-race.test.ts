import { describe, expect, it } from 'vitest';
import type { AtomicWriteBackend } from '../main/atomic-write';
import { saveDocumentAtomically } from '../main/document-save';
import { KeyedMutex } from '../main/keyed-mutex';

describe('save queue close race', () => {
  it('serializes queued document writes and keeps the latest revision clean', async () => {
    const mutex = new KeyedMutex();
    const files = new Map<string, string>();
    const order: string[] = [];
    let releaseFirstWrite!: () => void;
    const firstWrite = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
    let revision = 1;
    let dirty = true;
    const backend: AtomicWriteBackend = {
      async mkdir() {},
      async writeFile(target, data) {
        if (String(data) === 'A1') await firstWrite;
        files.set(target, String(data));
      },
      async fsyncFile() {},
      async rename(from, target) { files.set(target, files.get(from) ?? ''); },
      async unlink() {},
      randomId: () => 'tmp',
    };
    const save = (label: string, capturedRevision: number) => mutex.run('/docs/note.md', async () => {
      order.push(`${label}:start`);
      await saveDocumentAtomically('/docs/note.md', label, {
        fs: { async stat() { return { mode: 0o644 }; } },
        backend,
      });
      order.push(`${label}:end`);
      if (capturedRevision === revision) dirty = false;
      return capturedRevision;
    });

    const a1 = save('A1', revision);
    await Promise.resolve();
    revision = 2;
    const b = save('B', revision);
    revision = 3;
    const closeSave = save('A2:close-save', revision);

    releaseFirstWrite();
    const committedRevision = await closeSave;
    await Promise.all([a1, b]);

    expect(order).toEqual(['A1:start', 'A1:end', 'B:start', 'B:end', 'A2:close-save:start', 'A2:close-save:end']);
    expect(files.get('/docs/note.md')).toBe('A2:close-save');
    expect(committedRevision).toBe(revision);
    expect(dirty).toBe(false);
  });
});
