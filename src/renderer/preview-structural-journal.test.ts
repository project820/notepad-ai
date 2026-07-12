// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { createPreview } from './preview';
import { classifyGapDisposition, type NormalizedEdit } from './source-journal';

function structural(edit: NormalizedEdit) {
  const disposition = classifyGapDisposition(edit);
  if (disposition.kind === 'rerender' || disposition.kind === 'single-block') throw new Error('fixture must be structural');
  return { edit, disposition };
}

describe('preview structural journal commit', () => {
  it('B1 split commits through source assembly without calling whole-document conversion', () => {
    const source = 'before\n\nmid\n\nlast\n';
    const preview = createPreview(document.createElement('div'));
    preview.setDoc(source);
    const owner = preview.el.querySelector<HTMLElement>('[data-run-id="1"]')!;
    owner.textContent = 'left';
    owner.insertAdjacentHTML('afterend', '<p>right</p>');
    const edit: NormalizedEdit = {
      inputType: 'insertParagraph', replacementKind: 'text', boundary: 'middle', boundaryGaps: [],
      range: { kind: 'collapsed', edge: 'interior' },
      affected: { beforeIds: [1], afterIds: [1, 99], delta: 'add' },
    };
    expect(preview.commitSourcePatch(source, [1], structural(edit))).toMatchObject({
      ok: true, markdown: 'before\n\nleft\n\nright\n\nlast\n',
    });
  });

  it('B3 middle delete preserves the preceding gap and removes the following gap', () => {
    const source = 'first\n\nsecond\n\nlast\n';
    const preview = createPreview(document.createElement('div'));
    preview.setDoc(source);
    preview.el.querySelector<HTMLElement>('[data-run-id="1"]')!.remove();
    const edit: NormalizedEdit = {
      inputType: 'deleteContentBackward', replacementKind: 'none', boundary: 'middle', boundaryGaps: [],
      range: { kind: 'selection', coverage: 'whole' },
      affected: { beforeIds: [1], afterIds: [], delta: 'remove' },
    };
    expect(preview.commitSourcePatch(source, [1], structural(edit))).toMatchObject({
      ok: true, markdown: 'first\n\nlast\n',
    });
  });
  it('rejects list structural assembly with an explicit B6 reason', () => {
    const source = '- first\n- second\n';
    const preview = createPreview(document.createElement('div'));
    preview.setDoc(source);
    const edit: NormalizedEdit = {
      inputType: 'insertParagraph', replacementKind: 'text', boundary: 'middle', boundaryGaps: [],
      range: { kind: 'collapsed', edge: 'interior' },
      affected: { beforeIds: [0], afterIds: [0, 9], delta: 'add' },
    };
    expect(preview.commitSourcePatch(source, [0], structural(edit))).toMatchObject({
      ok: false, markdown: source, reason: 'structural-unsupported-subtype',
    });
  });
});
