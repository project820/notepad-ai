// @vitest-environment happy-dom
/**
 * renderer-security.dom.test.ts — restore-banner DOM-injection regression (Phase 0).
 *
 * The old showRestoreBanner interpolated document content into innerHTML, so a
 * crafted document could create a clickable full-window overlay anchor. The
 * textContent builder must render that payload as inert text only.
 */

import { describe, it, expect } from 'vitest';
import { buildRestoreBanner } from '../restore-banner';

const labels = { title: '복구', yes: '예', no: '아니오' };

describe('buildRestoreBanner — no active DOM from document content', () => {
  it('renders a malicious document preview as inert text (no anchor/form/script)', () => {
    const malicious =
      '<a href=" https://attacker.example" style="position:fixed;inset:0">click</a><form action="https://attacker"></form>';
    const el = buildRestoreBanner({ doc: malicious, savedAt: 0 }, labels);

    expect(el.querySelectorAll('a, form, script, style, img, iframe, button.restore-yes ~ a').length).toBe(0);
    // The only buttons are the two app controls.
    const buttons = el.querySelectorAll('button');
    expect(buttons.length).toBe(2);
    expect(el.querySelector('.restore-yes')?.textContent).toBe('예');
    expect(el.querySelector('.restore-no')?.textContent).toBe('아니오');
    // The payload survives only as text inside the preview span.
    const span = el.querySelector('.restore-banner-text span');
    expect(span?.textContent).toContain('<a href=');
  });

  it('shows (empty) for an empty document and the localized title', () => {
    const el = buildRestoreBanner({ doc: '', savedAt: undefined }, labels);
    expect(el.querySelector('strong')?.textContent).toBe('복구');
    expect(el.querySelector('.restore-banner-text span')?.textContent).toBe('(empty)');
  });

  it('truncates the preview to 80 source chars', () => {
    const long = 'x'.repeat(500);
    const el = buildRestoreBanner({ doc: long, savedAt: 0 }, labels);
    const span = el.querySelector('.restore-banner-text span');
    // 80 doc chars + " · <date>" suffix; the doc-derived portion never exceeds 80.
    const docPortion = (span?.textContent ?? '').split(' · ')[0];
    expect(docPortion.length).toBeLessThanOrEqual(80);
  });
});
