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

  function invalidateCloseLease(): void {
    if (!closeLease || closeLease.invalidated || closeLease.consumed) return;
    closeLease.invalidated = true;
    deps.api.sendCloseLeaseInvalidated(closeLease.id, ctx.docRevision);
  }

  function recordDocumentMutation(): boolean {
    if (closeLease?.consumed) return false;
    ctx.docRevision += 1;
    invalidateCloseLease();
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
    const queued = saveTail.then(() => (savesFenced ? null : performSave(filePath)));
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
      previewRenderThrottle(() => {
        if (!ctx.editingInPreview) ctx.preview.setDoc(doc);
      });
    }
    deps.updateWordCount(doc);
    scheduleAutosave();
    deps.scheduleSessionSnapshot();
  }

  function onSuppressedEditorChange(doc: string, syncPreview = false): void {
    if (!recordDocumentMutation()) return;
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
  }): void {
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
  }

  function newDoc() {
    replaceDocument({ doc: '', currentPath: null, pendingTitle: null, dirty: false });
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
    closeLease = { id, revision: ctx.docRevision, invalidated: false, consumed: false };
  }

  function authorizeCloseLease(id: string): boolean {
    return closeLease?.id === id && !closeLease.invalidated && !closeLease.consumed && closeLease.revision === ctx.docRevision;
  }

  function consumeCloseLease(id: string): boolean {
    if (!authorizeCloseLease(id)) return false;
    closeLease!.consumed = true;
    return true;
  }

  async function fenceDiscard(id: string): Promise<boolean> {
    if (!authorizeCloseLease(id)) return false;
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = null;
    savesFenced = true;
    await saveTail;
    return authorizeCloseLease(id);
  }

  function rollbackDiscardFence(): void {
    savesFenced = false;
    closeLease = null;
    if (ctx.dirty && ctx.currentPath) scheduleAutosave();
  }

  return {
    onDocChange,
    onSuppressedEditorChange,
    replaceDocument,
    beginCloseLease,
    consumeCloseLease,
    authorizeCloseLease,
    fenceDiscard,
    rollbackDiscardFence,
    save,
    saveIfDirtyBeforeReplace,
    setTitle,
    wireTitle,
    wireFileOpened,
    wireMenuActions,
  };
}
