import { createMarkdownIt } from './markdown-it';
import { buildTokenLineRanges, tagPreviewBlocks, tagNestedPreviewBlocks, type SourceLineRange } from './source-preview-map';

export type PreviewHandle = {
  el: HTMLDivElement;
  setDoc: (md: string) => void;
  onAfterRender: (cb: () => void) => void;
  /** Toggle the reading-only line-number gutter (CSS-counter based). */
  setLineNumbers: (enabled: boolean) => void;
  /**
   * Read-only source ↔ preview map for the most recently rendered document.
   * Each entry's `mapId` matches a top-level element's `data-map-id`. Powers the
   * selection-sync (A) and line-alignment (B) features wired in later stories.
   */
  getSourceMap: () => readonly SourceLineRange[];
};

export function createPreview(parent: HTMLElement): PreviewHandle {
  const md = createMarkdownIt();

  const el = document.createElement('div');
  el.className = 'preview';
  parent.appendChild(el);

  // The wrapper is contenteditable so users can edit the rendered document like in MS Word.
  el.setAttribute('contenteditable', 'true');
  el.setAttribute('spellcheck', 'false');

  const callbacks: Array<() => void> = [];
  let sourceMap: SourceLineRange[] = [];

  return {
    el,
    setDoc: (text: string) => {
      el.innerHTML = md.render(text);
      // Tag top-level blocks with their source line spans so source↔preview
      // navigation can map between the editor and the rendered document. The
      // ranges come from the same `md` instance that produced the HTML, so they
      // stay in lock-step with what was rendered.
      sourceMap = buildTokenLineRanges(md, text);
      tagPreviewBlocks(el, sourceMap);
      // Additionally tag nested sub-blocks (list items, table rows, paragraphs in
      // multi-paragraph blocks) so selection sync can highlight only the selected
      // part instead of the whole top-level block. Display-only (Turndown ignores
      // data-*), so the saved markdown stays pristine.
      tagNestedPreviewBlocks(el, md, text);
      callbacks.forEach((cb) => cb());
    },
    onAfterRender: (cb: () => void) => {
      callbacks.push(cb);
    },
    setLineNumbers: (enabled: boolean) => {
      el.classList.toggle('preview-line-numbers', enabled);
    },
    getSourceMap: () => sourceMap,
  };
}
