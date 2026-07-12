import { buildConvertedHtmlFrame } from './sanitize-html';
import { classifyGapDisposition, type NormalizedEdit } from './source-journal';


import type { AppContext } from './app-context';
import type { htmlToMarkdown } from './html-to-md';
import type { t } from './i18n';

type PreviewEditingDeps = {
  htmlToMarkdown: typeof htmlToMarkdown;
  t: typeof t;
  onSuppressedEditorChange: (doc: string, syncPreview?: boolean, mutationAlreadyRecorded?: boolean) => void;
  tryMutateDocument: () => boolean;
  recordPreviewInput: () => boolean;
};

export function initPreviewEditing(ctx: AppContext, deps: PreviewEditingDeps) {
  let previewSyncTimer: ReturnType<typeof setTimeout> | null = null;
  let previewEditPending = false;
  let pendingEdit: NormalizedEdit | null = null;
  const pendingRunIds = new Set<number>();

  function runIdFor(target: EventTarget | null): number | null {
    const element = target instanceof Element ? target : null;
    const owner = element?.closest<HTMLElement>('[data-run-id]');
    const id = Number(owner?.dataset.runId);
    return Number.isInteger(id) ? id : null;
  }

  function captureEdit(event: InputEvent): void {
    const id = runIdFor(event.target);
    pendingEdit = {
      inputType: event.inputType,
      replacementKind: event.inputType === 'insertFromPaste' ? 'paste' : event.inputType.startsWith('delete') ? 'none' : 'text',
      boundary: 'middle',
      boundaryGaps: [],
      range: { kind: 'collapsed', edge: 'interior' },
      affected: { beforeIds: id == null ? [] : [id], afterIds: id == null ? [] : [id], delta: 'none' },
    };
  }

  function captureCheckboxEdit(target: EventTarget | null): void {
    const id = runIdFor(target);
    pendingEdit = {
      inputType: 'insertReplacementText',
      replacementKind: 'text',
      boundary: 'middle',
      boundaryGaps: [],
      range: { kind: 'collapsed', edge: 'interior' },
      affected: { beforeIds: id == null ? [] : [id], afterIds: id == null ? [] : [id], delta: 'none' },
    };
  }
  function restorePreviewFromSource(): void {
    if (previewSyncTimer) clearTimeout(previewSyncTimer);
    previewSyncTimer = null;
    previewEditPending = false;
    pendingEdit = null;
    pendingRunIds.clear();
    ctx.editingInPreview = false;
    ctx.preview.setDoc(ctx.editor.getDoc());
  }

  function flushPreviewToSource(): boolean {
    if (!previewEditPending) return false;
    if (!deps.tryMutateDocument()) {
      restorePreviewFromSource();
      return false;
    }
    ctx.preview.el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((el) => {
      el.toggleAttribute('checked', el.checked);
    });

    const disposition = pendingEdit ? classifyGapDisposition(pendingEdit) : { kind: 'rerender' as const, reason: 'missing-normalized-edit' };
    const journal = (ctx.preview as unknown as { commitSourcePatch?: (source: string, ids: readonly number[]) => { ok: boolean; markdown: string } }).commitSourcePatch;
    let md: string | null = null;
    if (!ctx.showingConvertedHtml && disposition.kind === 'single-block' && journal && pendingRunIds.size === 1) {
      const result = journal(ctx.editor.getDoc(), [...pendingRunIds]);
      if (result.ok) md = result.markdown;
      else {
        previewEditPending = false;
        pendingEdit = null;
        pendingRunIds.clear();
        return false;
      }
    } else {
      // Converted HTML and B6 are deliberately kept on the old whole-document
      // conversion path; journal assembly never receives its normalization.
      md = deps.htmlToMarkdown(ctx.preview.el.innerHTML);
    }
    previewEditPending = false;
    pendingEdit = null;
    pendingRunIds.clear();
    if (md === ctx.editor.getDoc()) return false;
    ctx.suppressEditorChange = true;
    ctx.editor.setDoc(md);
    ctx.suppressEditorChange = false;
    deps.onSuppressedEditorChange(md, false, true);
    return true;
  }

  function flushPendingPreviewToSource(): boolean {
    if (!previewEditPending) return false;
    if (previewSyncTimer) clearTimeout(previewSyncTimer);
    previewSyncTimer = null;
    return flushPreviewToSource();
  }

  function syncPreviewToSource() {
    if (previewSyncTimer) clearTimeout(previewSyncTimer);
    previewSyncTimer = setTimeout(() => {
      previewSyncTimer = null;
      if (!ctx.editingInPreview) return;
      flushPreviewToSource();
    }, 350);
  }

  function beginPreviewInput(event?: Event): void {
    if (!deps.tryMutateDocument() || (!previewEditPending && !deps.recordPreviewInput())) {
      restorePreviewFromSource();
      return;
    }
    const id = runIdFor(event?.target ?? null);
    if (id != null) pendingRunIds.add(id);
    ctx.editingInPreview = true;
    previewEditPending = true;
    syncPreviewToSource();
  }

  ctx.preview.el.addEventListener('beforeinput', (e) => {
    if (!deps.tryMutateDocument()) {
      e.preventDefault();
      restorePreviewFromSource();
      return;
    }
    captureEdit(e as InputEvent);
  }, true);
  ctx.preview.el.addEventListener('input', beginPreviewInput);
  ctx.preview.el.addEventListener('change', (e) => {
    const target = e.target as HTMLInputElement | null;
    if (target && target.type === 'checkbox') {
      captureCheckboxEdit(target);
      beginPreviewInput(e);
    }
  });
  ctx.preview.el.addEventListener('focusin', () => {
    ctx.activeSurface = 'preview';
    ctx.setStatus(deps.t('status.editingPreview'));
  });
  ctx.preview.el.addEventListener('focusout', () => {
    setTimeout(() => {
      if (!ctx.preview.el.contains(document.activeElement)) {
        ctx.editingInPreview = false;
        if (previewSyncTimer) clearTimeout(previewSyncTimer);
        previewSyncTimer = null;
        flushPreviewToSource();
        if (previewEditPending) return;
        ctx.preview.setDoc(ctx.editor.getDoc());
      }
    }, 100);
  });

  return { flushPendingPreviewToSource, flushPreviewToSource, syncPreviewToSource };
}
export function createHtmlViewToggle(
  ctx: AppContext,
  deps: { selectionSync: { clearAll: () => void }; scheduleLineAlign: () => void },
) {
  return function updateHtmlViewToggle() {
    let btn = document.getElementById('view-html-toggle') as HTMLButtonElement | null;
    if (!ctx.convertedHtml) {
      btn?.remove();
      return;
    }
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'view-html-toggle';
      btn.className = 'view-html-toggle';
      btn.addEventListener('click', () => {
        ctx.showingConvertedHtml = !ctx.showingConvertedHtml;
        deps.selectionSync.clearAll();
        if (ctx.showingConvertedHtml && ctx.convertedHtml) {
          ctx.preview.el.replaceChildren(buildConvertedHtmlFrame(ctx.convertedHtml));
        } else {
          ctx.preview.setDoc(ctx.editor.getDoc());
        }
        updateHtmlViewToggle();
        deps.scheduleLineAlign();
      });
      document.querySelector('.statusbar')?.insertBefore(btn, document.getElementById('word-count'));
    }
    btn.textContent = ctx.showingConvertedHtml ? 'View MD' : 'View HTML';
    btn.title = ctx.showingConvertedHtml
      ? 'Switch back to the markdown-rendered preview'
      : "Show kordoc's rich HTML rendering";
  };
}
