export type HtmlExportDocumentMarker = {
  index: number;
  kind: 'doctype' | 'html';
};

/** Finds document starts outside quoted attributes, comments, and raw-text elements. */
export function findHtmlExportDocumentMarkers(source: string): HtmlExportDocumentMarker[] {
  const markers: HtmlExportDocumentMarker[] = [];
  let cursor = 0;

  while (cursor < source.length) {
    if (source.startsWith('<!--', cursor)) {
      const commentEnd = source.indexOf('-->', cursor + 4);
      if (commentEnd === -1) return markers;
      cursor = commentEnd + 3;
      continue;
    }

    if (source[cursor] !== '<' || !/[A-Za-z!/]/.test(source[cursor + 1] ?? '')) {
      cursor += 1;
      continue;
    }

    let quote: '"' | "'" | undefined;
    let tagEnd = cursor + 1;
    for (; tagEnd < source.length; tagEnd += 1) {
      const character = source[tagEnd];
      if (quote) {
        if (character === quote) quote = undefined;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        break;
      }
    }
    if (tagEnd === source.length) return markers;

    const tag = source.slice(cursor, tagEnd + 1);
    if (/^<!doctype\b/i.test(tag)) {
      markers.push({ index: cursor, kind: 'doctype' });
    } else if (/^<html\b/i.test(tag)) {
      markers.push({ index: cursor, kind: 'html' });
    }

    const rawTextElement = /^<(style|script)\b/i.exec(tag)?.[1]?.toLowerCase();
    if (rawTextElement) {
      const rawTextClose = new RegExp(`</${rawTextElement}\\s*>`, 'gi');
      rawTextClose.lastIndex = tagEnd + 1;
      const rawTextClosingTag = rawTextClose.exec(source);
      if (!rawTextClosingTag) return markers;
      cursor = rawTextClosingTag.index + rawTextClosingTag[0].length;
      continue;
    }

    cursor = tagEnd + 1;
  }

  return markers;
}
