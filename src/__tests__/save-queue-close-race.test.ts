import { describe, expect, it } from 'vitest';
import { KeyedMutex } from '../main/keyed-mutex';

describe('save queue close race', () => {
  it('preserves A→B→A write order for one document while a close save is queued', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    let releaseA!: () => void;
    const firstWrite = new Promise<void>((resolve) => { releaseA = resolve; });

    const a1 = mutex.run('/docs/note.md', async () => {
      order.push('A1:start');
      await firstWrite;
      order.push('A1:end');
    });
    const b = mutex.run('/docs/note.md', async () => { order.push('B'); });
    const closeSaveA = mutex.run('/docs/note.md', async () => { order.push('A2:close-save'); });

    await Promise.resolve();
    expect(order).toEqual(['A1:start']);
    releaseA();
    await Promise.all([a1, b, closeSaveA]);
    expect(order).toEqual(['A1:start', 'A1:end', 'B', 'A2:close-save']);
  });
});
