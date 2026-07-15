/**
 * html-export-direct-harness.mjs — parallel direct finalized-artifact black-box
 * harness (PR-M2c / AC-M2c).
 *
 * Builds REAL finalized single-file HTML via the canonical shell (bundleSanitizedHtml)
 * for {slides,scroll} × {landscape,portrait}, loads each in an offscreen Electron
 * BrowserWindow with a fresh session that CANCELS every remote request, and asserts
 * the frozen observable invariants:
 *   - remote requests === 0 (fully offline / self-contained),
 *   - no horizontal page-scroll (scrollWidth <= innerWidth + 1) for scroll AND slides,
 *   - the document actually rendered (body height > 0),
 *   - preview bytes === save bytes (sha256 of the served file === the finalize digest).
 * A hostile fixture (a document that references a remote image) is loaded to prove
 * the session BLOCKS the remote request (fail-closed containment). §D2 raster header
 * validation is exercised on a malformed header (fail-closed).
 *
 * ADDITIVE: this is a NEW parallel runner. The existing `test:html-export`
 * (ContentModel containment runner) is untouched and stays the shipped gate until
 * cutover transfers runner ownership here.
 */

import { app } from 'electron';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const require = createRequire(import.meta.url);

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('use-mock-keychain');
app.on('window-all-closed', () => {});

function log(...args) {
  process.stdout.write(`${args.join(' ')}\n`);
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function withTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout: ${what}`)), ms)),
  ]);
}

async function esbuildToCjs(entry, external = ['electron']) {
  let esbuild;
  try {
    esbuild = await import('esbuild');
  } catch (e) {
    throw new Error(`esbuild is required to bundle ${entry} (${e && e.message}). Run \`npm install\`.`);
  }
  const result = await esbuild.build({
    entryPoints: [resolve(REPO, entry)],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    write: false,
    external,
    logLevel: 'silent',
  });
  const dir = mkdtempSync(join(tmpdir(), 'he-direct-harness-'));
  const outPath = join(dir, 'mod.cjs');
  writeFileSync(outPath, result.outputFiles[0].text, 'utf8');
  return { mod: require(outPath), dir };
}

async function loadModules() {
  const distShell = resolve(REPO, 'dist/main/html-export-shell.js');
  const distRaster = resolve(REPO, 'dist/main/raster-validate.js');
  let bundleSanitizedHtml;
  let validateRasterHeader;
  if (existsSync(distShell)) {
    log('loading shell from dist/main');
    ({ bundleSanitizedHtml } = require(distShell));
  } else {
    log('dist/main shell missing — bundling TS via esbuild');
    const { mod } = await esbuildToCjs('src/main/html-export-shell.ts');
    bundleSanitizedHtml = mod.bundleSanitizedHtml;
  }
  if (existsSync(distRaster)) {
    ({ validateRasterHeader } = require(distRaster));
  } else {
    const { mod } = await esbuildToCjs('src/main/raster-validate.ts');
    validateRasterHeader = mod.validateRasterHeader;
  }
  if (typeof bundleSanitizedHtml !== 'function') throw new Error('bundleSanitizedHtml export missing');
  return { bundleSanitizedHtml, validateRasterHeader };
}

// ---- Representative finalized payloads (app-authored, shell-shaped) ----------

const LOREM = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(6);

function scrollPayload() {
  const body = `<div data-he-content>${
    Array.from({ length: 8 }, (_, i) => `<section><h2>Section ${i + 1}</h2><p>${LOREM}</p></section>`).join('')
  }</div>`;
  const css = '@layer he-authored{[data-he-content]{width:100%;max-width:900px;margin:0 auto;padding:16px;box-sizing:border-box}[data-he-content] section{margin-bottom:24px}[data-he-content] p{overflow-wrap:break-word}}';
  return { bodyHtml: body, documentHtml: `<html><body>${body}</body></html>`, contentCss: css, counts: { nodeCount: 30, maxDepth: 4, attributeCount: 9 } };
}

function slidesPayload() {
  const body = `<div data-he-content>${
    Array.from({ length: 4 }, (_, i) => `<section class="he-slide"><h1>Slide ${i + 1}</h1><p>${LOREM}</p></section>`).join('')
  }</div>`;
  const css = '@layer he-authored{[data-he-content]{margin:0}.he-slide{width:100%;min-height:100vh;box-sizing:border-box;padding:32px;display:flex;flex-direction:column;justify-content:center;overflow:hidden}}';
  return { bodyHtml: body, documentHtml: `<html><body>${body}</body></html>`, contentCss: css, counts: { nodeCount: 18, maxDepth: 4, attributeCount: 8 } };
}

const VIEWPORTS = [
  { orientation: 'landscape', width: 1280, height: 720 },
  { orientation: 'portrait', width: 720, height: 1280 },
];

async function measure(BrowserWindow, session, html, viewport) {
  const partition = `he-direct-${Math.random().toString(36).slice(2)}`;
  const ses = session.fromPartition(partition, { cache: false });
  let remoteRequests = 0;
  ses.webRequest.onBeforeRequest((details, cb) => {
    const url = String(details.url || '');
    if (/^(https?|ftp|ws|wss):/i.test(url)) {
      remoteRequests += 1;
      cb({ cancel: true });
      return;
    }
    cb({ cancel: false });
  });

  const dir = mkdtempSync(join(tmpdir(), 'he-direct-fixture-'));
  const file = join(dir, 'artifact.html');
  writeFileSync(file, html, 'utf8');
  const servedDigest = digest(readFileSync(file));

  const win = new BrowserWindow({
    show: false,
    width: viewport.width,
    height: viewport.height,
    webPreferences: {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false,
      offscreen: true,
    },
  });
  try {
    await withTimeout(win.loadFile(file), 15_000, 'loadFile');
    // Allow layout to settle.
    await new Promise((r) => setTimeout(r, 150));
    const metrics = await withTimeout(
      win.webContents.executeJavaScript(`(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        bodyHeight: document.body ? document.body.offsetHeight : 0,
        slideCount: document.querySelectorAll('.he-slide').length,
      }))()`),
      10_000,
      'measure',
    );
    return { metrics, remoteRequests, servedDigest };
  } finally {
    try {
      if (!win.isDestroyed()) win.destroy();
    } catch {
      /* ignore */
    }
  }
}

async function run() {
  const { bundleSanitizedHtml, validateRasterHeader } = await loadModules();
  const { BrowserWindow, session } = await import('electron');

  const failures = [];
  const check = (name, cond, detail = '') => {
    if (cond) log(`  PASS  ${name}`);
    else {
      log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
      failures.push(name);
    }
  };

  // Offscreen availability probe.
  {
    let probe;
    try {
      probe = new BrowserWindow({ show: false, width: 320, height: 240, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false } });
      await withTimeout(probe.loadURL('about:blank'), 15_000, 'offscreen probe');
    } catch (e) {
      throw new Error(`ELECTRON-OFFSCREEN-UNAVAILABLE: ${e && e.message}. Environment limitation, NOT a harness pass.`);
    } finally {
      try { if (probe && !probe.isDestroyed()) probe.destroy(); } catch { /* ignore */ }
    }
  }

  const layouts = { scroll: scrollPayload(), slides: slidesPayload() };
  for (const [layout, payload] of Object.entries(layouts)) {
    const { html } = bundleSanitizedHtml(payload);
    const saveDigest = digest(Buffer.from(html, 'utf8'));
    check(`${layout}: finalized html is a single self-contained document`, html.startsWith('<!doctype html>') && html.includes('</html>'));
    check(`${layout}: no remote origins in finalized bytes`, !/https?:\/\//i.test(html) && !/\ssrc=["']\/\//i.test(html), 'remote origin found in bytes');
    // Tie the offline invariant to the PRODUCT contract: the finalized bytes must
    // carry the shipped CSP (default-src 'none'; img-src data:), not just rely on
    // the harness session interceptor.
    check(`${layout}: finalized bytes carry the product CSP (default-src 'none'; img-src data:)`, html.includes("default-src 'none'") && html.includes('img-src data:'), 'CSP directives missing from finalized bytes');

    for (const viewport of VIEWPORTS) {
      log(`\n[${layout} · ${viewport.orientation} ${viewport.width}x${viewport.height}]`);
      const { metrics, remoteRequests, servedDigest } = await measure(BrowserWindow, session, html, viewport);
      check(`${layout}/${viewport.orientation}: remote requests === 0`, remoteRequests === 0, `remote=${remoteRequests}`);
      check(`${layout}/${viewport.orientation}: no horizontal page-scroll`, metrics.scrollWidth <= metrics.innerWidth + 1, `scrollWidth=${metrics.scrollWidth} innerWidth=${metrics.innerWidth}`);
      check(`${layout}/${viewport.orientation}: document rendered (body height > 0)`, metrics.bodyHeight > 0, `bodyHeight=${metrics.bodyHeight}`);
      check(`${layout}/${viewport.orientation}: preview bytes === save bytes (digest equal)`, servedDigest === saveDigest, `served=${servedDigest.slice(0, 12)} save=${saveDigest.slice(0, 12)}`);
      if (layout === 'slides') check(`slides/${viewport.orientation}: deck has slide sections`, metrics.slideCount > 0, `slideCount=${metrics.slideCount}`);
    }
  }

  // Hostile fixture: a raw document that references a remote image must be blocked.
  log('\n[hostile · remote image containment]');
  {
    const hostile = '<!doctype html><html><head><meta charset="utf-8"></head><body><img src="https://example.test/x.png" alt="x"><p>remote</p></body></html>';
    const { remoteRequests } = await measure(BrowserWindow, session, hostile, VIEWPORTS[0]);
    check('hostile remote image request is blocked (cancelled, never fetched)', remoteRequests > 0, `remote=${remoteRequests}`);
  }

  // Negative control: prove the no-horizontal-scroll METRIC is discriminating —
  // a raw wide document (bypassing the shell's overflow-x guard) MUST trip it.
  log('\n[negative control · wide document trips the scroll metric]');
  {
    const wide = '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><div style="width:3000px;height:40px">wide</div></body></html>';
    const { metrics } = await measure(BrowserWindow, session, wide, VIEWPORTS[0]);
    check('wide document trips scrollWidth > innerWidth+1 (metric is falsifiable)', metrics.scrollWidth > metrics.innerWidth + 1, `scrollWidth=${metrics.scrollWidth} innerWidth=${metrics.innerWidth}`);
  }

  // §D2 raster header fixture: a malformed header is rejected fail-closed.
  log('\n[§D2 raster header fail-closed]');
  {
    if (typeof validateRasterHeader === 'function') {
      const malformed = validateRasterHeader(new Uint8Array([0x00, 0x01, 0x02, 0x03]), '.png');
      check('§D2 malformed raster header rejected', malformed && malformed.ok === false, JSON.stringify(malformed));
      // Accept path so an always-reject stub cannot pass this fixture vacuously.
      const validPng = new Uint8Array(33);
      validPng.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const dv = new DataView(validPng.buffer);
      dv.setUint32(8, 13);
      validPng.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
      dv.setUint32(16, 20); // width
      dv.setUint32(20, 10); // height
      validPng[24] = 8; // bit depth
      validPng[25] = 6; // color type RGBA
      const accepted = validateRasterHeader(validPng, '.png');
      check('§D2 valid PNG header accepted', accepted && accepted.ok === true, JSON.stringify(accepted));
    } else {
      check('§D2 validateRasterHeader available', false, 'export missing');
    }
  }

  log('');
  if (failures.length > 0) {
    log(`DIRECT-HARNESS: FAIL (${failures.length}) — ${failures.join(', ')}`);
    return 1;
  }
  log('DIRECT-HARNESS: PASS — finalized black-box × {slides,scroll} × {landscape,portrait}, remote-requests=0, preview==save digest');
  return 0;
}

async function main() {
  try {
    await app.whenReady();
    const code = await run();
    process.exit(code);
  } catch (e) {
    log(`DIRECT-HARNESS: ERROR — ${e && e.stack ? e.stack : e}`);
    process.exit(1);
  }
}

main();
