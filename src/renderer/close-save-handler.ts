type CloseSaveResult = {
  saved: boolean;
  committedRevision: number | null;
};

export type CloseSaveRequest = {
  requestId: string;
  requestedRevision: number;
  save: () => Promise<number | null>;
  isDirty: () => boolean;
  flushSessionSnapshot?: () => Promise<void>;
  onSnapshotFlushError?: (error: unknown) => void;
  send: (requestId: string, result: CloseSaveResult) => void;
};

/**
 * Complete the authoritative document save handshake before doing best-effort
 * session persistence. The main process can then finish the close transaction
 * without waiting on the recovery snapshot write.
 */
export async function handleCloseSaveRequest({
  requestId,
  requestedRevision,
  save,
  isDirty,
  flushSessionSnapshot,
  onSnapshotFlushError,
  send,
}: CloseSaveRequest): Promise<void> {
  let committedRevision: number | null;
  try {
    committedRevision = await save();
  } catch {
    send(requestId, { saved: false, committedRevision: null });
    return;
  }

  const saved = committedRevision !== null && committedRevision >= requestedRevision;
  send(requestId, {
    saved,
    committedRevision: saved ? committedRevision : null,
  });

  if (!saved || isDirty() || !flushSessionSnapshot) return;
  try {
    await flushSessionSnapshot();
  } catch (error) {
    onSnapshotFlushError?.(error);
  }
}
