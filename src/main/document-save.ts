import {
  atomicWriteWithExclusiveTemp,
  type DescriptorAtomicWriteBackend,
  type ExclusiveTempFile,
} from './atomic-write';

export interface DocumentSaveFs {
  stat(target: string): Promise<{ mode: number }>;
}

/**
 * Atomically persist a document without changing the permissions of an existing
 * file. New documents use the normal user-readable 0o644 mode.
 */
export async function saveDocumentAtomically(
  target: string,
  content: string,
  opts: {
    fs: DocumentSaveFs;
    backend: DescriptorAtomicWriteBackend;
    beforeWrite?: () => Promise<void>;
    beforeRename?: (temp: ExclusiveTempFile) => Promise<void>;
  },
): Promise<void> {
  let mode = 0o644;
  try {
    mode = (await opts.fs.stat(target)).mode & 0o777;
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
  await atomicWriteWithExclusiveTemp(target, content, {
    backend: opts.backend,
    prepareDirectory: false,
    mode,
    beforeWrite: opts.beforeWrite,
    beforeRename: opts.beforeRename,
  });
}
