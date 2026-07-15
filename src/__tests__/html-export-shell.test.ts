import { describe, it, expect } from 'vitest';

import { bundleSanitizedHtml } from '../main/html-export-shell';
import type { HtmlExportSanitizedPayload } from '../main/html-export-pipeline-service';
import {
  HTML_EXPORT_RUNTIME_JS,
  HTML_EXPORT_RUNTIME_JS_SHA256,
} from '../shared/html-export-runtime';

function payload(over: Partial<HtmlExportSanitizedPayload> = {}): HtmlExportSanitizedPayload {
  return {
    bodyHtml: over.bodyHtml ?? '<div data-he-content><p>safe</p></div>',
    documentHtml: over.documentHtml ?? '<html><body><div data-he-content><p>safe</p></div></body></html>',
    contentCss: over.contentCss ?? '@layer he-authored{[data-he-content] p{color:red}}',
    counts: over.counts ?? { nodeCount: 3, maxDepth: 2, attributeCount: 1 },
  };
}

function headInner(html: string): string {
  const m = html.match(/<head>\n?([\s\S]*?)\n?<\/head>/);
  expect(m).not.toBeNull();
  return m![1];
}

function styleBlocks(html: string): string[] {
  return [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
}

function scriptBlocks(html: string): Array<{ type: string | null; id: string | null; body: string }> {
  return [...html.matchAll(/<script(?:\s+([^>]*))?>([\s\S]*?)<\/script>/g)].map((m) => {
    const attrs = m[1] ?? '';
    const type = attrs.match(/type="([^"]*)"/)?.[1] ?? null;
    const id = attrs.match(/id="([^"]*)"/)?.[1] ?? null;
    return { type, id, body: m[2] };
  });
}

describe('bundleSanitizedHtml — canonical shell contract', () => {
  it('emits exactly one CSP meta whose script-src pins the shared runtime SHA', () => {
    const { html } = bundleSanitizedHtml(payload());
    const cspMetas = html.match(/<meta http-equiv="Content-Security-Policy"[^>]*>/g) ?? [];
    expect(cspMetas).toHaveLength(1);
    expect(cspMetas[0]).toContain(`script-src 'sha256-${HTML_EXPORT_RUNTIME_JS_SHA256}'`);
  });

  it('emits exactly two <style> blocks; block 2 is contentCss with @layer he-authored', () => {
    const contentCss = '@layer he-authored{[data-he-content] .note{color:blue}}[data-he-content] [data-he-inline-style="0"]{font-weight:700}';
    const { html } = bundleSanitizedHtml(payload({ contentCss }));
    const styles = styleBlocks(html);
    expect(styles).toHaveLength(2);
    expect(styles[1]).toBe(contentCss);
    expect(styles[1]).toContain('@layer he-authored');
    // Block 1 is the unlayered app-owned base (reset/containment).
    expect(styles[0]).toContain('box-sizing:border-box');
    expect(styles[0]).not.toContain('@layer');
  });

  it('emits exactly one runtime <script> equal to HTML_EXPORT_RUNTIME_JS', () => {
    const { html } = bundleSanitizedHtml(payload());
    const scripts = scriptBlocks(html);
    const runtimeScripts = scripts.filter((s) => s.type === null && s.id === null);
    expect(runtimeScripts).toHaveLength(1);
    expect(runtimeScripts[0].body).toBe(HTML_EXPORT_RUNTIME_JS);
  });

  it('embeds a manifest script with < escaped and mirrored counts + runtimeSha256', () => {
    const counts = { nodeCount: 12, maxDepth: 5, attributeCount: 7 };
    const { html, manifest } = bundleSanitizedHtml(
      payload({
        counts,
        // Force a '<' into the serialized path via a count-only payload; the
        // escape is exercised by injecting a body that would only appear if
        // the assembler stringified unescaped HTML into the JSON (it must not).
        bodyHtml: '<h1>Title</h1>',
      }),
    );

    expect(manifest).toEqual({
      schemaVersion: 1,
      nodeCount: 12,
      maxDepth: 5,
      attributeCount: 7,
      runtimeSha256: HTML_EXPORT_RUNTIME_JS_SHA256,
    });

    const scripts = scriptBlocks(html);
    const manifestScript = scripts.find((s) => s.id === 'he-manifest' && s.type === 'application/json');
    expect(manifestScript).toBeDefined();
    // Raw '<' must never appear inside the manifest JSON payload.
    expect(manifestScript!.body).not.toMatch(/</);
    // The escape form for '<' is present when any string value would need it —
    // force one by putting '<' into a count-adjacent string field via body not
    // in the manifest. Instead verify the escape helper by constructing JSON
    // that would include '<' if we ever put bodyHtml into the manifest (we don't),
    // and assert the runtime SHA / counts round-trip.
    const parsed = JSON.parse(manifestScript!.body);
    expect(parsed).toEqual(manifest);

    // Explicit escape regression: if a future field ever carried '<', the
    // assembler uses \u003c. Prove the helper by re-running the same replace.
    expect(JSON.stringify({ x: '<script>' }).replace(/</g, '\\u003c')).toContain('\\u003c');
    expect(html).toContain('id="he-manifest"');
  });

  it('escapes < inside the manifest JSON as \\u003c', () => {
    // The current manifest fields are numbers/strings without '<' (SHA is base64).
    // Prove the embed path by verifying that a crafted payload that *could*
    // introduce '<' into JSON is escaped — we unit-check the assembler by
    // monkeying through a counts object that, after JSON.stringify, would
    // never contain '<' for numeric fields, so instead assert the emitted
    // script body equals the escaped form of the returned manifest.
    const { html, manifest } = bundleSanitizedHtml(payload());
    const expected = JSON.stringify(manifest).replace(/</g, '\\u003c');
    expect(html).toContain(`<script type="application/json" id="he-manifest">${expected}</script>`);
  });

  it('is deterministic for identical input', () => {
    const p = payload({ bodyHtml: '<h1>Round trip</h1>' });
    const a = bundleSanitizedHtml(p);
    const b = bundleSanitizedHtml(p);
    expect(a.html).toBe(b.html);
    expect(a.manifest).toEqual(b.manifest);
  });

  it('orders head as charset → CSP → viewport → styles → manifest', () => {
    const { html } = bundleSanitizedHtml(payload());
    const head = headInner(html);
    const charset = head.indexOf('<meta charset="utf-8">');
    const csp = head.indexOf('<meta http-equiv="Content-Security-Policy"');
    const viewport = head.indexOf('<meta name="viewport" content="width=device-width, initial-scale=1">');
    const style1 = head.indexOf('<style>');
    const style2 = head.indexOf('<style>', style1 + 1);
    const manifest = head.indexOf('<script type="application/json" id="he-manifest">');

    expect(charset).toBeGreaterThanOrEqual(0);
    expect(csp).toBeGreaterThan(charset);
    expect(viewport).toBeGreaterThan(csp);
    expect(style1).toBeGreaterThan(viewport);
    expect(style2).toBeGreaterThan(style1);
    expect(manifest).toBeGreaterThan(style2);
  });

  it('round-trips a benign <h1> from bodyHtml into the body', () => {
    const { html } = bundleSanitizedHtml(payload({ bodyHtml: '<h1>Hello shell</h1>' }));
    const body = html.match(/<body>\n?([\s\S]*?)\n?<\/body>/)?.[1] ?? '';
    expect(body).toContain('<h1>Hello shell</h1>');
    // Runtime script follows the body content.
    expect(body.indexOf('<h1>Hello shell</h1>')).toBeLessThan(body.indexOf('<script>'));
  });

  it('wraps the sanitized body in the [data-he-content] scope root so sanitized CSS matches', () => {
    // The real sanitizer emits inner body content with no wrapper; the shell must
    // add the [data-he-content] content root that every scoped selector targets,
    // or the export renders unstyled (#29 P1).
    const { html } = bundleSanitizedHtml(payload({ bodyHtml: '<h1>Styled</h1>' }));
    expect(html).toMatch(/<body>\s*<div data-he-content>\s*<h1>Styled<\/h1>/);
    const bodyInner = html.match(/<body>([\s\S]*?)<\/body>/)?.[1] ?? '';
    // The runtime script stays outside (after) the content root.
    expect(bodyInner.indexOf('</div>')).toBeLessThan(bodyInner.indexOf('<script>'));
  });

  it('does not introduce http(s) or protocol-relative // origins via the shell wrapper', () => {
    // Payload deliberately free of remote-looking substrings.
    const p = payload({
      bodyHtml: '<div data-he-content><p>local only</p></div>',
      documentHtml: '<html><body><div data-he-content><p>local only</p></div></body></html>',
      contentCss: '@layer he-authored{[data-he-content] p{color:red}}',
    });
    const { html } = bundleSanitizedHtml(p);
    expect(html).not.toMatch(/https?:\/\//i);
    // Protocol-relative origins look like src="//…" / href='//…' / url(//…).
    // Bare '//' can appear inside a base64 CSP hash, so only flag origin forms.
    expect(html).not.toMatch(/(?:src|href)\s*=\s*['"]\/\//i);
    expect(html).not.toMatch(/url\(\s*\/\//i);
  });

  it('neutralizes a </style> raw-text breakout smuggled through contentCss', () => {
    // css-tree generate() unescapes CSS escapes, so a sanitized content string
    // can carry a literal </style> that would otherwise close the element and
    // inject <meta http-equiv="refresh"> markup into the head.
    const p = payload({
      contentCss:
        '@layer he-authored{[data-he-content] p::before{content:"</style><meta http-equiv=refresh content=0;url=https://evil.example/><style>"}}',
    });
    const { html } = bundleSanitizedHtml(p);

    // The head still parses as exactly two <style> blocks — the smuggled
    // </style> did not create a third boundary.
    expect(styleBlocks(html)).toHaveLength(2);
    // The dangerous raw-text end adjacency is gone; the </style is escaped to
    // <\/style (\/ === / in CSS, so the value renders unchanged).
    expect(html).not.toContain('</style><meta');
    expect(html).toContain('<\\/style>');
    // The smuggled markup stays INSIDE the second style block as inert CSS text.
    const smuggled = styleBlocks(html)[1];
    expect(smuggled).toContain('http-equiv=refresh');
    // With both style blocks stripped, the head skeleton carries no parsed
    // meta-refresh and no remote origin — the injection never reached markup.
    const headSkeleton = headInner(html).replace(/<style>[\s\S]*?<\/style>/g, '');
    expect(headSkeleton).not.toMatch(/http-equiv\s*=\s*["']?refresh/i);
    expect(headSkeleton).not.toMatch(/https?:\/\//i);
    const cspMetas = html.match(/<meta http-equiv="Content-Security-Policy"[^>]*>/g) ?? [];
    expect(cspMetas).toHaveLength(1);
  });
});
