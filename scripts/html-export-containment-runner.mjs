/**
 * html-export-containment-runner.mjs — REAL-DOM containment gate (G006).
 *
 * Runs the deterministic HTML-export pipeline against a LIVE Electron offscreen
 * (hidden) window and asserts containment for every corpus fixture across the
 * matrix:
 *
 *     fixture × {slides, scroll} × {horizontal, vertical} × {a couple viewports}
 *
 * For each cell it: builds a ContentModel from the fixture Markdown (via the
 * deterministic AI-free `corpusToModel` shim), runs `planSlides` /
 * `planScrollContainment` with the REAL DOM measure adapter, renders + bundles
 * the self-contained HTML, loads it in the hidden window, and ASSERTS:
 *
 *   slides — the page never scrolls; every planned slide + descendant rect stays
 *            inside the viewport / safe area; top-level blocks never overlap; the
 *            min readable scale is respected; continuation slides fit.
 *   scroll — max(documentElement.scrollWidth, body.scrollWidth) <= innerWidth+1
 *            (no horizontal page scroll) and every major block stays within the
 *            viewport width; vertical scroll is allowed.
 *   all    — validateSelfContainedHtml() passes and NO remote request is made.
 *
 * The user's REAL "겐츠 도쿄 출장" handover (`gentz-handover.md`) is a REQUIRED
 * input: when absent it is reported as SKIPPED-PENDING-REAL-DOC (NOT a pass);
 * when present it joins the matrix and must pass for final acceptance.
 *
 * Exit code: NONZERO on any containment / self-contained / remote-request
 * failure (and in --inject mode, which deliberately fails to prove the gate
 * bites). Run via: `npm run test:html-export` (i.e. `electron <thisfile>`).
 *
 * If Electron cannot launch a window in this environment (no display / sandbox),
 * the runner reports the exact limitation and exits nonzero WITHOUT faking a
 * pass — the vitest pipeline gate (src/__tests__/html-export-pipeline.test.ts)
 * is the headless-CI-safe automated equivalent.
 */

import { app, BrowserWindow, session } from 'electron';
import { readFileSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const FIXTURE_DIR = resolve(REPO, 'src/renderer/__fixtures__/html-export');

const SYNTHETIC = ['short', 'very-long', 'table-heavy', 'code-heavy', 'korean', 'mixed', 'data-heavy'];
const REAL_HANDOVER = 'gentz-handover.md';
const INJECT = process.argv.includes('--inject') || process.env.HE_INJECT_FAILURE === '1';
const SHOT = process.env.HE_SHOT || (process.argv.includes('--shot') ? '/tmp/he-shot.png' : '');
const DUMP = process.env.HE_DUMP || '';
let shotDone = false;

const ORIENTATIONS = ['horizontal', 'vertical'];
const PRESENTATIONS = [
  { label: 'theme', presentation: undefined },
  { label: 'roomy', presentation: { density: 'roomy' } },
];

// Offscreen + headless-friendly switches (best effort across environments).
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('use-mock-keychain'); // never prompt the user's macOS Keychain from a test run

const remoteRequests = [];

function log(...args) {
  // eslint-disable-next-line no-console
  console.log(...args);
}

function slideDims(orientation) {
  const width = orientation === 'vertical' ? 720 : 1280;
  const height = orientation === 'vertical' ? 1280 : 720;
  return { width, height };
}

function slideViewports(orientation) {
  const d = slideDims(orientation);
  return [
    { w: d.width, h: d.height, label: 'canvas' },
    { w: Math.round(d.width * 1.5), h: Math.round(d.height * 1.5), label: 'oversize' },
  ];
}

function scrollViewports(orientation) {
  return orientation === 'vertical'
    ? [
        { w: 720, h: 1280, label: 'narrow' },
        { w: 480, h: 900, label: 'short' },
      ]
    : [
        { w: 1280, h: 720, label: 'wide' },
        { w: 900, h: 680, label: 'medium' },
      ];
}

/** Bundle scripts/he-harness.ts (+ pipeline) into a single browser IIFE. */
async function buildHarness() {
  let esbuild;
  try {
    esbuild = await import('esbuild');
  } catch (e) {
    throw new Error(
      `esbuild is required to bundle the harness but could not be imported (${e && e.message}). ` +
        `esbuild ships transitively with vite (a devDependency); run \`npm install\` first.`,
    );
  }
  const result = await esbuild.build({
    entryPoints: [resolve(__dirname, 'he-harness.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    write: false,
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

const fixtures = []; // { name, md, required, kind }

function loadFixtures() {
  for (const name of SYNTHETIC) {
    const p = resolve(FIXTURE_DIR, `${name}.md`);
    fixtures.push({ name, md: readFileSync(p, 'utf8'), required: true, kind: 'synthetic' });
  }
  fixtures.push({
    name: 'long-title',
    md: `# ${'L'.repeat(600)}\n\n## Summary\n\nThe cover title must be measured, scaled, and kept clear of navigation.`,
    required: true,
    kind: 'synthetic',
  });
  const realPath = resolve(FIXTURE_DIR, REAL_HANDOVER);
  const realPresent = existsSync(realPath);
  if (realPresent) {
    fixtures.push({ name: 'gentz-handover', md: readFileSync(realPath, 'utf8'), required: true, kind: 'real' });
  }
  if (INJECT) {
    const poison = `# Injected Failure\n\n## Overflow\n\n${'X'.repeat(4000)}\n`;
    fixtures.push({ name: '__inject__', md: poison, required: true, kind: 'inject' });
  }
  return realPresent;
}

async function withTimeout(promise, ms, what) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`timeout after ${ms}ms: ${what}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(t);
  }
}

async function run() {
  const realPresent = loadFixtures();
  const harnessIife = await buildHarness();
  const tmp = mkdtempSync(join(tmpdir(), 'he-containment-'));

  // Block (and record) any remote request — proves the document is offline-safe.
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    const u = String(details.url || '');
    if (/^(file:|data:|devtools:|blob:|about:|chrome:|chrome-extension:)/i.test(u)) {
      cb({ cancel: false });
      return;
    }
    remoteRequests.push(u);
    cb({ cancel: true });
  });

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    useContentSize: true,
    webPreferences: {
      offscreen: true,
      sandbox: false,
      contextIsolation: false,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.webContents.setAudioMuted(true);

  let fileCounter = 0;
  const inject = () => withTimeout(win.webContents.executeJavaScript(harnessIife, true), 15000, 'inject harness');
  const callHarness = (fn, md, opts) =>
    withTimeout(
      win.webContents.executeJavaScript(`window.__heHarness.${fn}(${JSON.stringify(md)},${JSON.stringify(opts)})`, true),
      30000,
      `${fn}`,
    );

  async function loadHtmlAt(html, w, h) {
    win.setContentSize(w, h);
    const file = join(tmp, `cell-${fileCounter++}.html`);
    writeFileSync(file, html, 'utf8');
    remoteRequests.length = 0;
    await withTimeout(win.loadFile(file), 30000, `load ${file}`);
    await inject();
    return remoteRequests.slice();
  }
  async function assertComputedScalerTransformRegression() {
    const md = `# ${'L'.repeat(600)}\n\n## Summary\n\nThe computed scaler transform must remain authoritative.`;
    const opts = { orientation: 'horizontal', layout: 'slides', title: 'computed-transform-regression' };
    const bundle = await callHarness('bundleDoc', md, opts);
    await loadHtmlAt(bundle.html, 1280, 720);

    const before = await withTimeout(
      win.webContents.executeJavaScript(
        `(() => {
          const scaler = document.querySelector('.slide.active .he-scaler');
          if (!scaler) return null;
          const declaredScale = Number.parseFloat(scaler.getAttribute('data-he-scale') || '');
          const transform = getComputedStyle(scaler).transform;
          scaler.style.transform = 'none';
          return { declaredScale, transform };
        })()`,
        true,
      ),
      15000,
      'tamper shipped scaler transform',
    );
    if (!before || !Number.isFinite(before.declaredScale) || before.declaredScale >= 1) {
      throw new Error(`scaler transform regression fixture did not produce a scaled shipped cover (${JSON.stringify(before)})`);
    }

    const verdict = await callHarness('assertSlides', md, opts);
    const transformMismatch = (verdict.failures || []).some(
      (failure) => typeof failure === 'string' && failure.includes('data-he-scale') && failure.includes('computed transform'),
    );
    if (verdict.ok !== false || !transformMismatch) {
      throw new Error(`computed scaler transform regression was not detected (${JSON.stringify(verdict.failures || [])})`);
    }
    log('REGRESSION: retained data-he-scale with a removed computed scaler transform was detected.');
  }

  // Boot page so the first bundleDoc() (pure) has the harness available.
  await withTimeout(win.loadURL('about:blank'), 15000, 'about:blank');
  await inject();

  await assertComputedScalerTransformRegression();
  const rows = [];
  let pass = 0;
  let fail = 0;
  let injectDetected = false;

  for (const fx of fixtures) {
    for (const orientation of ORIENTATIONS) {
      for (const layout of ['slides', 'scroll']) {
        const viewports = layout === 'slides' ? slideViewports(orientation) : scrollViewports(orientation);
        for (const presentationCase of PRESENTATIONS) {
          const bundle = await callHarness('bundleDoc', fx.md, {
            orientation,
            layout,
            title: fx.name,
            presentation: presentationCase.presentation,
          });
          for (const vp of viewports) {
            const remote = await loadHtmlAt(bundle.html, vp.w, vp.h);
            const assertFn = layout === 'slides' ? 'assertSlides' : 'assertScroll';
            const verdict = await callHarness(assertFn, fx.md, {
              orientation,
              title: fx.name,
              presentation: presentationCase.presentation,
            });

            const failures = [...(verdict.failures || [])];
            if (!bundle.validate.ok) failures.push(`not self-contained: ${bundle.validate.violations.join('; ')}`);
            if (remote.length > 0) failures.push(`remote request(s): ${remote.join(', ')}`);

            const ok = failures.length === 0 && verdict.ok !== false;
            const row = {
              fixture: fx.name,
              kind: fx.kind,
              layout,
              orientation,
              presentation: presentationCase.label,
              viewport: `${vp.w}x${vp.h}(${vp.label})`,
              slides: verdict.slideCount,
              splits: verdict.splits,
              minScale: typeof verdict.minScale === 'number' ? Number(verdict.minScale.toFixed(3)) : null,
              ok,
              navMinWidth: typeof verdict.navMinWidth === 'number' ? Number(verdict.navMinWidth.toFixed(1)) : null,
              navMinHeight: typeof verdict.navMinHeight === 'number' ? Number(verdict.navMinHeight.toFixed(1)) : null,
              maxTopOffset: typeof verdict.maxTopOffset === 'number' ? Number(verdict.maxTopOffset.toFixed(1)) : null,
              readingWidthRatio: typeof verdict.readingWidthRatio === 'number' ? Number(verdict.readingWidthRatio.toFixed(3)) : null,
              navOverlapCount: typeof verdict.navOverlapCount === 'number' ? verdict.navOverlapCount : null,
              minEffectiveBodyPx: typeof verdict.minEffectiveBodyPx === 'number' ? verdict.minEffectiveBodyPx : null,
              minEffectiveCaptionPx: typeof verdict.minEffectiveCaptionPx === 'number' ? verdict.minEffectiveCaptionPx : null,
              shippedDeckScale: typeof verdict.shippedDeckScale === 'number' ? verdict.shippedDeckScale : null,


              failures,
            };
            rows.push(row);
            if (fx.kind === 'inject') {
              if (!ok) injectDetected = true; // expected to fail
            }
            if (ok) pass += 1;
            else fail += 1;
            // Optional: capture ONE real screenshot of an applied (paginated+scaled) cell.
            if (DUMP && !shotDone && ok && fx.kind !== 'inject' && layout === 'slides' && orientation === 'horizontal') {
              writeFileSync(DUMP, bundle.html, 'utf8');
              shotDone = true;
              console.log(`DUMP saved: ${DUMP} (${fx.name} / slides / horizontal)`);
            }
            if (SHOT && !shotDone && ok && fx.kind !== 'inject' && layout === 'slides' && orientation === 'horizontal') {
              try {
                const img = await withTimeout(win.webContents.capturePage(), 15000, 'capturePage');
                writeFileSync(SHOT, img.toPNG());
                shotDone = true;
                console.log(`SHOT saved: ${SHOT} (${fx.name} / slides / horizontal / ${vp.label})`);
              } catch (e) {
                console.log(`SHOT failed: ${e?.message ?? e}`);
              }
            }
          }
        }
      }
    }
  }

  // ---- Report ----------------------------------------------------------------
  log('\n=== HTML-export containment matrix (REAL Electron offscreen DOM) ===\n');
  for (const r of rows) {
    const status = r.ok ? 'PASS' : 'FAIL';
    log(
      `[${status}] ${r.fixture.padEnd(15)} ${r.layout.padEnd(6)} ${r.orientation.padEnd(10)} ${r.presentation.padEnd(6)} ${r.viewport.padEnd(18)} ` +
        `slides=${String(r.slides).padStart(3)} splits=${String(r.splits ?? '-').padStart(3)} minScale=${r.minScale ?? '-'} ` +
        `nav=${r.navMinWidth ?? '-'}×${r.navMinHeight ?? '-'} deck=${r.shippedDeckScale ?? '-'} overlap=${r.navOverlapCount ?? '-'} body=${r.minEffectiveBodyPx ?? '-'} caption=${r.minEffectiveCaptionPx ?? '-'} topOffset=${r.maxTopOffset ?? '-'} fill=${r.readingWidthRatio ?? '-'}`,
    );
    for (const f of r.failures) log(`        ↳ ${f}`);
  }

  log('\n--- Real handover (gentz-handover.md) ---');
  if (realPresent) {
    const realRows = rows.filter((r) => r.kind === 'real');
    const realFail = realRows.filter((r) => !r.ok).length;
    log(`  PRESENT — ran ${realRows.length} cells, ${realFail} failed.`);
  } else {
    log('  SKIPPED-PENDING-REAL-DOC — gentz-handover.md is absent. This is NOT a pass.');
    log('  Drop the real document at src/renderer/__fixtures__/html-export/gentz-handover.md');
    log('  (see REAL-HANDOVER.README.md). Final acceptance requires it.');
  }

  log(`\nSummary: ${pass} passed, ${fail} failed, ${rows.length} cells total.`);

  let exitCode = fail > 0 ? 1 : 0;
  if (INJECT) {
    if (injectDetected) {
      log('INJECT MODE: injected overflow was correctly DETECTED as a failure — the gate bites. (exit nonzero by design)');
      exitCode = exitCode || 1;
    } else {
      log('INJECT MODE: injected overflow was NOT detected — THE GATE FAILED TO BITE.');
      exitCode = 2;
    }
  }
  log(realPresent ? '' : 'Note: synthetic corpus result above stands on its own; the real doc remains pending.');

  win.destroy();
  return exitCode;
}

async function main() {
  try {
    await withTimeout(app.whenReady(), 60000, 'app.whenReady (no display / sandbox?)');
  } catch (e) {
    log(`\nELECTRON-CANNOT-LAUNCH: ${e && e.message}`);
    log('This is an environment limitation, NOT a containment pass.');
    log('Use the headless-safe vitest gate instead: `npx vitest run src/__tests__/html-export-pipeline.test.ts`.');
    process.exit(3);
  }
  let code = 1;
  try {
    code = await run();
  } catch (e) {
    log(`\nRUNNER ERROR: ${(e && e.stack) || e}`);
    log('This is NOT a containment pass.');
    code = 4;
  }
  app.exit(code);
}

main();
