import { buildRestoreBanner } from './restore-banner';
import { createSessionSnapshotScheduler } from './session-snapshot-scheduler';
import { restoreUnifiedThread, type UnifiedChatItem } from './unified-chat-history';
import { setLocale, t, type Locale } from './i18n';
import type { AppContext, PreviewMode } from './app-context';
import type { Prefs } from './prefs';
import type { UnifiedChatHandle } from './unified-chat';

type SessionSnapshotDeps = {
  prefs: Prefs;
  unifiedChat: UnifiedChatHandle;
  getUnifiedChatHistory: () => UnifiedChatItem[];
  setUnifiedChatHistory: (history: UnifiedChatItem[]) => void;
  setUnifiedChatOpen: (open: boolean) => void;
  applyPreviewMode: () => void;
  replaceDocument: (input: { doc: string; currentPath: string | null; pendingTitle: string | null; dirty: boolean }) => void;
};

export function initSessionSnapshot(ctx: AppContext, deps: SessionSnapshotDeps) {
  function buildSessionSnapshot() {
    return {
      savedAt: Date.now(),
      path: ctx.currentPath,
      title: ctx.pendingTitle,
      doc: ctx.editor.getDoc(),
      view: ctx.previewMode,
      unifiedChatHistory: deps.getUnifiedChatHistory(),
      model: deps.prefs.model,
      dirty: ctx.dirty,
    };
  }

  const sessionSnapshotScheduler = createSessionSnapshotScheduler(() => {
    void window.api.sessionWrite(buildSessionSnapshot());
  });

  function scheduleSessionSnapshot() {
    sessionSnapshotScheduler.schedule();
  }

  async function flushSessionSnapshot() {
    sessionSnapshotScheduler.cancel();
    await window.api.sessionWrite(buildSessionSnapshot());
  }

  async function requestLocaleRestart(l: Locale, persist: () => void) {
    if (!window.confirm(t('lang.restartPrompt'))) return false;
    setLocale(l);
    persist();
    await flushSessionSnapshot();
    await window.api.relaunchApp();
    return true;
  }

  function showRestoreBanner(snap: any) {
    const root = buildRestoreBanner(
      { doc: snap.doc, savedAt: snap.savedAt },
      { title: t('restore.title'), yes: t('restore.yes'), no: t('restore.no') },
    );
    document.body.appendChild(root);
    root.querySelector('.restore-yes')?.addEventListener('click', () => {
      deps.replaceDocument({
        doc: snap.doc ?? '',
        currentPath: typeof snap.path === 'string' ? snap.path : null,
        pendingTitle: typeof snap.title === 'string' ? snap.title : null,
        dirty: snap.dirty === true,
      });
      if (snap.view) { ctx.previewMode = snap.view as PreviewMode; deps.applyPreviewMode(); }
      if (snap) {
        deps.setUnifiedChatHistory(restoreUnifiedThread(snap));
        deps.unifiedChat.restore(snap);
        if (deps.getUnifiedChatHistory().length > 0) deps.setUnifiedChatOpen(true);
      }
      scheduleSessionSnapshot();
      ctx.setStatus(t('status.sessionRestored'));
      root.remove();
    });
    root.querySelector('.restore-no')?.addEventListener('click', () => {
      void window.api.sessionClear();
      root.remove();
    });
  }

  void (async () => {
    const res = await window.api.sessionGet();
    const snap = res?.snapshot;
    if (snap && ((snap.doc?.length ?? 0) > 0 || (snap.unifiedChatHistory?.length ?? 0) > 0)) {
      setTimeout(() => showRestoreBanner(snap), 400);
    }
  })();

  return { scheduleSessionSnapshot, flushSessionSnapshot, requestLocaleRestart };
}
