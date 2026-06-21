import { describe, it, expect } from 'vitest';
import {
  isAllowedDesignFetchUrl,
  isAllowedDesignListFetchUrl,
  isAllowedDesignIconUrl,
  designListContentsUrl,
  parseDesignListFromContents,
  getdesignPageUrl,
  titleizeDesignSlug,
  pngBytesToDataUri,
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

describe('design index list (G005 AC11)', () => {
  it('builds the canonical Contents API URL and accepts only it', () => {
    const url = designListContentsUrl();
    expect(url).toBe(
      'https://api.github.com/repos/VoltAgent/awesome-design-md/contents/design-md?ref=main',
    );
    expect(isAllowedDesignListFetchUrl(url)).toBe(true);
  });

  it('rejects any other list URL (host, repo, ref, path tampering)', () => {
    expect(isAllowedDesignListFetchUrl('https://api.github.com/repos/evil/repo/contents/design-md?ref=main')).toBe(false);
    expect(isAllowedDesignListFetchUrl('https://api.github.com/repos/VoltAgent/awesome-design-md/contents/design-md?ref=dev')).toBe(false);
    expect(isAllowedDesignListFetchUrl('https://api.github.com/repos/VoltAgent/awesome-design-md/contents/other?ref=main')).toBe(false);
    expect(isAllowedDesignListFetchUrl('http://api.github.com/repos/VoltAgent/awesome-design-md/contents/design-md?ref=main')).toBe(false);
    expect(isAllowedDesignListFetchUrl('https://api.github.com/repos/VoltAgent/awesome-design-md/contents/design-md')).toBe(false);
  });

  it('parses Contents API dirs into sorted, de-duped design entries', () => {
    const json = [
      { name: 'together-ai', type: 'dir' },
      { name: 'claude', type: 'dir' },
      { name: 'README.md', type: 'file' },
      { name: '../evil', type: 'dir' },
      { name: 'claude', type: 'dir' }, // dup
      { name: 'x'.repeat(200), type: 'dir' }, // too long
      'garbage',
    ];
    const out = parseDesignListFromContents(json);
    expect(out.map((d) => d.slug)).toEqual(['claude', 'together-ai']);
    expect(out[0]).toEqual({ slug: 'claude', name: 'Claude', pageUrl: 'https://getdesign.md/claude' });
    expect(out[1].name).toBe('Together Ai');
  });

  it('returns [] for non-array / malformed input', () => {
    expect(parseDesignListFromContents(null)).toEqual([]);
    expect(parseDesignListFromContents({ message: 'rate limited' })).toEqual([]);
  });

  it('titleizes slugs and builds getdesign page URLs', () => {
    expect(titleizeDesignSlug('eleven-labs')).toBe('Eleven Labs');
    expect(getdesignPageUrl('replicate')).toBe('https://getdesign.md/replicate');
    expect(getdesignPageUrl('../evil')).toBeNull();
  });
});

describe('design icon allowlist + PNG validation (G005 AC11/E2)', () => {
  it('allows only GitHub avatar PNGs with a bounded size query', () => {
    expect(isAllowedDesignIconUrl('https://avatars.githubusercontent.com/u/123?s=64')).toBe(true);
    expect(isAllowedDesignIconUrl('https://avatars.githubusercontent.com/u/123')).toBe(true);
    expect(isAllowedDesignIconUrl('https://avatars.githubusercontent.com/u/123?s=9999')).toBe(false);
    expect(isAllowedDesignIconUrl('https://evil.example/u/123.png?s=64')).toBe(false);
    expect(isAllowedDesignIconUrl('http://avatars.githubusercontent.com/u/123')).toBe(false);
    expect(isAllowedDesignIconUrl('https://avatars.githubusercontent.com/u/1?token=abc')).toBe(false);
  });

  it('converts valid PNG bytes to a data URI and rejects non-PNG / oversized', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    const uri = pngBytesToDataUri(png);
    expect(uri).toMatch(/^data:image\/png;base64,/);
    expect(pngBytesToDataUri(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBeNull(); // GIF magic
    expect(pngBytesToDataUri(new Uint8Array(0))).toBeNull();
    expect(pngBytesToDataUri(new Uint8Array(64 * 1024 + 1))).toBeNull(); // oversized
  });
});
