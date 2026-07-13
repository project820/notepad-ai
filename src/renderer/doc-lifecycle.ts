import type { AppContext } from './app-context';
import type { Api } from './api-types';
import type { createRafThrottle } from './raf-throttle';
import type { buildConvertedHtmlFrame } from './sanitize-html';
import type { htmlToMarkdown } from './html-to-md';
import type { t } from './i18n';
import { handleSuppressedDocumentChange } from './suppressed-document-change';

type DocLifecycleDeps = {
  api: Api;
  titleEl: HTMLInputElement;
  dirtyEl: HTMLDivElement;
  t: typeof t;
  htmlToMarkdown: typeof htmlToMarkdown;
  buildConvertedHtmlFrame: typeof buildConvertedHtmlFrame;
  updateWordCount: (doc: string) => void;
  scheduleSessionSnapshot: () => void;
  syncWorkspaceRootToCurrent: () => void;
  updateHtmlViewToggle: () => void;
  createRafThrottle: typeof createRafThrottle;
};

export function initDocLifecycle(ctx: AppContext, deps: DocLifecycleDeps) {
  let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  let closeLease: { id: string; revision: number; invalidated: boolean; consumed: boolean } | null = null;
  let savesFenced = false;
  let saveTail = Promise.resolve();
  let flushPendingPreview: (() => void) | null = null;
  let allowingCloseFlush = false;
  let quiesce: { id: string; expiry: ReturnType<typeof setTimeout> | null; autosavePending: boolean; previewPending: boolean } | null = null;
  let quiescePreview: { pause: () => boolean; resume: (wasPending: boolean) => void } | null = null;
  let previewSyncFailed = false;
  let discardFenced = false;
  function hasMutationFence(): boolean {
    return previewSyncFailed || discardFenced || !!quiesce || closeLease?.consumed === true;
  }

  function reconcileMutationFence(): void {
    const fenced = hasMutationFence();
    ctx.editor.setMutationFence(fenced);
    ctx.preview.el.contentEditable = fenced ? 'false' : 'true';
  }

  function invalidateCloseLease(): void {
    if (!closeLease || closeLease.invalidated || closeLease.consumed) return;
    closeLease.invalidated = true;
    deps.api.sendCloseLeaseInvalidated(closeLease.id, ctx.docRevision);
  }

  function tryMutateDocument(): boolean {
    return allowingCloseFlush || ((!savesFenced && !previewSyncFailed) && !quiesce && !closeLease?.consumed);
  }

  function recordDocumentMutation(): boolean {
    if (!tryMutateDocument()) return false;
    ctx.docRevision += 1;
    invalidateCloseLease();
    return true;
  }

  function recordPreviewInput(): boolean {
    if (!recordDocumentMutation()) return false;
    if (!ctx.dirty) {
      ctx.dirty = true;
      setTitle();
    }
    scheduleAutosave();
    deps.scheduleSessionSnapshot();
    return true;
  }

  function displayTitle(): string {
    if (ctx.currentPath) return ctx.currentPath.split('/').pop() ?? 'Untitled';
    return ctx.pendingTitle ?? 'Untitled';
  }

  function setTitle() {
    if (document.activeElement !== deps.titleEl) {
      deps.titleEl.value = displayTitle();
    }
    deps.dirtyEl.classList.toggle('dirty', ctx.dirty);
  }

  async function performSave(filePath: string | null): Promise<number | null> {
    const revision = ctx.docRevision;
    const result = await deps.api.saveFile(filePath, ctx.editor.getDoc());
    if (result.saved && result.filePath) {
      ctx.currentPath = result.filePath;
      ctx.pendingTitle = null;
      // A queued write may complete after another edit. It committed the older
      // revision, but must not mark the newer document clean.
      if (ctx.docRevision === revision) ctx.dirty = false;
      setTitle();
      ctx.setStatus(deps.t('status.saved').replace('{filePath}', result.filePath));
      return revision;
    }
    if (result.error === 'already-open') {
      // Another window owns this path; main focused it. Keep dirty + path so the
      // user never silently loses their edit (no last-writer-wins).
      ctx.setStatus(deps.t('status.alreadyOpen'));
    }
    return null;
  }

  function saveTo(filePath: string | null): Promise<number | null> {
    const queued = saveTail.then(() => (savesFenced || previewSyncFailed ? null : performSave(filePath)));
    saveTail = queued.then(() => undefined, () => undefined);
    return queued;
  }

  async function save(): Promise<number | null> {
    return saveTo(ctx.currentPath);
  }

  async function saveAs(): Promise<number | null> {
    return saveTo(null);
  }

  function scheduleAutosave() {
    if (savesFenced) return;
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      autosaveTimer = null;
      if (ctx.currentPath) void save();
    }, 3000);
  }

  const previewRenderThrottle = deps.createRafThrottle();
  function onDocChange(doc: string) {
    if (ctx.suppressEditorChange || !recordDocumentMutation()) return;
    if (!ctx.dirty) {
      ctx.dirty = true;
      setTitle();
    }
    // Avoid clobbering the preview while the user is typing there (re-checked in
    // the throttled callback in case focus moves into the preview within the frame).
    if (!ctx.editingInPreview) {
      previewRenderThrottle.schedule(() => {
        if (!ctx.editingInPreview) ctx.preview.setDoc(doc);
      });
    }
    deps.updateWordCount(doc);
    scheduleAutosave();
    deps.scheduleSessionSnapshot();
  }

  function onSuppressedEditorChange(doc: string, syncPreview = false, mutationAlreadyRecorded = false): void {
    if (!mutationAlreadyRecorded && !recordDocumentMutation()) return;
    handleSuppressedDocumentChange(doc, {
      isDirty: () => ctx.dirty,
      markDirty: () => {
        ctx.dirty = true;
        setTitle();
      },
      syncPreview: syncPreview ? (updatedDoc) => ctx.preview.setDoc(updatedDoc) : undefined,
      updateWordCount: deps.updateWordCount,
      scheduleAutosave,
      scheduleSessionSnapshot: deps.scheduleSessionSnapshot,
    });
  }

  function replaceDocument({
    doc,
    currentPath,
    pendingTitle,
    dirty,
    syncPreview = true,
    scheduleSnapshot = true,
  }: {
    doc: string;
    currentPath: string | null;
    pendingTitle: string | null;
    dirty: boolean;
    syncPreview?: boolean;
    scheduleSnapshot?: boolean;
  }): boolean {
    if (!tryMutateDocument()) return false;
    ctx.suppressEditorChange = true;
    ctx.editor.setDoc(doc);
    ctx.suppressEditorChange = false;
    ctx.currentPath = currentPath;
    ctx.pendingTitle = pendingTitle;
    recordDocumentMutation();
    if (syncPreview && !ctx.editingInPreview) ctx.preview.setDoc(doc);
    ctx.dirty = dirty;
    setTitle();
    deps.updateWordCount(doc);
    if (scheduleSnapshot) deps.scheduleSessionSnapshot();
    return true;
  }

  function newDoc() {
    if (!replaceDocument({ doc: '', currentPath: null, pendingTitle: null, dirty: false })) return;
    ctx.setStatus(deps.t('status.newDocument'));
    ctx.editor.focus();
  }

  async function saveIfDirtyBeforeReplace(): Promise<boolean> {
    if (!ctx.dirty) return true;
    if (!window.confirm(deps.t('panel.files.savePrompt'))) return false;
    await save();
    // save() clears `dirty` on success; if it stayed dirty the save was blocked.
    return !ctx.dirty;
  }

  function wireTitle() {
    deps.titleEl.addEventListener('focus', () => deps.titleEl.select());
    deps.titleEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        deps.titleEl.blur();
      }
      if (e.key === 'Escape') {
        deps.titleEl.value = displayTitle();
        deps.titleEl.blur();
      }
    });
    deps.titleEl.addEventListener('blur', () => {
      const raw = deps.titleEl.value.trim();
      if (!raw || raw === displayTitle()) {
        deps.titleEl.value = displayTitle();
        return;
      }
      if (!tryMutateDocument()) {
        deps.titleEl.value = displayTitle();
        return;
      }
      const withExt = /\.\w+$/.test(raw) ? raw : `${raw}.md`;
      if (ctx.currentPath) {
        const dir = ctx.currentPath.replace(/\/[^/]+$/, '');
        const newPath = `${dir}/${withExt}`;
        void (async () => {
          const revision = await saveTo(newPath);
          if (revision !== null) {
            ctx.setStatus(deps.t('status.renamed').replace('{filePath}', ctx.currentPath ?? newPath));
          }
        })();
      } else {
        ctx.pendingTitle = withExt;
        deps.titleEl.value = withExt;
        ctx.setStatus(deps.t('status.titleSet').replace('{title}', withExt));
      }
    });
  }

  function wireFileOpened() {
    deps.api.onFileOpened((payload: any) => {
      const { filePath, content, html, converted, error } = payload as {
        filePath: string | null;
        content: string;
        html?: string;
        converted?: { from: string; originalPath: string };
        error?: string;
      };
      if (error) {
        ctx.setStatus(`⚠ ${error === 'converter-worker-failed' ? deps.t('file.convert.workerFailed') : error}`);
        return;
      }
      if (!tryMutateDocument()) return;
      let docMd = content;
      // Every open/new resets the HTML-view toggle so a converted doc never inherits
      // the previous document's rich-HTML view state.
      ctx.showingConvertedHtml = false;
      if (html && converted) {
        try {
          const md = deps.htmlToMarkdown(html);
          if (md && md.trim().length > 0) docMd = md;
        } catch (e) {
          console.warn('turndown of kordoc HTML failed; using raw markdown:', e);
        }
        ctx.convertedHtml = html;
      } else {
        ctx.convertedHtml = null;
      }
      replaceDocument({
        doc: docMd,
        currentPath: filePath ?? null,
        pendingTitle: null,
        dirty: !!converted,
        scheduleSnapshot: false,
      });
      deps.syncWorkspaceRootToCurrent();
      if (ctx.showingConvertedHtml && ctx.convertedHtml) {
        // Converted HTML is sanitized into an inert fragment (never raw innerHTML).
        ctx.preview.el.replaceChildren(deps.buildConvertedHtmlFrame(ctx.convertedHtml));
      }
      deps.updateHtmlViewToggle();
      if (converted) {
        ctx.setStatus(deps.t('status.converted').replace('{format}', converted.from).replace('{filePath}', filePath ?? ''));
      } else {
        ctx.setStatus(deps.t('status.opened').replace('{filePath}', filePath ?? ''));
      }
    });
  }

  function wireMenuActions(cyclePreviewMode: () => void) {
    deps.api.onMenuNew(newDoc);
    deps.api.onMenuSave(() => void save());
    deps.api.onMenuSaveAs(() => void saveAs());
    deps.api.onTogglePreview(cyclePreviewMode);
  }

  function beginCloseLease(id: string): void {
    // A new query replaces an uncommitted/old transaction. Fencing begins only
    // at consume or discard preparation; querying must leave editing available.
    if (closeLease?.consumed) {
      // A new query supersedes a completed close attempt; its old discard/consume
      // fence cannot constrain the new lease.
      savesFenced = false;
      discardFenced = false;
      if (ctx.dirty && ctx.currentPath) scheduleAutosave();
    }
    closeLease = { id, revision: ctx.docRevision, invalidated: false, consumed: false };
    reconcileMutationFence();
  }

  function authorizeCloseLease(id: string): boolean {
    return closeLease?.id === id && !closeLease.invalidated && !closeLease.consumed && closeLease.revision === ctx.docRevision;
  }

  function consumeCloseLease(id: string): boolean {
    if (!authorizeCloseLease(id)) return false;
    closeLease!.consumed = true;
    reconcileMutationFence();
    // An approved consume is the quiesce commit. Keep the mutation fence shut
    // for teardown, but cancel crash-recovery expiry so it cannot reopen an
    // already-approved window.
    if (quiesce?.expiry) clearTimeout(quiesce.expiry);
    quiesce = null;
    return true;
  }

  async function fenceDiscard(id: string): Promise<boolean> {
    if (!authorizeCloseLease(id)) return false;
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = null;
    savesFenced = true;
    discardFenced = true;
    await saveTail;
    if (!authorizeCloseLease(id)) return false;
    reconcileMutationFence();
    return true;
  }

  function rollbackDiscardFence(id: string): boolean {
    if (closeLease?.id !== id) return false;
    // Save remains fenced until canonical source catches up with any DOM-only
    // preview edit. A failure is deliberately retryable through a later close
    // query, but must never reopen a stale-source save path.
    try {
      allowingCloseFlush = true;
      flushPendingPreview?.();
    } catch (error) {
      console.warn('[close] keeping save fenced after preview flush failure:', error);
      return false;
    } finally {
      allowingCloseFlush = false;
    }
    savesFenced = false;
    discardFenced = false;
    closeLease = null;
    reconcileMutationFence();
    if (ctx.dirty && ctx.currentPath) scheduleAutosave();
    return true;
  }

  function setPreviewFlushGate(flush: () => void): void {
    flushPendingPreview = flush;
  }
  function isSaveFenced(): boolean {
    return savesFenced || previewSyncFailed;
  }

  function markPreviewSyncFailed(): void {
    previewSyncFailed = true;
    savesFenced = true;
    reconcileMutationFence();
  }

  function markPreviewSyncRecovered(): void {
    previewSyncFailed = false;
    if (!discardFenced && !quiesce) savesFenced = false;
    reconcileMutationFence();
  }


  function setPreviewQuiesceHooks(hooks: { pause: () => boolean; resume: (wasPending: boolean) => void }): void {
    quiescePreview = hooks;
  }

  function armQuiesceExpiry(id: string, ttlMs: number): void {
    if (!quiesce || quiesce.id !== id) return;
    if (quiesce.expiry) clearTimeout(quiesce.expiry);
    quiesce.expiry = setTimeout(() => { void rollbackCloseQuiesce(id); }, Math.max(1, ttlMs));
  }

  async function prepareCloseQuiesce(id: string, ttlMs: number): Promise<boolean> {
    if (quiesce && quiesce.id !== id) return false;
    const autosavePending = autosaveTimer !== null;
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = null;
    const previewPending = quiescePreview?.pause() ?? false;
    savesFenced = true;
    quiesce = { id, expiry: null, autosavePending, previewPending };
    reconcileMutationFence();
    armQuiesceExpiry(id, ttlMs);
    return true;
  }

  function heartbeatCloseQuiesce(id: string, ttlMs: number): boolean {
    if (!quiesce || quiesce.id !== id) return false;
    armQuiesceExpiry(id, ttlMs);
    return true;
  }

  async function rollbackCloseQuiesce(id: string): Promise<boolean> {
    if (!quiesce || quiesce.id !== id) return false;
    const current = quiesce;
    if (current.expiry) clearTimeout(current.expiry);
    try {
      allowingCloseFlush = true;
      flushPendingPreview?.();
    } catch (error) {
      console.warn('[close] autonomous quiesce rollback kept save fenced:', error);
      return false;
    } finally {
      allowingCloseFlush = false;
    }
    quiesce = null;
    if (closeLease && !closeLease.consumed) invalidateCloseLease();
    if (!discardFenced && !previewSyncFailed) savesFenced = false;
    reconcileMutationFence();
    quiescePreview?.resume(current.previewPending);
    if ((current.autosavePending || ctx.dirty) && ctx.currentPath) scheduleAutosave();
    return true;
  }

  function commitCloseQuiesce(id: string): boolean {
    if (!quiesce || quiesce.id !== id) return false;
    if (quiesce.expiry) clearTimeout(quiesce.expiry);
    quiesce = null;
    reconcileMutationFence();
    return true;
  }

  return {
    tryMutateDocument,
    recordPreviewInput,
    onDocChange,
    onSuppressedEditorChange,
    replaceDocument,
    beginCloseLease,
    consumeCloseLease,
    authorizeCloseLease,
    fenceDiscard,
    rollbackDiscardFence,
    setPreviewFlushGate,
    isSaveFenced,
    markPreviewSyncFailed,
    markPreviewSyncRecovered,
    setPreviewQuiesceHooks,
    prepareCloseQuiesce,
    heartbeatCloseQuiesce,
    rollbackCloseQuiesce,
    commitCloseQuiesce,
    save,
    saveIfDirtyBeforeReplace,
    setTitle,
    wireTitle,
    wireFileOpened,
    wireMenuActions,
  };
}
