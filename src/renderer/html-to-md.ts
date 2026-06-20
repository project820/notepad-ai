import TurndownService from 'turndown';
// @ts-expect-error — bundled JS, no types
import { gfm } from 'turndown-plugin-gfm';

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

  // ===== Extended markdown round-trip (==mark==, ~sub~, ^sup^, heading ids, deflists) =====

  // <mark> → ==highlight==
  td.addRule('mark', {
    filter: ['mark'],
    replacement: (content) => '==' + content + '==',
  });

  // <sub> → ~subscript~
  td.addRule('sub', {
    filter: ['sub'],
    replacement: (content) => '~' + content + '~',
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
      const id = node.id;
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

  // Hard-strip elements that should NEVER appear in the markdown output.
  // kordoc.renderHtml() inlines <style> blocks (page CSS) which would
  // otherwise leak verbatim as plain text. Same for <script>, <head>,
  // <meta>, <link>.
  td.remove(['style', 'script', 'head', 'meta', 'link', 'noscript']);

  return td;
}

export function htmlToMarkdown(html: string): string {
  if (!cachedService) cachedService = buildService();
  return cachedService.turndown(html).replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
