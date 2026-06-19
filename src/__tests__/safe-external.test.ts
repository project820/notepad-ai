import { describe, it, expect } from 'vitest';
import { isAllowedExternalUrl } from '../main/safe-external';

describe('isAllowedExternalUrl (S3 external URL allowlist)', () => {
  it('allows http, https, and mailto', () => {
    expect(isAllowedExternalUrl('https://example.com')).toBe(true);
    expect(isAllowedExternalUrl('http://example.com/path?q=1')).toBe(true);
    expect(isAllowedExternalUrl('mailto:user@example.com')).toBe(true);
  });

  it('denies dangerous and non-web schemes', () => {
    expect(isAllowedExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedExternalUrl('vscode://x')).toBe(false);
    expect(isAllowedExternalUrl('data:text/html,<script>')).toBe(false);
  });

  it('denies empty, whitespace, malformed, and non-string input', () => {
    expect(isAllowedExternalUrl('')).toBe(false);
    expect(isAllowedExternalUrl('   ')).toBe(false);
    expect(isAllowedExternalUrl('not a url')).toBe(false);
    expect(isAllowedExternalUrl(null as unknown as string)).toBe(false);
    expect(isAllowedExternalUrl(undefined as unknown as string)).toBe(false);
    expect(isAllowedExternalUrl(42 as unknown as string)).toBe(false);
  });

  it('trims surrounding whitespace before validating', () => {
    expect(isAllowedExternalUrl('  https://example.com  ')).toBe(true);
  });
});
