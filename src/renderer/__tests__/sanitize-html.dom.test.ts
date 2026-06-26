// @vitest-environment jsdom
/**
 * sanitize-html.dom.test.ts — converted-document HTML sanitizer (Phase 1).
 *
 * Proves the strict DOMPurify policy strips every navigation/resource/active
 * vector from attacker-influenceable converted HTML before it reaches the
 * privileged preview DOM.
 */

import { describe, it, expect } from 'vitest';
import { sanitizeConvertedHtml, buildConvertedHtmlFrame } from '../sanitize-html';

function host(frag: DocumentFragment): HTMLElement {
  const el = document.createElement('div');
  el.appendChild(frag);
  return el;
}

describe('sanitizeConvertedHtml — strict converted-HTML policy', () => {
  it('removes forbidden tags (script/style/form/base/object/iframe/embed/svg/math)', () => {
    const el = host(
      sanitizeConvertedHtml(
        '<p>ok</p><script>evil()</script><style>*{}</style><form action="x"></form>' +
          '<base href="https://e"><object data="x"></object><iframe src="x"></iframe>' +
          '<embed src="x"><svg onload="x"></svg><math></math>',
      ),
    );
    for (const tag of ['script', 'style', 'form', 'base', 'object', 'iframe', 'embed', 'svg', 'math']) {
      expect(el.querySelector(tag), tag).toBeNull();
    }
    expect(el.textContent).toContain('ok');
  });

  it('strips every URL-bearing attribute so nothing can navigate or load', () => {
    const el = host(
      sanitizeConvertedHtml(
        '<a href="https://attacker.example">x</a><img src="https://attacker/p.png">' +
          '<div background="https://attacker/bg"></div>',
      ),
    );
    expect(el.querySelector('a')?.getAttribute('href')).toBeNull();
    expect(el.querySelector('img')?.getAttribute('src')).toBeNull();
    expect(el.querySelector('div')?.getAttribute('background')).toBeNull();
  });

  it('strips event handlers and srcdoc', () => {
    const el = host(
      sanitizeConvertedHtml('<p onclick="evil()" onmouseover="evil()">x</p><div srcdoc="<b>"></div>'),
    );
    const p = el.querySelector('p');
    expect(p?.getAttribute('onclick')).toBeNull();
    expect(p?.getAttribute('onmouseover')).toBeNull();
    expect(el.querySelector('div')?.getAttribute('srcdoc')).toBeNull();
  });

  it('keeps inert structural/formatting markup and text', () => {
    const el = host(sanitizeConvertedHtml('<h1>Title</h1><p><strong>bold</strong> and <em>it</em></p><ul><li>a</li></ul>'));
    expect(el.querySelector('h1')?.textContent).toBe('Title');
    expect(el.querySelector('strong')?.textContent).toBe('bold');
    expect(el.querySelector('li')?.textContent).toBe('a');
  });

  it('returns a DocumentFragment (caller inserts via replaceChildren, never innerHTML)', () => {
    const frag = sanitizeConvertedHtml('<p>x</p>');
    expect(frag).toBeInstanceOf(DocumentFragment);
  });
});

describe('buildConvertedHtmlFrame — isolated sandbox rendering (G006)', () => {
  it('renders into a script-free, opaque-origin sandboxed <iframe>', () => {
    const frame = buildConvertedHtmlFrame('<p>hello</p>');
    expect(frame.tagName).toBe('IFRAME');
    // sandbox token is empty: NO allow-scripts, NO allow-same-origin.
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
  });
  it('embeds an inert CSP and the sanitized body via srcdoc (not parent DOM)', () => {
    const frame = buildConvertedHtmlFrame('<p>hi</p>');
    expect(frame.srcdoc).toContain('Content-Security-Policy');
    expect(frame.srcdoc).toContain("default-src 'none'");
    expect(frame.srcdoc).toContain('<p>hi</p>');
  });
  it('strips script/handlers before they ever reach the frame srcdoc', () => {
    const frame = buildConvertedHtmlFrame(
      '<p onclick="steal()">x</p><script>evil()</script><img src="https://cdn/x.png">',
    );
    expect(frame.srcdoc).not.toContain('<script');
    expect(frame.srcdoc).not.toContain('onclick');
    expect(frame.srcdoc).not.toContain('https://cdn');
  });
});
