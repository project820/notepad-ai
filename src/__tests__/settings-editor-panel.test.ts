/**
 * settings-editor-panel.test.ts
 *
 * Unit tests for the SettingsEditorPanel component
 * (`src/renderer/settings-editor-panel.ts`).
 *
 * Sub-AC 5.1 requirements:
 *   ✓ Component mounts with non-empty content — content appears in output.
 *   ✓ Component mounts with empty content — no crash; textarea field is empty.
 *   ✓ Both Save and Cancel buttons are present in the rendered output.
 *
 * Strategy:
 *   All tests target `renderSettingsEditorPanel` — the pure, DOM-free HTML
 *   generator function exported alongside the DOM-dependent mount function.
 *   This allows tests to run in the Node/vitest environment without jsdom,
 *   while still verifying the complete rendered markup (label, textarea,
 *   and both action buttons).
 *
 *   The mount function (`mountSettingsEditorPanel`) is not tested here
 *   because it requires a live DOM; its correctness follows from the render
 *   function being correct and the event-wiring being trivial.
 *
 * Test groups:
 *   A. Mounts with non-empty content — content appears in output
 *   B. Mounts with empty content    — no crash, field is empty
 *   C. Both buttons present         — Save and Cancel in rendered HTML
 *   D. Label is rendered            — label text appears above textarea
 *   E. HTML escaping                — special characters are safe
 *   F. Type / export surface        — correct TypeScript types exported
 *   G. Return type                  — function always returns a string
 *   H. Edge cases                   — undefined / whitespace / long content
 */

import { describe, it, expect } from 'vitest';
import {
  renderSettingsEditorPanel,
  type SettingsEditorPanelRenderOptions,
  type SettingsEditorPanelOptions,
  type SettingsEditorPanelHandle,
} from '../../src/renderer/settings-editor-panel';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Quickly build a minimal render options object. */
function opts(label: string, initialContent?: string): SettingsEditorPanelRenderOptions {
  return { label, initialContent };
}

// ---------------------------------------------------------------------------
// A. Mounts with non-empty content — content appears in output
// ---------------------------------------------------------------------------

describe('A. renderSettingsEditorPanel — non-empty content', () => {
  it('A01 — includes provided content in the rendered HTML', () => {
    const html = renderSettingsEditorPanel(opts('System Law', 'Be concise.'));
    expect(html).toContain('Be concise.');
  });

  it('A02 — multi-line content is preserved in output', () => {
    const content = 'Line one.\nLine two.\nLine three.';
    const html = renderSettingsEditorPanel(opts('Owner', content));
    expect(html).toContain('Line one.');
    expect(html).toContain('Line two.');
    expect(html).toContain('Line three.');
  });

  it('A03 — does not throw when content is non-empty', () => {
    expect(() =>
      renderSettingsEditorPanel(opts('Test', 'Some content here.')),
    ).not.toThrow();
  });

  it('A04 — textarea element is present with non-empty content', () => {
    const html = renderSettingsEditorPanel(opts('System Law', 'Hello world'));
    // The textarea element must be present in the HTML.
    expect(html).toMatch(/<textarea/i);
    expect(html).toContain('Hello world');
  });

  it('A05 — content from a markdown file (headings, lists) is included', () => {
    const mdContent = '## Rules\n\n- Be concise\n- Use Korean when asked';
    const html = renderSettingsEditorPanel(opts('System Law', mdContent));
    expect(html).toContain('## Rules');
    expect(html).toContain('- Be concise');
    expect(html).toContain('- Use Korean when asked');
  });
});

// ---------------------------------------------------------------------------
// B. Mounts with empty content — no crash, field is empty
// ---------------------------------------------------------------------------

describe('B. renderSettingsEditorPanel — empty content (no crash)', () => {
  it('B01 — does not throw with empty string content', () => {
    expect(() => renderSettingsEditorPanel(opts('System Law', ''))).not.toThrow();
  });

  it('B02 — returns a non-empty string even when content is empty', () => {
    const html = renderSettingsEditorPanel(opts('System Law', ''));
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(0);
  });

  it('B03 — textarea element is present when content is empty string', () => {
    const html = renderSettingsEditorPanel(opts('Owner', ''));
    expect(html).toMatch(/<textarea/i);
  });

  it('B04 — does not throw when initialContent is omitted (undefined)', () => {
    expect(() => renderSettingsEditorPanel({ label: 'Test' })).not.toThrow();
  });

  it('B05 — textarea content is empty when initialContent is omitted', () => {
    const html = renderSettingsEditorPanel({ label: 'Test' });
    // The textarea must exist and its inline content (between open and close tags)
    // should be empty (no content injected).
    // Pattern: <textarea ...></textarea>  with nothing inside.
    expect(html).toMatch(/<textarea[^>]*><\/textarea>/);
  });

  it('B06 — does not crash when label is empty string', () => {
    expect(() => renderSettingsEditorPanel(opts('', 'Some content'))).not.toThrow();
  });

  it('B07 — renders a valid HTML structure for empty content', () => {
    const html = renderSettingsEditorPanel(opts('Test', ''));
    // Must have the root div wrapper.
    expect(html).toMatch(/class="sep-root"/);
    // Must have the textarea.
    expect(html).toMatch(/class="sep-textarea"/);
    // Must have the actions container.
    expect(html).toMatch(/class="sep-actions"/);
  });
});

// ---------------------------------------------------------------------------
// C. Both buttons present in the rendered output
// ---------------------------------------------------------------------------

describe('C. renderSettingsEditorPanel — both buttons present', () => {
  it('C01 — Save button is present in rendered HTML', () => {
    const html = renderSettingsEditorPanel(opts('System Law', 'Content'));
    // Check for the save button class.
    expect(html).toMatch(/sep-btn-save/);
  });

  it('C02 — Cancel button is present in rendered HTML', () => {
    const html = renderSettingsEditorPanel(opts('System Law', 'Content'));
    // Check for the cancel button class.
    expect(html).toMatch(/sep-btn-cancel/);
  });

  it('C03 — Save button has a recognisable "Save" label', () => {
    const html = renderSettingsEditorPanel(opts('Test', ''));
    // The word "Save" should appear (case-insensitive) in the button markup.
    expect(html).toMatch(/save/i);
  });

  it('C04 — Cancel button has a recognisable "Cancel" label', () => {
    const html = renderSettingsEditorPanel(opts('Test', ''));
    expect(html).toMatch(/cancel/i);
  });

  it('C05 — Save button has data-sep-action="save" attribute', () => {
    const html = renderSettingsEditorPanel(opts('Test', ''));
    expect(html).toContain('data-sep-action="save"');
  });

  it('C06 — Cancel button has data-sep-action="cancel" attribute', () => {
    const html = renderSettingsEditorPanel(opts('Test', ''));
    expect(html).toContain('data-sep-action="cancel"');
  });

  it('C07 — both buttons are present simultaneously in one render', () => {
    const html = renderSettingsEditorPanel(opts('Test', 'hello'));
    const hasSave   = /sep-btn-save/.test(html);
    const hasCancel = /sep-btn-cancel/.test(html);
    expect(hasSave).toBe(true);
    expect(hasCancel).toBe(true);
  });

  it('C08 — buttons are <button> elements with type="button"', () => {
    const html = renderSettingsEditorPanel(opts('Test', ''));
    // Both buttons should have type="button" to avoid accidental form submit.
    const matches = html.match(/<button[^>]+type="button"/g);
    // At least 2 buttons with type="button".
    expect(matches).not.toBeNull();
    expect((matches ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('C09 — both buttons remain present even with empty content', () => {
    const html = renderSettingsEditorPanel(opts('Test', ''));
    expect(html).toMatch(/sep-btn-save/);
    expect(html).toMatch(/sep-btn-cancel/);
  });

  it('C10 — buttons are wrapped inside the sep-actions container', () => {
    const html = renderSettingsEditorPanel(opts('Test', 'hello'));
    // The actions div must come before / contain the button markup.
    const actionsIdx = html.indexOf('sep-actions');
    const saveIdx    = html.indexOf('sep-btn-save');
    const cancelIdx  = html.indexOf('sep-btn-cancel');
    expect(actionsIdx).toBeGreaterThanOrEqual(0);
    expect(saveIdx).toBeGreaterThan(actionsIdx);
    expect(cancelIdx).toBeGreaterThan(actionsIdx);
  });
});

// ---------------------------------------------------------------------------
// D. Label is rendered
// ---------------------------------------------------------------------------

describe('D. renderSettingsEditorPanel — label rendering', () => {
  it('D01 — label text appears in rendered HTML', () => {
    const html = renderSettingsEditorPanel(opts('System Law', ''));
    expect(html).toContain('System Law');
  });

  it('D02 — label element uses a <label> tag', () => {
    const html = renderSettingsEditorPanel(opts('My Label', ''));
    expect(html).toMatch(/<label/i);
    expect(html).toContain('My Label');
  });

  it('D03 — label has sep-label class', () => {
    const html = renderSettingsEditorPanel(opts('Owner', ''));
    expect(html).toMatch(/class="sep-label"/);
  });

  it('D04 — label for attribute matches textarea id', () => {
    const html = renderSettingsEditorPanel(opts('Test', ''));
    // label for="sep-textarea" and textarea id="sep-textarea"
    expect(html).toContain('for="sep-textarea"');
    expect(html).toContain('id="sep-textarea"');
  });

  it('D05 — different labels produce distinct output', () => {
    const htmlA = renderSettingsEditorPanel(opts('System Law', ''));
    const htmlB = renderSettingsEditorPanel(opts('Owner', ''));
    expect(htmlA).not.toBe(htmlB);
    expect(htmlA).toContain('System Law');
    expect(htmlB).toContain('Owner');
  });
});

// ---------------------------------------------------------------------------
// E. HTML escaping — special characters are safe
// ---------------------------------------------------------------------------

describe('E. renderSettingsEditorPanel — HTML escaping', () => {
  it('E01 — ampersand in content is escaped', () => {
    const html = renderSettingsEditorPanel(opts('Test', 'Fish & Chips'));
    expect(html).toContain('Fish &amp; Chips');
    // Raw unescaped form must NOT appear as an HTML entity issue.
    expect(html).not.toMatch(/Fish & Chips(?!.*&amp;)/);
  });

  it('E02 — < and > in content are escaped', () => {
    const html = renderSettingsEditorPanel(opts('Test', '<script>alert(1)</script>'));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('E03 — double-quote in label is escaped', () => {
    const html = renderSettingsEditorPanel(opts('Say "hello"', ''));
    // The label text rendered inside the <label> element should be escaped.
    expect(html).toContain('Say &quot;hello&quot;');
  });

  it('E04 — does not crash on content containing only special characters', () => {
    expect(() =>
      renderSettingsEditorPanel(opts('Test', '<>&"\'')),
    ).not.toThrow();
  });

  it('E05 — content with apostrophe is escaped', () => {
    const html = renderSettingsEditorPanel(opts('Test', "It's fine."));
    expect(html).toContain('It&#39;s fine.');
  });
});

// ---------------------------------------------------------------------------
// F. Type / export surface
// ---------------------------------------------------------------------------

describe('F. Type and export surface', () => {
  it('F01 — renderSettingsEditorPanel is a function', () => {
    expect(typeof renderSettingsEditorPanel).toBe('function');
  });

  it('F02 — SettingsEditorPanelRenderOptions accepts label + initialContent', () => {
    const o: SettingsEditorPanelRenderOptions = { label: 'Test', initialContent: 'hello' };
    expect(o.label).toBe('Test');
    expect(o.initialContent).toBe('hello');
  });

  it('F03 — SettingsEditorPanelRenderOptions accepts label-only (initialContent optional)', () => {
    const o: SettingsEditorPanelRenderOptions = { label: 'Owner' };
    expect(o.label).toBe('Owner');
    expect(o.initialContent).toBeUndefined();
  });

  it('F04 — SettingsEditorPanelOptions extends with onSave and onCancel callbacks', () => {
    const o: SettingsEditorPanelOptions = {
      label: 'Test',
      onSave:   (_content: string) => {},
      onCancel: () => {},
    };
    expect(typeof o.onSave).toBe('function');
    expect(typeof o.onCancel).toBe('function');
  });

  it('F05 — SettingsEditorPanelHandle has getContent and destroy', () => {
    const handle: SettingsEditorPanelHandle = {
      getContent: () => 'hello',
      destroy: () => {},
    };
    expect(typeof handle.getContent).toBe('function');
    expect(typeof handle.destroy).toBe('function');
    expect(handle.getContent()).toBe('hello');
  });
});

// ---------------------------------------------------------------------------
// G. Return type — function always returns a string
// ---------------------------------------------------------------------------

describe('G. renderSettingsEditorPanel — return type', () => {
  it('G01 — always returns a string', () => {
    const html = renderSettingsEditorPanel(opts('Test', 'content'));
    expect(typeof html).toBe('string');
  });

  it('G02 — returns a string for empty options', () => {
    const html = renderSettingsEditorPanel({ label: '' });
    expect(typeof html).toBe('string');
  });

  it('G03 — returned string contains the sep-root wrapper', () => {
    const html = renderSettingsEditorPanel(opts('Test', ''));
    expect(html).toContain('sep-root');
  });

  it('G04 — returned string is deterministic for the same input', () => {
    const a = renderSettingsEditorPanel(opts('Label', 'Content'));
    const b = renderSettingsEditorPanel(opts('Label', 'Content'));
    expect(a).toBe(b);
  });

  it('G05 — different inputs produce different outputs', () => {
    const a = renderSettingsEditorPanel(opts('Label A', 'Content A'));
    const b = renderSettingsEditorPanel(opts('Label B', 'Content B'));
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// H. Edge cases
// ---------------------------------------------------------------------------

describe('H. renderSettingsEditorPanel — edge cases', () => {
  it('H01 — very long content does not crash', () => {
    const longContent = 'x'.repeat(50_000);
    expect(() => renderSettingsEditorPanel(opts('Test', longContent))).not.toThrow();
    const html = renderSettingsEditorPanel(opts('Test', longContent));
    expect(html).toContain('x'.repeat(10));
  });

  it('H02 — whitespace-only content is not trimmed (preserved as-is)', () => {
    const content = '   \n   \n   ';
    const html = renderSettingsEditorPanel(opts('Test', content));
    // Whitespace content should appear in the textarea (escaped).
    expect(html).toContain('   ');
  });

  it('H03 — unicode / emoji in content does not crash', () => {
    const content = '안녕하세요 🎉 ñoño';
    expect(() => renderSettingsEditorPanel(opts('Test', content))).not.toThrow();
    const html = renderSettingsEditorPanel(opts('Test', content));
    expect(html).toContain('안녕하세요');
    expect(html).toContain('🎉');
  });

  it('H04 — Korean label text is preserved unchanged', () => {
    const html = renderSettingsEditorPanel(opts('시스템 법칙', ''));
    expect(html).toContain('시스템 법칙');
  });

  it('H05 — render is called multiple times without side-effects', () => {
    // Pure function — calling it twice with same args should give same result
    // and calling with different args should not pollute each other.
    const html1 = renderSettingsEditorPanel(opts('A', 'First call'));
    const html2 = renderSettingsEditorPanel(opts('B', 'Second call'));
    const html3 = renderSettingsEditorPanel(opts('A', 'First call'));
    expect(html1).toBe(html3);
    expect(html1).not.toBe(html2);
  });
});
