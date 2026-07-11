import { describe, expect, it, vi } from 'vitest';
import { convertDocument } from '../main/converter-service';

describe('convertDocument', () => {
  it('returns an explicit error when the isolated worker fails without parsing in main', async () => {
    const runConvert = vi.fn().mockRejectedValue(new Error('converter-worker-exited'));

    await expect(convertDocument({ runConvert }, 'docx', Buffer.from('untrusted'))).resolves.toEqual({
      ok: false,
      error: 'converter-worker-failed',
    });
    expect(runConvert).toHaveBeenCalledTimes(1);
  });
});
