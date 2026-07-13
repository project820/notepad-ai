import { describe, expect, it, vi } from 'vitest';
import { handleCloseQueryState } from '../renderer/close-query-state';

describe('handleCloseQueryState', () => {
  it('ACKs with syncFailed and a lease when preview synchronization throws', () => {
    const beginLease = vi.fn();
    const send = vi.fn();

    handleCloseQueryState({
      requestId: 'close-1',
      flush: () => { throw new Error('serializer failed'); },
      beginLease,
      send,
      state: () => ({ dirty: true, hasPath: true, docEmpty: false, revision: 4, locale: 'en' }),
    });

    expect(beginLease).toHaveBeenCalledWith('close-1');
    expect(send).toHaveBeenCalledWith('close-1', expect.objectContaining({ syncFailed: true, revision: 4 }));
  });
});
