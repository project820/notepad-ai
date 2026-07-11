import { buildConvertedHtmlFrame } from './sanitize-html';

import type { AppContext } from './app-context';
import type { htmlToMarkdown } from './html-to-md';
import type { t } from './i18n';

type PreviewEditingDeps = {
  htmlToMarkdown: typeof htmlToMarkdown;
  t: typeof t;
  onSuppressedEditorChange: (doc: string) => void;
};

export function initPreviewEditing(ctx: AppContext, deps: PreviewEditingDeps) {
  let previewSyncTimer: ReturnType<typeof setTimeout> | null = null;

  function flushPreviewToSource(): boolean {
    ctx.preview.el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((el) => {
      el.toggleAttribute('checked', el.checked);
    });
    const md = deps.htmlToMarkdown(ctx.preview.el.innerHTML);
    if (md.trim() === ctx.editor.getDoc().trim()) return false;
    ctx.suppressEditorChange = true;
    ctx.editor.setDoc(md);
    ctx.suppressEditorChange = false;
    deps.onSuppressedEditorChange(md);
    return true;
  }

  function syncPreviewToSource() {
    if (previewSyncTimer) clearTimeout(previewSyncTimer);
    previewSyncTimer = setTimeout(() => {
      if (!ctx.editingInPreview) return;
      flushPreviewToSource();
    }, 350);
  }

  ctx.preview.el.addEventListener('input', () => {
    ctx.editingInPreview = true;
    syncPreviewToSource();
  });
  ctx.preview.el.addEventListener('change', (e) => {
    const target = e.target as HTMLInputElement | null;
    if (target && target.type === 'checkbox') {
      ctx.editingInPreview = true;
      syncPreviewToSource();
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
        ctx.preview.el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((el) => {
          el.toggleAttribute('checked', el.checked);
        });
        const md = deps.htmlToMarkdown(ctx.preview.el.innerHTML);
        if (md.trim() !== ctx.editor.getDoc().trim()) {
          ctx.suppressEditorChange = true;
          ctx.editor.setDoc(md);
          ctx.suppressEditorChange = false;
          deps.onSuppressedEditorChange(md);
        }
        ctx.preview.setDoc(ctx.editor.getDoc());
      }
    }, 100);
  });

  return { flushPreviewToSource, syncPreviewToSource };
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
