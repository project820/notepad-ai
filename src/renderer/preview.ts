import MarkdownIt from 'markdown-it';
// @ts-expect-error — no types ship with this plugin
import taskLists from 'markdown-it-task-lists';
// @ts-expect-error — no types ship with this plugin
import footnote from 'markdown-it-footnote';

export type PreviewHandle = {
  el: HTMLDivElement;
  setDoc: (md: string) => void;
  onAfterRender: (cb: () => void) => void;
  /** Toggle the reading-only line-number gutter (CSS-counter based). */
  setLineNumbers: (enabled: boolean) => void;
};

export function createPreview(parent: HTMLElement): PreviewHandle {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    breaks: false,
    typographer: true,
  })
    .use(taskLists, { enabled: true, label: true })
    .use(footnote);

  // Open links in the system browser (Electron preload doesn't add target=_blank automatically).
  const defaultLinkOpen =
    md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const aIndex = tokens[idx].attrIndex('target');
    if (aIndex < 0) tokens[idx].attrPush(['target', '_blank']);
    else tokens[idx].attrs![aIndex][1] = '_blank';
    tokens[idx].attrSet('rel', 'noopener noreferrer');
    return defaultLinkOpen(tokens, idx, options, env, self);
  };

  const el = document.createElement('div');
  el.className = 'preview';
  parent.appendChild(el);

  // The wrapper is contenteditable so users can edit the rendered document like in MS Word.
  el.setAttribute('contenteditable', 'true');
  el.setAttribute('spellcheck', 'false');

  const callbacks: Array<() => void> = [];

  return {
    el,
    setDoc: (text: string) => {
      el.innerHTML = md.render(text);
      callbacks.forEach((cb) => cb());
    },
    onAfterRender: (cb: () => void) => {
      callbacks.push(cb);
    },
    setLineNumbers: (enabled: boolean) => {
      el.classList.toggle('preview-line-numbers', enabled);
    },
  };
}
