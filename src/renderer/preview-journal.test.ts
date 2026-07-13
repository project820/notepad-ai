// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { bookmark, createPreview, restoreBookmark } from './preview';

type Golden = { source: string; edit: { runId: number; segments: string[] }; expected: string };
const goldenModules = import.meta.glob('./__fixtures__/preview-roundtrip/*.json', { eager: true }) as Record<string, { default: Golden }>;
const golden = (name: string): Golden => goldenModules[`./__fixtures__/preview-roundtrip/${name}`].default;

describe('preview source patch', () => {
  it.each(['b5-ordered-list.json', 'quote-nested.json', 'indented-code-noLF.json', 'indented-code-nested-tab.json'])(
    'commits the byte-exact %s golden through the preview pipeline',
    (name) => {
      const fixture = golden(name);
      const host = document.createElement('div');
      const preview = createPreview(host);
      preview.setDoc(fixture.source);
      const owner = preview.el.querySelector<HTMLElement>(`[data-run-id="${fixture.edit.runId}"]`)!;
      const prefixes = JSON.parse(owner.dataset.syntheticIndentPrefixes ?? '[]') as string[];
      owner.textContent = fixture.edit.segments.map((segment, index) => `${prefixes[index] ?? ''}${segment}`).join('\n');
      expect(preview.commitSourcePatch(fixture.source, [fixture.edit.runId])).toMatchObject({
        ok: true,
        markdown: fixture.expected,
      });
    },
  );
  it('maps mixed normal blocks without a journal mismatch', () => {
    const source = '# H\n\ntext\n\n- a\n- b\n\n> quote\n\n    code\n    more\n\nSetext\n===\n\n---';
    const preview = createPreview(document.createElement('div'));
    preview.setDoc(source);

    expect(preview.getRunTable()).not.toBeNull();
    expect(preview.el.querySelectorAll('[data-run-id]')).toHaveLength(7);
  });
  it('restores a caret from a label-wrapped task item without a Range offset exception', () => {
    const source = '- [ ] task text';
    const preview = createPreview(document.createElement('div'));
    preview.setDoc(source);
    const text = preview.el.querySelector('label')!.lastChild as Text;
    const range = document.createRange();
    range.setStart(text, 4);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const saved = bookmark(preview.el);
    preview.setDoc(source);
    expect(() => restoreBookmark(preview.el, saved)).not.toThrow();
    expect(selection.anchorNode?.nodeType).toBe(Node.TEXT_NODE);
    expect(selection.anchorOffset).toBe(4);
  });
  it('restores a caret in a later inline node without moving it to the first text node', () => {
    const source = 'foo **bar** baz';
    const preview = createPreview(document.createElement('div'));
    preview.setDoc(source);
    const text = preview.el.querySelector('strong')!.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 3);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const saved = bookmark(preview.el);
    preview.setDoc(source);
    restoreBookmark(preview.el, saved);

    expect(selection.anchorNode?.textContent).toBe('bar');
    expect(selection.anchorOffset).toBe(3);
  });
  it.each([
    ['# not a heading', '\\# not a heading'],
    ['\\# escaped', '\\\\# escaped'],
    ['*star* [link]', '\\*star\\* \\[link\\]'],
    ['==x==', '\\=\\=x\\=\\='],
    ['^x^', '\\^x\\^'],
  ] as const)('commits literal %j without changing paragraph structure', (literal, expected) => {
    const source = 'original\n';
    const preview = createPreview(document.createElement('div'));
    preview.setDoc(source);
    preview.el.querySelector<HTMLElement>('[data-run-id="0"]')!.textContent = literal;
    expect(preview.commitSourcePatch(source, [0])).toMatchObject({ ok: true, markdown: `${expected}\n` });
    expect(preview.el.querySelector('h1')).toBeNull();
    expect(preview.getRunTable()?.runs[0]?.subtype).toBe('paragraph');
  });
  it('keeps whitespace-edge strong semantics or declines the patch safely', () => {
    const source = 'original\n';
    const preview = createPreview(document.createElement('div'));
    preview.setDoc(source);
    preview.el.querySelector<HTMLElement>('[data-run-id="0"]')!.innerHTML = '<strong> x </strong>';
    const result = preview.commitSourcePatch(source, [0]);
    if (result.ok) {
      expect(result.markdown).toBe(' **x** \n');
      expect(preview.el.querySelector('strong')?.textContent).toBe('x');
      expect(preview.el.textContent).toBe(' x \n');
    } else {
      expect(result).toMatchObject({ markdown: source, reason: 'inline-shape-mismatch' });
    }
  });

  it('rejects all-space inline code instead of changing its text', () => {
    const source = 'original\n';
    const preview = createPreview(document.createElement('div'));
    preview.setDoc(source);
    preview.el.querySelector<HTMLElement>('[data-run-id="0"]')!.innerHTML = '<code> </code>';
    expect(preview.commitSourcePatch(source, [0])).toMatchObject({ ok: false, markdown: source });
  });

  it.each(['<strong>bold</strong>', '<em>em</em>', '<code>code</code>'])(
    'keeps normal inline journal markup %s',
    (html) => {
      const source = 'original\n';
      const preview = createPreview(document.createElement('div'));
      preview.setDoc(source);
      preview.el.querySelector<HTMLElement>('[data-run-id="0"]')!.innerHTML = html;
      expect(preview.commitSourcePatch(source, [0])).toMatchObject({ ok: true });
    },
  );

});
