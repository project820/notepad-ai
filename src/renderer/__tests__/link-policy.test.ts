/**
 * link-policy.test.ts — fail-closed link classification (Phase 0).
 *
 * Asserts the classifier denies the navigation primitives the insane-review
 * flagged (leading-space https, javascript:, data:, file:, relative,
 * protocol-relative, malformed) and allows only normalized http/https + fragment.
 * Phase 1 wires preview-links + a document capture listener onto this policy.
 */

import { describe, it, expect } from 'vitest';
import { classifyLinkHref } from '../link-policy';

describe('classifyLinkHref — fail-closed link policy', () => {
  it('allows http/https as external (normalized)', () => {
    expect(classifyLinkHref('https://example.com/a')).toEqual({
      action: 'external',
      url: 'https://example.com/a',
    });
    expect(classifyLinkHref('http://example.com')).toEqual({
      action: 'external',
      url: 'http://example.com/',
    });
  });

  it('normalizes a leading-space https href instead of failing open', () => {
    // The old regex `^https?:` missed this and let the browser navigate natively.
    expect(classifyLinkHref(' https://attacker.example')).toEqual({
      action: 'external',
      url: 'https://attacker.example/',
    });
  });

  it('treats a non-empty #fragment as an internal jump', () => {
    expect(classifyLinkHref('#section-2')).toEqual({ action: 'fragment', fragment: 'section-2' });
  });

  it('denies a bare #', () => {
    expect(classifyLinkHref('#')).toEqual({ action: 'deny' });
  });

  it('denies dangerous and non-web schemes', () => {
    for (const href of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<script>1</script>',
      'file:///etc/passwd',
      'vbscript:msgbox',
      'about:blank',
    ]) {
      expect(classifyLinkHref(href)).toEqual({ action: 'deny' });
    }
  });

  it('denies relative and protocol-relative refs (no trusted base)', () => {
    expect(classifyLinkHref('../secret')).toEqual({ action: 'deny' });
    expect(classifyLinkHref('//evil.example')).toEqual({ action: 'deny' });
    expect(classifyLinkHref('foo/bar')).toEqual({ action: 'deny' });
  });

  it('denies empty, whitespace, and non-string input', () => {
    expect(classifyLinkHref('')).toEqual({ action: 'deny' });
    expect(classifyLinkHref('   ')).toEqual({ action: 'deny' });
    expect(classifyLinkHref(null)).toEqual({ action: 'deny' });
    expect(classifyLinkHref(undefined)).toEqual({ action: 'deny' });
    expect(classifyLinkHref(42)).toEqual({ action: 'deny' });
  });

  it('resolves relative refs only against an explicit trusted base', () => {
    expect(classifyLinkHref('page#x', 'https://app.local/doc')).toEqual({
      action: 'external',
      url: 'https://app.local/page#x',
    });
  });
});
