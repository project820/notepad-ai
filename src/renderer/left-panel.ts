/**
 * Left collapsible panel (#7): document outline (H1–H3) + footnote list, built
 * from the rendered preview. Push layout (not overlay). Clicking an item jumps
 * to it in the preview. Pure builders are unit-testable; mount wires the DOM.
 */

import { t } from './i18n';

export type OutlineItem = { id: string; level: number; text: string };
export type FootnoteItem = { id: string; text: string };

/** Collect H1–H3 headings from the preview, assigning ids where missing. */
export function buildOutline(root: HTMLElement): OutlineItem[] {
  const heads = Array.from(root.querySelectorAll<HTMLElement>('h1, h2, h3'));
  return heads.map((h, i) => {
    if (!h.id) h.id = `lp-h-${i}`;
    return { id: h.id, level: Number(h.tagName.slice(1)) || 1, text: (h.textContent ?? '').trim() };
  });
}

/** Collect footnote definitions from the preview. */
export function buildFootnotes(root: HTMLElement): FootnoteItem[] {
  const items = Array.from(root.querySelectorAll<HTMLElement>('.footnotes li, li.footnote-item'));
  return items
    .filter((li) => li.id)
    .map((li) => ({ id: li.id, text: (li.textContent ?? '').replace(/↩\uFE0E?/g, '').trim() }));
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export type LeftPanelHandle = {
  refresh: () => void;
  destroy: () => void;
};

export function mountLeftPanel(
  host: HTMLElement,
  opts: { getPreviewRoot: () => HTMLElement; onJump: (el: HTMLElement) => void },
): LeftPanelHandle {
  function render() {
    const root = opts.getPreviewRoot();
    const outline = buildOutline(root);
    const footnotes = buildFootnotes(root);

    const outlineHtml = outline.length
      ? outline
          .map(
            (o) =>
              `<button class="lp-item lp-h${o.level}" data-target="${escapeHtml(o.id)}" type="button">${escapeHtml(o.text || '(untitled)')}</button>`,
          )
          .join('')
      : `<div class="lp-empty">${escapeHtml(t('panel.outlineEmpty'))}</div>`;

    const footHtml = footnotes.length
      ? footnotes
          .map(
            (f, i) =>
              `<button class="lp-item lp-fn" data-target="${escapeHtml(f.id)}" type="button"><span class="lp-fn-n">${i + 1}</span>${escapeHtml(f.text.slice(0, 80))}</button>`,
          )
          .join('')
      : `<div class="lp-empty">${escapeHtml(t('panel.footnotesEmpty'))}</div>`;

    host.innerHTML = `
      <div class="lp-section">
        <div class="lp-title">${escapeHtml(t('panel.outline'))}</div>
        <div class="lp-list">${outlineHtml}</div>
      </div>
      <div class="lp-section">
        <div class="lp-title">${escapeHtml(t('panel.footnotes'))}</div>
        <div class="lp-list">${footHtml}</div>
      </div>`;
  }

  const onClick = (e: Event) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.lp-item');
    if (!btn) return;
    const id = btn.dataset.target;
    if (!id) return;
    const target = opts.getPreviewRoot().querySelector<HTMLElement>(`[id="${id.replace(/["\\]/g, '\\$&')}"]`);
    if (target) opts.onJump(target);
  };

  host.addEventListener('click', onClick);
  render();

  return {
    refresh: render,
    destroy: () => {
      host.removeEventListener('click', onClick);
      host.innerHTML = '';
    },
  };
}
