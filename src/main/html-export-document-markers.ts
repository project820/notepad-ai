export type HtmlExportDocumentMarker = {
  index: number;
  kind: 'doctype' | 'html';
};

export type HtmlExportHeadCspMetaTags = {
  cspMetaRanges: Array<{ start: number; end: number }>;
  headContentStart: number;
};

type HtmlExportTag = {
  source: string;
  start: number;
  end: number;
};

/** Scans HTML tags outside quoted attributes, comments, and raw-text elements. */
function scanHtmlExportTags(source: string, visit: (tag: HtmlExportTag) => void): void {
  let cursor = 0;

  while (cursor < source.length) {
    if (source.startsWith('<!--', cursor)) {
      const commentEnd = source.indexOf('-->', cursor + 4);
      if (commentEnd === -1) return;
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
    if (tagEnd === source.length) return;

    const tag = source.slice(cursor, tagEnd + 1);
    visit({ source: tag, start: cursor, end: tagEnd + 1 });

    const rawTextElement = /^<(style|script|title|textarea)\b/i.exec(tag)?.[1]?.toLowerCase();
    if (rawTextElement) {
      const rawTextClose = new RegExp(`</${rawTextElement}\\s*>`, 'gi');
      rawTextClose.lastIndex = tagEnd + 1;
      const rawTextClosingTag = rawTextClose.exec(source);
      if (!rawTextClosingTag) return;
      cursor = rawTextClosingTag.index + rawTextClosingTag[0].length;
      continue;
    }

    cursor = tagEnd + 1;
  }
}

/** Finds CSP meta tags in the head outside quoted attributes, comments, and raw-text elements. */
export function findHtmlExportHeadCspMetaTags(source: string): HtmlExportHeadCspMetaTags {
  const cspMetaRanges: Array<{ start: number; end: number }> = [];
  let headContentStart = -1;
  let inHead = false;

  scanHtmlExportTags(source, (tag) => {
    if (/^<head\b/i.test(tag.source)) {
      inHead = true;
      headContentStart = tag.end;
    } else if (/^<\/head\s*>$/i.test(tag.source)) {
      inHead = false;
    } else if (
      inHead
      && /^<meta\b/i.test(tag.source)
      && /\bhttp-equiv\s*=\s*(["'])Content-Security-Policy\1/i.test(tag.source)
    ) {
      cspMetaRanges.push({ start: tag.start, end: tag.end });
    }
  });

  return { cspMetaRanges, headContentStart };
}

/** Finds document starts outside quoted attributes, comments, and raw-text elements. */
export function findHtmlExportDocumentMarkers(source: string): HtmlExportDocumentMarker[] {
  const markers: HtmlExportDocumentMarker[] = [];
  let preBalance = 0;

  scanHtmlExportTags(source, (tag) => {
    if (/^<pre\b/i.test(tag.source) && !/\/\s*>$/.test(tag.source)) {
      preBalance += 1;
    } else if (/^<\/pre\s*>$/i.test(tag.source)) {
      preBalance = Math.max(0, preBalance - 1);
    }

    if (preBalance === 0 && /^<!doctype\b/i.test(tag.source)) {
      markers.push({ index: tag.start, kind: 'doctype' });
    } else if (preBalance === 0 && /^<html\b/i.test(tag.source)) {
      markers.push({ index: tag.start, kind: 'html' });
    }
  });

  return markers;
}

/** Finds the last </body> tag outside quoted attributes, comments, and raw-text elements. */
export function findHtmlExportBodyEnd(source: string): number {
  let bodyEnd = -1;

  scanHtmlExportTags(source, (tag) => {
    if (/^<\/body\s*>$/i.test(tag.source)) bodyEnd = tag.start;
  });

  return bodyEnd;
}
