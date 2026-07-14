/**
 * html-export-shell.ts — main-owned canonical shell assembler (G007 / PR-S4).
 *
 * Additive, deterministic, self-contained. Wraps a sanitized pipeline payload
 * in the frozen §5.10c/§5.11 shell contract:
 *   ONE CSP, ONE hash-pinned runtime, TWO <style> blocks
 *   (unlayered app-owned base + payload contentCss), ONE embedded manifest.
 *
 * The shell is the future SanitizedCandidateId → ResolvedArtifactId resolver
 * but MUST stay unwired into the pipeline / wizard in this slice.
 */

import type { HtmlExportSanitizedPayload } from './html-export-pipeline-service';
import {
  HTML_EXPORT_CSP_META,
  HTML_EXPORT_RUNTIME_JS,
  HTML_EXPORT_RUNTIME_JS_SHA256,
} from '../shared/html-export-runtime';

/** Bump when the embedded shell manifest shape changes. */
const HTML_EXPORT_SHELL_MANIFEST_SCHEMA_VERSION = 1;

export type HtmlExportShellManifest = {
  schemaVersion: number;
  nodeCount: number;
  maxDepth: number;
  attributeCount: number;
  runtimeSha256: string;
};

/**
 * Unlayered app-owned shell base style.
 *
 * Sits outside any CSS cascade layer so author content in `@layer he-authored`
 * can override it. Minimal reset + horizontal containment only — never fixed
 * px width/height, never remote urls.
 */
const SHELL_BASE_CSS = [
  '*,*::before,*::after{box-sizing:border-box;}',
  'html,body{margin:0;padding:0;}',
  'html{overflow-x:hidden;}',
  'body{max-width:100%;overflow-wrap:break-word;word-break:break-word;}',
].join('');

/** Embed the manifest as inline JSON, escaping `<` so it can never break out of the script. */
function embedManifest(manifest: HtmlExportShellManifest): string {
  const json = JSON.stringify(manifest).replace(/</g, '\\u003c');
  return `<script type="application/json" id="he-manifest">${json}</script>`;
}

/**
 * Neutralize any `</style` raw-text end-tag sequence before embedding CSS in a
 * `<style>` element. `css-tree`'s `generate()` unescapes CSS escapes (e.g.
 * `\3c`/`\65`), so a sanitized `content:"..."` string can carry a literal
 * `</style>` that would otherwise close the element and inject attacker markup
 * (meta-refresh, base, link, ...) into the finalized document. `\/` is a valid
 * CSS escape for `/`, so the CSS renders identically while the HTML parser no
 * longer sees a `</style` token.
 */
function escapeStyleText(css: string): string {
  return css.replace(/<\/(style)/gi, '<\\/$1');
}

/**
 * Assemble a single self-contained offline `.html` document from a sanitized
 * pipeline payload. Returns the document string and the embedded manifest
 * object (they mirror each other). Deterministic for identical input.
 */
export function bundleSanitizedHtml(
  payload: HtmlExportSanitizedPayload,
): { html: string; manifest: HtmlExportShellManifest } {
  const manifest: HtmlExportShellManifest = {
    schemaVersion: HTML_EXPORT_SHELL_MANIFEST_SCHEMA_VERSION,
    nodeCount: payload.counts.nodeCount,
    maxDepth: payload.counts.maxDepth,
    attributeCount: payload.counts.attributeCount,
    runtimeSha256: HTML_EXPORT_RUNTIME_JS_SHA256,
  };

  const head = [
    '<meta charset="utf-8">',
    HTML_EXPORT_CSP_META,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style>${escapeStyleText(SHELL_BASE_CSS)}</style>`,
    `<style>${escapeStyleText(payload.contentCss)}</style>`,
    embedManifest(manifest),
  ].join('\n');

  const html =
    '<!doctype html>\n' +
    '<html>\n' +
    `<head>\n${head}\n</head>\n` +
    `<body>\n${payload.bodyHtml}\n<script>${HTML_EXPORT_RUNTIME_JS}</script>\n</body>\n` +
    '</html>\n';

  return { html, manifest };
}
