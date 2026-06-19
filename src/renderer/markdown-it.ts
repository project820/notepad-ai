import MarkdownIt from 'markdown-it';
// @ts-expect-error — no types ship with this plugin
import taskLists from 'markdown-it-task-lists';
// @ts-expect-error — no types ship with this plugin
import footnote from 'markdown-it-footnote';

/**
 * Build the markdown-it instance shared by the live preview and the
 * source↔preview mapping engine (G003).
 *
 * Centralizing the configuration is load-bearing: the source map is derived
 * from the *same* token stream that produces the rendered HTML, so the two can
 * never drift. Any change to plugins or options here is automatically reflected
 * in both the rendered DOM and the line-range map.
 *
 * `html: false` is a hard security boundary — raw HTML in the markdown source is
 * escaped, never injected — and MUST stay false.
 */
export function createMarkdownIt(): MarkdownIt {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    breaks: false,
    typographer: true,
  })
    .use(taskLists, { enabled: true, label: true })
    .use(footnote);

  // Open links in the system browser (Electron preload doesn't add
  // target=_blank automatically).
  const defaultLinkOpen =
    md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const aIndex = tokens[idx].attrIndex('target');
    if (aIndex < 0) tokens[idx].attrPush(['target', '_blank']);
    else tokens[idx].attrs![aIndex][1] = '_blank';
    tokens[idx].attrSet('rel', 'noopener noreferrer');
    return defaultLinkOpen(tokens, idx, options, env, self);
  };

  return md;
}
