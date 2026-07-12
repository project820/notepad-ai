// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { createPreview } from './preview';

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

});
