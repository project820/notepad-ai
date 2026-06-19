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
