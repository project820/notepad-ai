import { describe, expect, it } from 'vitest';

import type { HtmlAssetId, HtmlAssetSummary } from '../shared/html-export-assets';
import {
  createConfirmedHtmlExportImageAssignment,
  createMissingAssetRecords,
  matchHtmlExportImageHints,
  parseHtmlExportImageHints,
  type HtmlExportImageAssignment,
  type HtmlExportImageHint,
} from '../renderer/html-export-image-hints';

function asset(assetId: string, basename: string): HtmlAssetSummary {
  return {
    assetId: assetId as HtmlAssetId,
    basename,
    mime: 'image/png',
    width: 24,
    height: 24,
    encodedBytes: 128,
  };
}
function expectDisplayHints(
  hints: readonly HtmlExportImageHint[],
  basenames: readonly string[],
): void {
  expect(hints).toHaveLength(basenames.length);
  expect(hints.map(({ basename, required }) => ({ basename, required }))).toEqual(
    basenames.map((basename) => ({ basename, required: true })),
  );
  for (const hint of hints) {
    expect(hint.id).toMatch(/^hint-[0-9a-f]{16}$/);
  }
}

describe('html-export image hints', () => {
  it('extracts basename-only required hints from canonical Markdown and raw HTML nodes in source order', () => {
    const hints = parseHtmlExportImageHints([
      '![Logo](./assets/logo%20mark.png?cache=1#preview "title")',
      "<IMG alt='banner' src='icons/banner.jpg'>",
      '<img src=media/diagram.gif />',
    ].join('\n'));

    expectDisplayHints(hints, ['logo mark.png', 'banner.jpg', 'diagram.gif']);
  });

  it('uses Markdown image tokens for inline, reference, shortcut, nested, and escaped syntax', () => {
    const hints = parseHtmlExportImageHints([
      '![inline](inline.png)',
      '![nested [label]](nested.png)',
      '![escaped \\[label\\]](escaped-label.png)',
      '![reference][reference-id]',
      '![collapsed][]',
      '![shortcut]',
      '![escaped destination](foo\\(1\\).png)',
      '',
      '[reference-id]: reference.png',
      '[collapsed]: collapsed.png',
      '[shortcut]: shortcut.png',
    ].join('\n'));

    expectDisplayHints(hints, [
      'inline.png',
      'nested.png',
      'escaped-label.png',
      'reference.png',
      'collapsed.png',
      'shortcut.png',
      'foo(1).png',
    ]);
  });

  it('excludes non-image Markdown contexts and invalid productions while retaining malformed URL literals and later valid images', () => {
    const hints = parseHtmlExportImageHints([
      '`![code](code.png)`',
      '\\![escaped](escaped.png)',
      '<!-- ![comment](comment.png) -->',
      '```markdown',
      '![fence](fence.png)',
      '```',
      '![invalid title](invalid.png not-a-title)',
      '![malformed escape](broken%zz.png)',
      '![later](later.png)',
    ].join('\n'));

    expectDisplayHints(hints, ['broken%zz.png', 'later.png']);
  });

  it('parses complete raw img elements and decoded HTML attributes without scanning comments or attribute text', () => {
    const hints = parseHtmlExportImageHints([
      '<img src="real.png" alt="![demo](fake.png)">',
      '<img alt="![another](also-fake.png)" src="rock&amp;roll.png">',
      '<!-- <img src="comment.png"> -->',
    ].join('\n'));

    expectDisplayHints(hints, ['real.png', 'rock&roll.png']);
  });

  it('excludes remote, executable, hash-only, encoded separator, and unsafe final references', () => {
    const hints = parseHtmlExportImageHints([
      '![remote](https://example.test/logo.png)',
      '<img src="//cdn.example.test/logo.png">',
      '![data](data:image/png;base64,AAAA)',
      '![blob](blob:abc)',
      '![script](javascript:alert(1))',
      '![hash](#logo)',
      '![encoded separator](assets%2Fprivate.png)',
      '![encoded traversal](assets/%2e%2e/private.png)',
      '![empty final](assets/)',
      '![dot final](assets/.)',
      '![dotdot final](assets/..)',
      '![local](images/local%20logo.png?version=2#hero)',
    ].join('\n'));

    expectDisplayHints(hints, ['local logo.png']);
  });
  it('preserves basename-only parent-relative Markdown and raw HTML image hints', () => {
    const hints = parseHtmlExportImageHints([
      '![markdown](../assets/foo.png)',
      '![nested](./images/../icons/bar.png)',
      '<img src="../assets/raw.png">',
      '<img src="../../raw-html.png">',
    ].join('\n'));

    expectDisplayHints(hints, ['foo.png', 'bar.png', 'raw.png', 'raw-html.png']);
  });


  it('treats encoded reserved filename characters as data rather than URI structure', () => {
    const hints = parseHtmlExportImageHints([
      '![encoded hash](%23logo.png)',
      '![encoded colon](report%3Afinal.png)',
    ].join('\n'));

    expectDisplayHints(hints, ['#logo.png', 'report:final.png']);
  });

  it('keeps unique basename matches explicitly non-authoritative', () => {
    const hints = parseHtmlExportImageHints([
      '![duplicate](duplicate.png)',
      '![single](single.png)',
      '![missing](missing.png)',
    ].join('\n'));
    const duplicateFirst = asset('asset-duplicate-a', 'duplicate.png');
    const duplicateSecond = asset('asset-duplicate-b', 'duplicate.png');
    const single = asset('asset-single', 'single.png');

    expect(matchHtmlExportImageHints(hints, [duplicateFirst, duplicateSecond, single])).toEqual([
      {
        hintId: hints[0]!.id,
        basename: 'duplicate.png',
        status: 'requires-assignment',
        candidateAssetIds: ['asset-duplicate-a', 'asset-duplicate-b'],
        requiresExplicitAssignment: true,
      },
      {
        hintId: hints[1]!.id,
        basename: 'single.png',
        status: 'suggested',
        assetId: 'asset-single',
        requiresExplicitAssignment: true,
      },
      {
        hintId: hints[2]!.id,
        basename: 'missing.png',
        status: 'requires-assignment',
        candidateAssetIds: [],
        requiresExplicitAssignment: true,
      },
    ]);
  });
  it('does not treat a suggested match as a confirmed assignment', () => {
    const [hint] = parseHtmlExportImageHints('![Unique](unique.png)');
    const selected = asset('asset-unique', 'unique.png');
    const suggestion = matchHtmlExportImageHints([hint!], [selected])[0]!;

    expect(suggestion.status).toBe('suggested');
    expect(createMissingAssetRecords(
      [hint!],
      [suggestion as unknown as HtmlExportImageAssignment],
      [selected],
    )).toHaveLength(1);

    expect(createMissingAssetRecords([hint!], [
      createConfirmedHtmlExportImageAssignment(hint!, selected.assetId),
    ], [selected])).toEqual([]);
  });


  it('creates missing-asset records only when assignments resolve to active selected assets', () => {
    const hints: readonly HtmlExportImageHint[] = [
      { id: 'hint-0000000000000000' as HtmlExportImageHint['id'], basename: 'assigned.png', required: true },
      { id: 'hint-0000000000000001' as HtmlExportImageHint['id'], basename: 'stale.png', required: true },
      { id: 'hint-0000000000000002' as HtmlExportImageHint['id'], basename: 'optional.png', required: false },
    ];
    const assigned = asset('asset-assigned', 'assigned.png');

    expect(createMissingAssetRecords(hints, [
      createConfirmedHtmlExportImageAssignment(hints[0]!, assigned.assetId),
      createConfirmedHtmlExportImageAssignment(hints[1]!, 'asset-stale' as HtmlAssetId),
    ], [assigned])).toEqual([
      {
        warning: {
          kind: 'missing-asset',
          hintId: 'hint-0000000000000001',
          basename: 'stale.png',
        },
        placeholder: {
          kind: 'missing-asset',
          hintId: 'hint-0000000000000001',
          basename: 'stale.png',
        },
      },
    ]);
  });
  it('keeps a uniquely named active asset missing until an explicit assignment names it', () => {
    const [hint] = parseHtmlExportImageHints('![Unique](unique.png)');
    const selected = asset('asset-unique', 'unique.png');

    expect(createMissingAssetRecords([hint!], [], [selected])).toEqual([
      {
        warning: { kind: 'missing-asset', hintId: hint!.id, basename: 'unique.png' },
        placeholder: { kind: 'missing-asset', hintId: hint!.id, basename: 'unique.png' },
      },
    ]);
    expect(createMissingAssetRecords([hint!], [
      createConfirmedHtmlExportImageAssignment(hint!, selected.assetId),
    ], [selected])).toEqual([]);
  });
  it('treats explicit asset ID confirmation as authoritative over a basename hint', () => {
    const [hint] = parseHtmlExportImageHints('![Chart](chart.png)');
    const differentlyNamed = asset('asset-explicit', 'selected-file.png');

    expect(createMissingAssetRecords([hint!], [
      createConfirmedHtmlExportImageAssignment(hint!, differentlyNamed.assetId),
    ], [differentlyNamed])).toEqual([]);
    expect(createMissingAssetRecords([hint!], [
      createConfirmedHtmlExportImageAssignment(hint!, 'asset-stale' as HtmlAssetId),
    ], [differentlyNamed])).toHaveLength(1);
  });
  it('invalidates confirmed assignments after document replacement, insertion, deletion, or reorder', () => {
    const original = [
      '![First](first.png)',
      '![Second](second.png)',
    ].join('\n');
    const [originalHint] = parseHtmlExportImageHints(original);
    const active = asset('asset-first', 'first.png');
    const assignment = createConfirmedHtmlExportImageAssignment(originalHint!, active.assetId);

    for (const markdown of [
      '![Replacement](replacement.png)\n![Second](second.png)',
      '![Inserted](inserted.png)\n![First](first.png)\n![Second](second.png)',
      '![Second](second.png)',
      '![Second](second.png)\n![First](first.png)',
    ]) {
      const currentHints = parseHtmlExportImageHints(markdown);
      const records = createMissingAssetRecords(currentHints, [assignment], [active]);

      expect(records.map((record) => record.warning.hintId)).toEqual(
        currentHints.map((hint) => hint.id),
      );
    }
  });

  it('keeps renderer-facing hint and warning data free of path fields', () => {
    const [hint] = parseHtmlExportImageHints('![Logo](private/folder/logo.png)');
    const [record] = createMissingAssetRecords([hint!], [], []);

    expect(Object.keys(hint!)).toEqual(['id', 'basename', 'required']);
    expect(Object.keys(record!.warning)).toEqual(['kind', 'hintId', 'basename']);
    expect(JSON.stringify({ hint, record })).not.toContain('private/folder');
    expect(JSON.stringify({ hint, record })).not.toContain('path');
  });
});
