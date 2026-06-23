import { describe, it, expect } from 'vitest';
import { validateSelfContainedHtml, layoutDiagnostics } from '../renderer/html-export-validate';

// A fully inline, offline-safe document: inline <style>, inline manifest JSON,
// inline <svg>, inline <script> with no remote calls.
const CLEAN =
  '<!doctype html><html><head>' +
  '<meta charset="utf-8">' +
  '<style>:root{--he-bg:#fff}.slide{display:none}.slide.active{display:flex}</style>' +
  '<script type="application/json" id="he-manifest">{"schemaVersion":1,"layout":"slides"}</script>' +
  '</head><body>' +
  '<svg viewBox="0 0 10 10"><rect x="0" y="0" width="5" height="5"></rect></svg>' +
  '<img src="data:image/png;base64,AAAA">' +
  '<script>(function(){var s=document.querySelector(".slide");if(s)s.classList.add("active");})();</script>' +
  '</body></html>';

describe('validateSelfContainedHtml — clean inline document', () => {
  it('passes a fully inline, offline-safe document (incl. inline data URI)', () => {
    const v = validateSelfContainedHtml(CLEAN);
    expect(v.ok).toBe(true);
    expect(v.violations).toEqual([]);
  });
});

describe('validateSelfContainedHtml — legacy remote vectors still fail', () => {
  it('flags remote script / link / img / @import / web-font url()', () => {
    expect(validateSelfContainedHtml('<script src="https://cdn.example/x.js"></script>').ok).toBe(false);
    expect(validateSelfContainedHtml('<link rel="stylesheet" href="//cdn.example/x.css">').ok).toBe(false);
    expect(validateSelfContainedHtml('<img src="https://cdn.example/x.png">').ok).toBe(false);
    expect(validateSelfContainedHtml('<style>@import url(https://fonts.example/f.css)</style>').ok).toBe(false);
    expect(validateSelfContainedHtml('<style>@font-face{src:url("https://fonts.gstatic.com/a.woff2")}</style>').ok).toBe(
      false,
    );
  });
});

describe('validateSelfContainedHtml — strengthened vectors (G004)', () => {
  // Each entry must produce ok:false. The label is matched against violations.
  const cases: Array<{ name: string; html: string; needle: string }> = [
    { name: 'remote srcset', html: '<img srcset="https://cdn.example/x-2x.png 2x">', needle: 'srcset' },
    { name: 'protocol-relative srcset', html: '<source srcset="//cdn.example/x.webp">', needle: 'srcset' },
    { name: 'remote poster', html: '<video poster="https://cdn.example/p.jpg"></video>', needle: 'poster' },
    { name: 'iframe', html: '<iframe src="about:blank"></iframe>', needle: 'iframe' },
    { name: 'object', html: '<object data="thing.swf"></object>', needle: 'object' },
    { name: 'embed', html: '<embed src="thing.swf">', needle: 'embed' },
    {
      name: 'remote <use href>',
      html: '<svg><use href="https://cdn.example/sprite.svg#icon"></use></svg>',
      needle: 'use',
    },
    {
      name: 'remote <use xlink:href>',
      html: '<svg><use xlink:href="//cdn.example/sprite.svg#icon"></use></svg>',
      needle: 'use',
    },
    {
      name: 'CSS image-set()',
      html: '<style>.x{background:image-set("https://cdn.example/a.png" 1x)}</style>',
      needle: 'image-set',
    },
    { name: 'inline remote fetch()', html: '<script>fetch("https://api.example/data")</script>', needle: 'fetch' },
    {
      name: 'inline remote XMLHttpRequest',
      html: '<script>var r=new XMLHttpRequest();r.open("GET","https://api.example/data");</script>',
      needle: 'XMLHttpRequest',
    },
  ];

  for (const c of cases) {
    it(`fails: ${c.name}`, () => {
      const v = validateSelfContainedHtml(c.html);
      expect(v.ok).toBe(false);
      expect(v.violations.join(' ')).toContain(c.needle);
    });
  }
});

describe('validateSelfContainedHtml — defensive input', () => {
  it('treats a non-string as empty (passes, no throw)', () => {
    // @ts-expect-error — intentional bad input
    expect(validateSelfContainedHtml(null).ok).toBe(true);
  });
});

describe('layoutDiagnostics — pure containment invariants', () => {
  it('describes slide-deck containment invariants', () => {
    const d = layoutDiagnostics({ layout: 'slides', orientation: 'horizontal' });
    expect(d.layout).toBe('slides');
    expect(d.orientation).toBe('horizontal');
    const ids = d.invariants.map((i) => i.id);
    expect(ids).toContain('no-page-scroll');
    expect(ids).toContain('single-active-slide');
    expect(ids).toContain('slide-fits-viewport');
  });

  it('describes scroll containment invariants and defaults orientation to null', () => {
    const d = layoutDiagnostics({ layout: 'scroll' });
    expect(d.layout).toBe('scroll');
    expect(d.orientation).toBeNull();
    const ids = d.invariants.map((i) => i.id);
    expect(ids).toContain('vertical-only');
    expect(ids).toContain('readable-width');
  });
});
