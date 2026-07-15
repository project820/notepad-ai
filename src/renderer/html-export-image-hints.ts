import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5';
import { createMarkdownIt } from './markdown-it';

import type {
  HtmlAssetBasenameHint,
  HtmlAssetId,
  HtmlAssetSummary,
  HtmlAssetWarning,
} from '../shared/html-export-assets';

declare const htmlExportImageHintId: unique symbol;

/** Opaque display-only ID bound to the complete Markdown document and image occurrence. */
type HtmlExportImageHintId = string & {
  readonly [htmlExportImageHintId]: true;
};

/** A local image reference reduced to renderer-safe display data. */
export type HtmlExportImageHint = HtmlAssetBasenameHint & {
  readonly id: HtmlExportImageHintId;
  readonly required: boolean;
};

export type HtmlExportImageHintMatch =
  | {
      readonly hintId: HtmlExportImageHintId;
      readonly basename: string;
      readonly status: 'suggested';
      readonly assetId: HtmlAssetId;
      readonly requiresExplicitAssignment: true;
    }
  | {
      readonly hintId: HtmlExportImageHintId;
      readonly basename: string;
      readonly status: 'requires-assignment';
      readonly candidateAssetIds: readonly HtmlAssetId[];
      readonly requiresExplicitAssignment: true;
    };

/** A user-confirmed association; suggestions are deliberately not assignments. */
export type HtmlExportImageAssignment = {
  readonly status: 'confirmed';
  readonly hintId: HtmlExportImageHintId;
  readonly assetId: HtmlAssetId;
};

/**
 * Renderer-safe data for the existing partial-artifact flow. It contains no
 * filesystem locator: the placeholder identifies only the unresolved hint.
 */
export type HtmlExportMissingAssetRecord = {
  readonly warning: HtmlAssetWarning;
  readonly placeholder: {
    readonly kind: 'missing-asset';
    readonly hintId: HtmlExportImageHintId;
    readonly basename: string;
  };
};

// This parser is used only to expose raw HTML tokens to the hint extractor.
const imageHintMarkdownParser = createMarkdownIt().set({ html: true });

/**
 * Extracts local Markdown and raw HTML image nodes without resolving or reading
 * them. Every accepted reference becomes a basename-only required hint.
 */
export function parseHtmlExportImageHints(markdown: string): readonly HtmlExportImageHint[] {
  const hints: HtmlExportImageHint[] = [];

  for (const reference of readImageReferences(markdown)) {
    const basename = displayBasename(reference);
    if (!basename) continue;

    hints.push({
      id: createImageHintId(markdown, hints.length),
      basename,
      required: true,
    });
  }

  return hints;
}
/**
 * Creates an explicit user-confirmed assignment for a current document hint
 * and an active selected asset ID.
 */
export function createConfirmedHtmlExportImageAssignment(
  hint: HtmlExportImageHint,
  activeAssetId: HtmlAssetId,
): HtmlExportImageAssignment {
  return {
    status: 'confirmed',
    hintId: hint.id,
    assetId: activeAssetId,
  };
}
function createImageHintId(markdown: string, occurrence: number): HtmlExportImageHintId {
  return `hint-${opaqueDigest(`${markdown}\u0000${occurrence}`)}` as HtmlExportImageHintId;
}

function opaqueDigest(value: string): string {
  let hash = 0xcbf29ce484222325n;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }

  return hash.toString(16).padStart(16, '0');
}

/**
 * Suggests an asset only for an exactly-one basename match. A suggestion is
 * advisory and never turns into a confirmed assignment in this module.
 */
export function matchHtmlExportImageHints(
  hints: readonly HtmlExportImageHint[],
  assets: readonly HtmlAssetSummary[],
): readonly HtmlExportImageHintMatch[] {
  const assetIdsByBasename = new Map<string, HtmlAssetId[]>();

  for (const asset of assets) {
    const assetIds = assetIdsByBasename.get(asset.basename);
    if (assetIds) {
      assetIds.push(asset.assetId);
    } else {
      assetIdsByBasename.set(asset.basename, [asset.assetId]);
    }
  }

  return hints.map((hint) => {
    const candidateAssetIds = assetIdsByBasename.get(hint.basename) ?? [];
    if (candidateAssetIds.length === 1) {
      return {
        hintId: hint.id,
        basename: hint.basename,
        status: 'suggested',
        assetId: candidateAssetIds[0]!,
        requiresExplicitAssignment: true,
      };
    }

    return {
      hintId: hint.id,
      basename: hint.basename,
      status: 'requires-assignment',
      candidateAssetIds: [...candidateAssetIds],
      requiresExplicitAssignment: true,
    };
  });
}

/**
 * Produces typed missing-asset warnings and safe placeholders for required
 * hints that lack a user-confirmed assignment to an active selected asset.
 */
export function createMissingAssetRecords(
  hints: readonly HtmlExportImageHint[],
  assignments: readonly HtmlExportImageAssignment[],
  activeAssets: readonly HtmlAssetSummary[],
): readonly HtmlExportMissingAssetRecord[] {
  const activeAssetIds = new Set(activeAssets.map((asset) => asset.assetId));
  const assignedHintIds = new Set(
    assignments
      .filter((assignment) =>
        assignment.status === 'confirmed' && activeAssetIds.has(assignment.assetId),
      )
      .map((assignment) => assignment.hintId),
  );

  return hints.flatMap((hint) => {
    if (!hint.required || assignedHintIds.has(hint.id)) return [];

    const warning: HtmlAssetWarning = {
      kind: 'missing-asset',
      hintId: hint.id,
      basename: hint.basename,
    };
    return [{
      warning,
      placeholder: {
        kind: 'missing-asset',
        hintId: hint.id,
        basename: hint.basename,
      },
    }];
  });
}

function readImageReferences(markdown: string): readonly string[] {
  const references: string[] = [];

  for (const token of imageHintMarkdownParser.parse(markdown, {})) {
    if (token.type === 'html_block') {
      references.push(...readHtmlImageReferences(token.content));
      continue;
    }
    if (token.type !== 'inline' || !token.children) continue;

    for (const child of token.children) {
      if (child.type === 'image') {
        const source = child.attrGet('src');
        if (source !== null) references.push(source);
      } else if (child.type === 'html_inline') {
        references.push(...readHtmlImageReferences(child.content));
      }
    }
  }

  return references;
}

function readHtmlImageReferences(markup: string): readonly string[] {
  const references: string[] = [];

  const visit = (node: DefaultTreeAdapterTypes.ChildNode): void => {
    if (!('tagName' in node)) return;

    if (node.tagName === 'img') {
      const source = node.attrs.find((attribute) => attribute.name === 'src')?.value;
      if (source !== undefined) references.push(source);
    }
    for (const child of node.childNodes) visit(child);
  };

  for (const child of parseFragment(markup).childNodes) visit(child);
  return references;
}

function displayBasename(reference: string): string | null {
  const literalReference = reference.trim();
  if (!literalReference || isExcludedReference(literalReference)) return null;

  const suffixIndex = firstNonNegative(literalReference.indexOf('?'), literalReference.indexOf('#'));
  const pathPart = suffixIndex === -1 ? literalReference : literalReference.slice(0, suffixIndex);
  if (!pathPart) return null;

  const segments = pathPart.split(/[\\/]/);
  const finalSegment = segments.at(-1);
  if (!finalSegment || finalSegment === '.' || finalSegment === '..') return null;

  const decodedSegments: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') continue;

    const decoded = decodeDisplaySegment(segment);
    if (!decoded || decoded === '.' || decoded === '..') return null;
    decodedSegments.push(decoded);
  }

  return decodedSegments[decodedSegments.length - 1] ?? null;
}

function isExcludedReference(reference: string): boolean {
  return reference.startsWith('#') || reference.startsWith('//') || hasScheme(reference);
}

function hasScheme(reference: string): boolean {
  const colon = reference.search(/[:/?#]/);
  if (colon <= 0 || reference[colon] !== ':') return false;

  for (let index = 0; index < colon; index += 1) {
    const character = reference[index]!;
    const isLetter = (character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z');
    const isDigit = character >= '0' && character <= '9';
    if (index === 0 ? !isLetter : !isLetter && !isDigit && character !== '+' && character !== '-' && character !== '.') {
      return false;
    }
  }
  return true;
}

function decodeDisplaySegment(segment: string): string | null {
  const decoded = tryDecode(segment);
  if (decoded === null || decoded.includes('/') || decoded.includes('\\')) return null;
  for (const character of decoded) {
    if (character <= '\u001f' || character === '\u007f') return null;
  }
  return decoded;
}

function tryDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function firstNonNegative(first: number, second: number): number {
  if (first === -1) return second;
  if (second === -1) return first;
  return Math.min(first, second);
}
