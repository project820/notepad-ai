export type CloseGuardLocale = 'en' | 'ko' | 'zh-Hans' | 'zh-Hant' | 'ja';
export type CloseGuardChoice = 'save' | 'discard' | 'cancel';
export type CloseGuardAction = 'allow' | 'cancel' | 'discard';

export type CloseGuardState = {
  dirty: boolean;
  hasPath: boolean;
  docEmpty: boolean;
  locale: CloseGuardLocale;
};

export type CloseGuardSnapshot = {
  dirty?: boolean;
  path?: string | null;
  doc?: string;
};

export type CloseDialogLabels = {
  title: string;
  message: string;
  save: string;
  discard: string;
  cancel: string;
};

const CLOSE_DIALOG_LABELS: Record<CloseGuardLocale, CloseDialogLabels> = {
  en: { title: 'Save changes?', message: 'Do you want to save your changes before closing?', save: 'Save', discard: "Don't Save", cancel: 'Cancel' },
  ko: { title: '변경사항을 저장할까요?', message: '닫기 전에 변경사항을 저장하시겠습니까?', save: '저장', discard: '저장 안 함', cancel: '취소' },
  'zh-Hans': { title: '要保存更改吗？', message: '关闭前要保存更改吗？', save: '保存', discard: '不保存', cancel: '取消' },
  'zh-Hant': { title: '要儲存變更嗎？', message: '關閉前要儲存變更嗎？', save: '儲存', discard: '不儲存', cancel: '取消' },
  ja: { title: '変更を保存しますか？', message: '閉じる前に変更を保存しますか？', save: '保存', discard: '保存しない', cancel: 'キャンセル' },
};

export function normalizeCloseGuardLocale(value: unknown): CloseGuardLocale {
  return value === 'ko' || value === 'zh-Hans' || value === 'zh-Hant' || value === 'ja' ? value : 'en';
}

export function closeGuardChoiceFromButton(buttonIndex: number): CloseGuardChoice {
  if (buttonIndex === 0) return 'save';
  if (buttonIndex === 1) return 'discard';
  return 'cancel';
}

/** An untitled empty buffer is not a document that needs close confirmation. */
export function needsCloseConfirmation(state: CloseGuardState): boolean {
  return state.dirty && (state.hasPath || !state.docEmpty);
}

/** A renderer timeout may use the last persisted edit-event snapshot, never an invented clean state. */
export function stateFromSnapshot(snapshot: CloseGuardSnapshot | undefined): CloseGuardState {
  return {
    dirty: snapshot?.dirty === true,
    hasPath: typeof snapshot?.path === 'string',
    docEmpty: (snapshot?.doc?.length ?? 0) === 0,
    locale: 'en',
  };
}

export async function resolveCloseGuard({
  state,
  showDialog,
  save,
}: {
  state: CloseGuardState;
  showDialog: (labels: CloseDialogLabels) => Promise<CloseGuardChoice>;
  save: () => Promise<boolean>;
}): Promise<CloseGuardAction> {
  if (!needsCloseConfirmation(state)) return 'allow';
  const choice = await showDialog(CLOSE_DIALOG_LABELS[state.locale]);
  if (choice === 'discard') return 'discard';
  if (choice === 'cancel') return 'cancel';
  return (await save()) ? 'allow' : 'cancel';
}
export function guardCloseEvent(
  event: { preventDefault: () => void },
  resolve: () => Promise<boolean>,
  retryApprovedClose: () => void,
  onError: (error: unknown) => void,
): void {
  // This is deliberately before creating the promise: Electron ignores an
  // asynchronous preventDefault and will tear down beneath a native dialog.
  event.preventDefault();
  void resolve().then((approved) => {
    if (approved) retryApprovedClose();
  }).catch(onError);
}
export function shouldPreventBeforeQuit(input: { quitApproved: boolean; relaunchApproved: boolean }): boolean {
  return !input.quitApproved && !input.relaunchApproved;
}
