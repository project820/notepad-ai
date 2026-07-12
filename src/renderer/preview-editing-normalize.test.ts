// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';

import { capturePreviewEditSnapshot, normalizePreviewEdit } from './preview-editing';
import { classifyGapDisposition } from './source-journal';

function input(inputType: string): InputEvent {
  return new InputEvent('beforeinput', { bubbles: true, inputType });
}
function root(ids: readonly number[]): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = ids.map((id) => `<p data-run-id="${id}">block ${id}</p>`).join('');
  document.body.append(root);
  return root;
}
function select(root: HTMLElement, from: number, to = from, collapsed = true): void {
  const nodes = root.querySelectorAll<HTMLElement>('[data-run-id]');
  const range = document.createRange();
  range.setStart(nodes[from].firstChild!, 0);
  range.setEnd(nodes[to].firstChild!, collapsed ? 0 : (nodes[to].textContent ?? '').length);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}
afterEach(() => document.body.replaceChildren());

describe('preview beforeinput normalization', () => {
  it('builds an actual B1 split after the browser adds a block', () => {
    const el = root([1]);
    select(el, 0);
    const before = capturePreviewEditSnapshot(el, input('insertParagraph'));
    el.insertAdjacentHTML('beforeend', '<p>new</p>');
    expect(classifyGapDisposition(normalizePreviewEdit(el, input('insertParagraph'), before))).toEqual({ kind: 'split' });
  });
  it('builds B2 merge from a block-edge delete and observed removed owner', () => {
    const el = root([1, 2]);
    select(el, 0);
    const before = capturePreviewEditSnapshot(el, input('deleteContentBackward'));
    el.querySelector('[data-run-id="1"]')!.remove();
    expect(classifyGapDisposition(normalizePreviewEdit(el, input('deleteContentBackward'), before))).toEqual({ kind: 'merge' });
  });
  it('builds B3 whole-block delete from the live selection and removal', () => {
    const el = root([1]);
    select(el, 0, 0, false);
    const before = capturePreviewEditSnapshot(el, input('deleteContentBackward'));
    el.replaceChildren();
    expect(classifyGapDisposition(normalizePreviewEdit(el, input('deleteContentBackward'), before))).toEqual({ kind: 'whole-block-delete', boundary: 'all' });
  });
  it('builds B4 multi-selection replacement from two selected owners', () => {
    const el = root([1, 2]);
    select(el, 0, 1, false);
    const before = capturePreviewEditSnapshot(el, input('insertFromPaste'));
    el.innerHTML = '<p data-run-id="3">replacement</p>';
    expect(classifyGapDisposition(normalizePreviewEdit(el, input('insertFromPaste'), before))).toEqual({ kind: 'multi-selection-replace' });
  });
});
