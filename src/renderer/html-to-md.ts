import TurndownService from 'turndown';
// @ts-expect-error — bundled JS, no types
import { gfm } from 'turndown-plugin-gfm';

/**
 * A heading `id` is emitted as a trailing `{#id}` attribute token, which
 * markdown-it-attrs parses only when the id is a single brace/whitespace-free
 * token. Sanitize so a hostile/odd id (spaces, `}`, newlines, `onclick=…`)
 * cannot corrupt the round-trip or smuggle extra attrs (G006 heading-id check).
 */
export function safeHeadingId(raw: string): string {
  return (raw ?? '')
    .trim()
    .replace(/[^\w-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128);
}

let cachedService: TurndownService | null = null;

function buildService(): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '_',
    strongDelimiter: '**',
    linkStyle: 'inlined',
  });
  td.use(gfm);

  // Convert <input type=checkbox> back to MD task marker.
  td.addRule('taskCheckbox', {
    filter: (node) => node.nodeName === 'INPUT' && (node as HTMLInputElement).type === 'checkbox',
    replacement: (_content, node) => {
      const checked = (node as HTMLInputElement).checked;
      return checked ? '[x] ' : '[ ] ';
    },
  });

  // Strip our internal toolbar / table-wrap chrome before serializing.
  td.addRule('stripChrome', {
    filter: (node) =>
      (node as HTMLElement).classList?.contains('table-toolbar') ||
      (node as HTMLElement).classList?.contains('tb-picker'),
    replacement: () => '',
  });

  // ===== Extended markdown round-trip (==mark==, ^sup^, heading ids, deflists) =====

  // <mark> → ==highlight==
  td.addRule('mark', {
    filter: ['mark'],
    replacement: (content) => '==' + content + '==',
  });

  // <sup> → ^superscript^
  td.addRule('sup', {
    filter: ['sup'],
    replacement: (content) => '^' + content + '^',
  });

  // Headings → ATX, preserving an explicit `id` as a trailing `{#id}` attr token.
  td.addRule('headingId', {
    filter: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
    replacement: (content, node) => {
      const level = Number(node.nodeName.charAt(1));
      const id = safeHeadingId(node.id);
      return '\n\n' + '#'.repeat(level) + ' ' + content + (id ? ` {#${id}}` : '') + '\n\n';
    },
  });

  // <dl> → definition-list markdown: each term on its own line, each
  // definition prefixed with `: `. Handles multiple dt/dd pairs.
  td.addRule('definitionList', {
    filter: (node) => node.nodeName === 'DL',
    replacement: (_content, node) => {
      const lines: string[] = [];
      node.childNodes.forEach((child) => {
        if (child.nodeName === 'DT') lines.push((child.textContent ?? '').trim());
        else if (child.nodeName === 'DD') lines.push(': ' + (child.textContent ?? '').trim());
      });
      return '\n' + lines.join('\n') + '\n';
    },
  });

  // Hard-strip elements that have NO markdown representation and would otherwise
  // leak garbage text or unsafe content into the output (validated node-type
  // restriction, G006). kordoc.renderHtml() inlines <style>/<script> etc.; the
  // embed/form/media set never round-trips to markdown. (img is kept — gfm emits
  // `![]()`.)
  td.remove([
    'style',
    'script',
    'head',
    'meta',
    'link',
    'noscript',
    'iframe',
    'object',
    'embed',
    'svg',
    'canvas',
    'form',
    'button',
    'select',
    'textarea',
    'audio',
    'video',
    'base',
    'applet',
  ] as never[]); // tag list is broader than Turndown's DOM-typed Filter (svg/applet)

  return td;
}

export function htmlToMarkdown(html: string): string {
  if (!cachedService) cachedService = buildService();
  return cachedService.turndown(html).replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
