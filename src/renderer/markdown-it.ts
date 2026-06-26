import MarkdownIt from 'markdown-it';
// @ts-expect-error — no types ship with this plugin
import taskLists from 'markdown-it-task-lists';
// @ts-expect-error — no types ship with this plugin
import footnote from 'markdown-it-footnote';
// NOTE: markdown-it-sub (~x~) is intentionally NOT used. In Korean-centric prose
// `~` denotes a numeric range / "approximately" (e.g. `50~55%`), so `~x~` would
// misrender normal text as subscript. Superscript (^x^) is kept (low collision).
// @ts-expect-error — no types ship with this plugin
import mark from 'markdown-it-mark';
// @ts-expect-error — no types ship with this plugin
import sup from 'markdown-it-sup';
// @ts-expect-error — no types ship with this plugin
import { full as emoji } from 'markdown-it-emoji';
// @ts-expect-error — no types ship with this plugin
import deflist from 'markdown-it-deflist';
import attrs from 'markdown-it-attrs';

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
    .use(footnote)
    .use(mark)
    .use(sup)
    .use(emoji)
    .use(deflist)
    .use(attrs, { allowedAttributes: ['id'] });

  // Links never get an automatic target="_blank" (Phase 1 security gate): a new
  // top-level target would route through Electron's window-open path. Instead the
  // preview's click handler (preview-links + link-policy) intercepts every anchor
  // and opens only normalized http/https URLs in the OS browser via IPC. We still
  // stamp rel="noopener noreferrer" as defense-in-depth.
  const defaultLinkOpen =
    md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    tokens[idx].attrSet('rel', 'noopener noreferrer');
    return defaultLinkOpen(tokens, idx, options, env, self);
  };

  return md;
}
