export type CloseQueryState = {
  dirty: boolean;
  hasPath: boolean;
  docEmpty: boolean;
  revision: number;
  syncFailed: boolean;
  locale: 'en' | 'ko' | 'zh-Hans' | 'zh-Hant' | 'ja';
};

/**
 * Close state is an ACK protocol, not a best-effort notification. Preview
 * synchronization failure is reported explicitly so main can offer only
 * cancel/discard while retaining the renderer lease.
 */
export function handleCloseQueryState({
  requestId,
  flush,
  beginLease,
  send,
  state,
}: {
  requestId: string;
  flush: () => unknown;
  beginLease: (requestId: string) => void;
  send: (requestId: string, state: CloseQueryState) => void;
  state: () => Omit<CloseQueryState, 'syncFailed'> & { syncFailed?: boolean };
}): void {
  let syncFailed = false;
  try {
    flush();
  } catch (error) {
    syncFailed = true;
    console.warn('[close] preview synchronization failed:', error);
  }
  beginLease(requestId);
  const current = state();
  send(requestId, { ...current, syncFailed: syncFailed || current.syncFailed === true });
}
