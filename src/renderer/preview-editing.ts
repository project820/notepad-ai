import { buildConvertedHtmlFrame } from './sanitize-html';
import { classifyGapDisposition, type MapId, type NormalizedEdit, type SourceOnlySlice } from './source-journal';


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

export type PreviewEditSnapshot = {
  inputType: string;
  ownerIds: MapId[];
  selectedIds: MapId[];
  blockCount: number;
  range: NormalizedEdit['range'];
};

function ownerFor(node: Node | null): HTMLElement | null {
  const element = node?.nodeType === Node.ELEMENT_NODE ? node as Element : node?.parentElement;
  return element?.closest<HTMLElement>('[data-run-id]') ?? null;
}

function ownerIdsInRange(root: HTMLElement, range: Range | StaticRange | null): MapId[] {
  if (!range) return [];
  const owners = Array.from(root.querySelectorAll<HTMLElement>('[data-run-id]'));
  return owners
    .filter((owner) => {
      const ownerRange = document.createRange();
      ownerRange.selectNodeContents(owner);
      return (range as Range).intersectsNode(owner) || range.toString() === ownerRange.toString();
    })
    .map((owner) => Number(owner.dataset.runId))
    .filter(Number.isInteger);
}

function selectionRange(event: InputEvent): Range | StaticRange | null {
  const targetRanges = event.getTargetRanges?.() ?? [];
  if (targetRanges.length > 0) return targetRanges[0];
  const selection = window.getSelection();
  return selection?.rangeCount ? selection.getRangeAt(0) : null;
}

function normalizedRange(root: HTMLElement, range: Range | StaticRange | null): NormalizedEdit['range'] {
  if (!range) return { kind: 'collapsed', edge: 'interior' };
  if (!range.collapsed) {
    const selected = ownerIdsInRange(root, range);
    const startOwner = ownerFor(range.startContainer);
    const endOwner = ownerFor(range.endContainer);
    const whole = selected.length > 0 && selected.every((id) => {
      const owner = root.querySelector<HTMLElement>(`[data-run-id="${id}"]`);
      return owner != null && range.toString().includes(owner.textContent ?? '');
    });
    return { kind: 'selection', coverage: whole && startOwner && endOwner ? 'whole' : 'partial' };
  }
  const owner = ownerFor(range.startContainer);
  const text = owner?.textContent ?? '';
  const offset = range.startOffset;
  if (offset === 0) return { kind: 'collapsed', edge: 'blockStart' };
  if (range.startContainer.nodeType === Node.TEXT_NODE && offset >= text.length) return { kind: 'collapsed', edge: 'blockEnd' };
  return { kind: 'collapsed', edge: 'interior' };
}

function previewBlockCount(root: HTMLElement): number {
  return root.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,td,th,dd').length;
}

export function capturePreviewEditSnapshot(root: HTMLElement, event: InputEvent): PreviewEditSnapshot {
  const range = selectionRange(event);
  const ownerIds = Array.from(root.querySelectorAll<HTMLElement>('[data-run-id]'))
    .map((owner) => Number(owner.dataset.runId))
    .filter(Number.isInteger);
  const selectedIds = ownerIdsInRange(root, range);
  return { inputType: event.inputType, ownerIds, selectedIds, blockCount: previewBlockCount(root), range: normalizedRange(root, range) };
}

export function normalizePreviewEdit(
  root: HTMLElement,
  event: InputEvent,
  before: PreviewEditSnapshot,
  sourceGaps: NormalizedEdit['boundaryGaps'] = [],
): NormalizedEdit {
  const allAfter = Array.from(root.querySelectorAll<HTMLElement>('[data-run-id]'))
    .map((owner) => Number(owner.dataset.runId))
    .filter(Number.isInteger);
  const beforeIds = before.selectedIds.length > 0 ? before.selectedIds : before.ownerIds;
  let afterIds = allAfter.filter((id) => beforeIds.includes(id));
  const afterBlocks = previewBlockCount(root);
  if (event.inputType === 'insertParagraph' && afterBlocks > before.blockCount && afterIds.length === beforeIds.length) {
    afterIds = [...afterIds, -afterBlocks];
  }
  const removed = beforeIds.filter((id) => !afterIds.includes(id));
  const added = afterIds.filter((id) => !beforeIds.includes(id));
  const delta = added.length === 0 ? (removed.length === 0 ? 'none' : 'remove') : (removed.length === 0 ? 'add' : 'replace');
  const ordered = before.ownerIds;
  const first = Math.min(...beforeIds.map((id) => ordered.indexOf(id)).filter((index) => index >= 0), Infinity);
  const last = Math.max(...beforeIds.map((id) => ordered.indexOf(id)));
  const boundary = first === 0 && last === ordered.length - 1 ? 'all' : first === 0 ? 'leading' : last === ordered.length - 1 ? 'trailing' : 'middle';
  return {
    inputType: event.inputType,
    replacementKind: event.inputType === 'insertFromPaste' ? 'paste' : event.inputType.startsWith('delete') ? 'none' : 'text',
    boundary,
    boundaryGaps: sourceGaps,
    range: before.range,
    affected: { beforeIds, afterIds, delta },
  };
}

export function initPreviewEditing(ctx: AppContext, deps: PreviewEditingDeps) {
  let previewSyncTimer: ReturnType<typeof setTimeout> | null = null;
  let previewEditPending = false;
  let pendingEdit: NormalizedEdit | null = null;
  let beforeEdit: PreviewEditSnapshot | null = null;
  const pendingRunIds = new Set<number>();

  function runIdFor(target: EventTarget | null): number | null {
    const element = target instanceof Element ? target : null;
    const owner = element?.closest<HTMLElement>('[data-run-id]');
    const id = Number(owner?.dataset.runId);
    return Number.isInteger(id) ? id : null;
  }

  function sourceGaps(): NormalizedEdit['boundaryGaps'] {
    const table = ctx.preview.getRunTable?.();
    if (!table) return [];
    const first = table.runs[0]?.sourceSlices[0]?.[0] ?? 0;
    const last = table.runs.at(-1)?.sourceSlices.at(-1)?.[1] ?? 0;
    return table.intervals
      .filter((interval): interval is SourceOnlySlice => interval.kind !== 'content')
      .map((interval, gapId) => ({
        gapId,
        sourceInterval: interval.span,
        role: interval.span[1] <= first ? 'before' : interval.span[0] >= last ? 'after' : 'between',
      }));
  }

  function captureEdit(event: InputEvent): void {
    pendingEdit = null;
    beforeEdit = capturePreviewEditSnapshot(ctx.preview.el, event);
  }

  function captureCheckboxEdit(target: EventTarget | null): void {
    const id = runIdFor(target);
    pendingEdit = {
      inputType: 'insertReplacementText',
      replacementKind: 'text',
      boundary: 'middle',
      boundaryGaps: sourceGaps(),
      range: { kind: 'collapsed', edge: 'interior' },
      affected: { beforeIds: id == null ? [] : [id], afterIds: id == null ? [] : [id], delta: 'none' },
    };
  }
  function restorePreviewFromSource(): void {
    if (previewSyncTimer) clearTimeout(previewSyncTimer);
    previewSyncTimer = null;
    previewEditPending = false;
    pendingEdit = null;
    beforeEdit = null;
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
    const input = event as InputEvent | undefined;
    if (!pendingEdit && beforeEdit) pendingEdit = normalizePreviewEdit(
      ctx.preview.el,
      input?.inputType ? input : { inputType: beforeEdit.inputType } as InputEvent,
      beforeEdit,
      sourceGaps(),
    );
    beforeEdit = null;
    const id = runIdFor(event?.target ?? null);
    if (id != null) pendingRunIds.add(id);
    if (pendingEdit?.affected.delta === 'none' && pendingEdit.affected.beforeIds.length === 1) pendingRunIds.add(pendingEdit.affected.beforeIds[0]);
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
