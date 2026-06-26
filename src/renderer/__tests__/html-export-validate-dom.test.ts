// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';

import { validateExportDom } from '../html-export-validate';

// validateExportDom is the structural allowlist pass (G006). These run under a
// real DOMParser (jsdom) — the same surface the wizard uses in the renderer.

describe('validateExportDom — accepts self-contained documents', () => {
  it('passes inline style/script/svg with data: and #fragment URLs', () => {
    const html =
      '<!doctype html><html><head><meta charset="utf-8">' +
      '<style>.x{background:url("data:image/png;base64,AAAA")}</style></head>' +
      '<body><a href="#section-1">jump</a>' +
      '<img src="data:image/png;base64,AAAA">' +
      '<svg><use xlink:href="#icon"></use></svg>' +
      '<script>document.title="ok"</script></body></html>';
    const v = validateExportDom(html);
    expect(v.violations).toEqual([]);
    expect(v.ok).toBe(true);
  });
  it('passes scheme-less relative paths', () => {
    expect(validateExportDom('<a href="page2.html">next</a>').ok).toBe(true);
  });
});

describe('validateExportDom — rejects injection / non-contained vectors', () => {
  it('rejects an on* event-handler attribute on any element', () => {
    const v = validateExportDom('<div onclick="steal()">x</div>');
    expect(v.ok).toBe(false);
    expect(v.violations.join(' ')).toContain('event-handler attribute onclick');
  });
  it('rejects forbidden embedding tags', () => {
    expect(validateExportDom('<iframe src="data:text/html,x"></iframe>').ok).toBe(false);
    expect(validateExportDom('<object data="x"></object>').ok).toBe(false);
    expect(validateExportDom('<base href="/">').ok).toBe(false);
  });
  it('rejects a javascript: URL in href', () => {
    const v = validateExportDom('<a href="javascript:alert(1)">x</a>');
    expect(v.ok).toBe(false);
    expect(v.violations.join(' ')).toContain('disallowed URL in href');
  });
  it('rejects remote http(s) and protocol-relative URLs', () => {
    expect(validateExportDom('<img src="https://cdn.example/x.png">').ok).toBe(false);
    expect(validateExportDom('<img src="//cdn.example/x.png">').ok).toBe(false);
  });
  it('rejects a remote url() inside an inline style attribute', () => {
    const v = validateExportDom('<div style="background:url(https://cdn.example/x.png)">y</div>');
    expect(v.ok).toBe(false);
    expect(v.violations.join(' ')).toContain('remote url() in inline style');
  });
  it('rejects a remote candidate in srcset', () => {
    expect(validateExportDom('<img srcset="https://cdn.example/x-2x.png 2x">').ok).toBe(false);
  });
  it('rejects a <meta http-equiv="refresh"> redirect', () => {
    const v = validateExportDom('<meta http-equiv="refresh" content="0;url=https://evil.example">');
    expect(v.ok).toBe(false);
    expect(v.violations.join(' ')).toContain('refresh');
  });
});
