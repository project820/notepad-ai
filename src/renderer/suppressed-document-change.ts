export type SuppressedDocumentChangeHooks = {
  isDirty: () => boolean;
  markDirty: () => void;
  syncPreview?: (doc: string) => void;
  updateWordCount: (doc: string) => void;
  scheduleAutosave: () => void;
  scheduleSessionSnapshot: () => void;
};

/** Apply persistence side effects that a suppressed editor change bypasses. */
export function handleSuppressedDocumentChange(
  doc: string,
  hooks: SuppressedDocumentChangeHooks,
): void {
  if (!hooks.isDirty()) hooks.markDirty();
  hooks.syncPreview?.(doc);
  hooks.updateWordCount(doc);
  hooks.scheduleAutosave();
  hooks.scheduleSessionSnapshot();
}
