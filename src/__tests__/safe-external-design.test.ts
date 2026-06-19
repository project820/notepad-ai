import { describe, it, expect } from 'vitest';
import {
  isAllowedDesignFetchUrl,
  isOpenableSavedPath,
  normalizeDesignMdUrl,
} from '../main/safe-external';

const CANON = 'https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/design-md/replicate/DESIGN.md';

describe('normalizeDesignMdUrl (⑤ design-source allowlist)', () => {
  it('normalizes a bare slug to the canonical raw URL', () => {
    expect(normalizeDesignMdUrl('replicate')).toBe(CANON);
    expect(normalizeDesignMdUrl('  replicate  ')).toBe(CANON);
    expect(normalizeDesignMdUrl('vercel')).toBe(
      'https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/design-md/vercel/DESIGN.md',
    );
  });

  it('normalizes getdesign.md page URLs', () => {
    expect(normalizeDesignMdUrl('https://getdesign.md/replicate')).toBe(CANON);
    expect(normalizeDesignMdUrl('https://getdesign.md/replicate/design-md')).toBe(CANON);
    expect(normalizeDesignMdUrl('https://www.getdesign.md/replicate')).toBe(CANON);
  });

  it('accepts the canonical raw URL and a matching GitHub blob URL', () => {
    expect(normalizeDesignMdUrl(CANON)).toBe(CANON);
    expect(
      normalizeDesignMdUrl(
        'https://github.com/VoltAgent/awesome-design-md/blob/main/design-md/replicate/DESIGN.md',
      ),
    ).toBe(CANON);
  });

  it('matches owner/repo case-insensitively but emits the canonical casing', () => {
    expect(
      normalizeDesignMdUrl(
        'https://raw.githubusercontent.com/voltagent/AWESOME-DESIGN-MD/main/design-md/replicate/DESIGN.md',
      ),
    ).toBe(CANON);
  });

  it('rejects non-https schemes', () => {
    expect(normalizeDesignMdUrl('http://getdesign.md/replicate')).toBeNull();
    expect(normalizeDesignMdUrl('file:///etc/passwd')).toBeNull();
    expect(normalizeDesignMdUrl('javascript:alert(1)')).toBeNull();
  });

  it('rejects other owners and repositories', () => {
    expect(
      normalizeDesignMdUrl('https://raw.githubusercontent.com/evil/awesome-design-md/main/design-md/x/DESIGN.md'),
    ).toBeNull();
    expect(
      normalizeDesignMdUrl('https://raw.githubusercontent.com/VoltAgent/evil-repo/main/design-md/x/DESIGN.md'),
    ).toBeNull();
  });

  it('rejects raw paths that do not end in DESIGN.md or use a non-main branch', () => {
    expect(
      normalizeDesignMdUrl('https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/design-md/x/README.md'),
    ).toBeNull();
    expect(
      normalizeDesignMdUrl('https://raw.githubusercontent.com/VoltAgent/awesome-design-md/dev/design-md/x/DESIGN.md'),
    ).toBeNull();
    expect(
      normalizeDesignMdUrl('https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/x/DESIGN.md'),
    ).toBeNull();
  });

  it('rejects traversal slugs and arbitrary getdesign paths', () => {
    expect(normalizeDesignMdUrl('https://getdesign.md/foo.bar')).toBeNull(); // dotted slug rejected
    expect(normalizeDesignMdUrl('https://getdesign.md/replicate/admin')).toBeNull();
    expect(normalizeDesignMdUrl('https://getdesign.md/replicate/design-md/extra')).toBeNull();
    expect(normalizeDesignMdUrl('..')).toBeNull();
    expect(normalizeDesignMdUrl('foo/bar')).toBeNull();
    expect(normalizeDesignMdUrl('-bad')).toBeNull();
  });

  it('rejects empty, oversized, and non-string input', () => {
    expect(normalizeDesignMdUrl('')).toBeNull();
    expect(normalizeDesignMdUrl('   ')).toBeNull();
    expect(normalizeDesignMdUrl('a'.repeat(3000))).toBeNull();
    expect(normalizeDesignMdUrl(null as unknown as string)).toBeNull();
    expect(normalizeDesignMdUrl(42 as unknown as string)).toBeNull();
  });
});

describe('isAllowedDesignFetchUrl (final fetch gate)', () => {
  it('allows only the exact canonical raw URL', () => {
    expect(isAllowedDesignFetchUrl(CANON)).toBe(true);
    // every normalize() output passes the gate
    expect(isAllowedDesignFetchUrl(normalizeDesignMdUrl('replicate')!)).toBe(true);
  });

  it('rejects anything that is not the canonical raw shape', () => {
    expect(isAllowedDesignFetchUrl('https://getdesign.md/replicate')).toBe(false);
    expect(isAllowedDesignFetchUrl('http://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/design-md/x/DESIGN.md')).toBe(false);
    expect(isAllowedDesignFetchUrl(`${CANON}?token=secret`)).toBe(false);
    expect(isAllowedDesignFetchUrl(`${CANON}#frag`)).toBe(false);
    expect(isAllowedDesignFetchUrl('https://raw.githubusercontent.com/evil/awesome-design-md/main/design-md/x/DESIGN.md')).toBe(false);
    expect(isAllowedDesignFetchUrl('')).toBe(false);
    expect(isAllowedDesignFetchUrl(null as unknown as string)).toBe(false);
  });
});

describe('isOpenableSavedPath (html:open-saved gate)', () => {
  it('accepts local .html and .htm paths', () => {
    expect(isOpenableSavedPath('/Users/me/report.html')).toBe(true);
    expect(isOpenableSavedPath('/Users/me/report.htm')).toBe(true);
    expect(isOpenableSavedPath('/Users/me/My Report.HTML')).toBe(true);
  });

  it('rejects URL strings, file: URLs, and non-html extensions', () => {
    expect(isOpenableSavedPath('https://evil.com/x.html')).toBe(false);
    expect(isOpenableSavedPath('file:///Users/me/report.html')).toBe(false);
    expect(isOpenableSavedPath('/Users/me/report.md')).toBe(false);
    expect(isOpenableSavedPath('/Users/me/report')).toBe(false);
    expect(isOpenableSavedPath('javascript:alert(1)')).toBe(false);
  });

  it('rejects empty, control-char, and non-string input', () => {
    expect(isOpenableSavedPath('')).toBe(false);
    expect(isOpenableSavedPath('   ')).toBe(false);
    expect(isOpenableSavedPath('/Users/me/re\nport.html')).toBe(false);
    expect(isOpenableSavedPath(null as unknown as string)).toBe(false);
    expect(isOpenableSavedPath(123 as unknown as string)).toBe(false);
  });
});
