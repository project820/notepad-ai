// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { createPreview } from './preview';

describe('preview source patch', () => {
  it('retags a single parsed stream and atomically patches one run', () => {
    const host = document.createElement('div');
    const preview = createPreview(host);
    preview.setDoc('1. first\n\n2. second\n');
    const owner = preview.el.querySelector<HTMLElement>('[data-run-id="1"]')!;
    owner.textContent = 'second!';
    expect(preview.commitSourcePatch('1. first\n\n2. second\n', [1])).toMatchObject({
      ok: true,
      markdown: '1. first\n\n2. second!\n',
    });
    expect(preview.el.querySelectorAll('[data-run-id]')).toHaveLength(2);
  });
  it.each([
    ['> first\n> second\n', '> first\n> second!\n', 'first\nsecond!'],
    ['    a\n    b', '    a\n    b!', 'a\nb!'],
    ['> \t\ta', '> \t\ta!', '  a!\n'],
    ['first  \nsecond\n', 'first  \nsecond!\n', 'first\nsecond!'],
  ])('preserves source-only bytes for %j', (source, expected, edited) => {
    const host = document.createElement('div');
    const preview = createPreview(host);
    preview.setDoc(source);
    const owner = preview.el.querySelector<HTMLElement>('[data-run-id]')!;
    owner.textContent = edited;
    const id = Number(owner.dataset.runId);
    expect(preview.commitSourcePatch(source, [id])).toMatchObject({ ok: true, markdown: expected });
  });
  it('maps mixed normal blocks without a journal mismatch', () => {
    const source = '# H\n\ntext\n\n- a\n- b\n\n> quote\n\n    code\n    more\n\nSetext\n===\n\n---';
    const preview = createPreview(document.createElement('div'));
    preview.setDoc(source);

    expect(preview.getRunTable()).not.toBeNull();
    expect(preview.el.querySelectorAll('[data-run-id]')).toHaveLength(7);
  });

});
