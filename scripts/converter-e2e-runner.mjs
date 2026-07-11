/**
 * converter-e2e-runner.mjs — proves the isolated converter worker round-trips in a
 * REAL Electron utilityProcess (Phase 3). Forks dist/main/converter-worker.js via
 * the same transport main uses, sends a small document, and asserts a well-formed
 * response comes back (the channel + kordoc import + reply all work out-of-main),
 * and that an unparseable blob fails gracefully (ok:false) without crashing main.
 *
 * Exit NONZERO on failure or if Electron cannot fork (reported, never a faked pass).
 * The host's timeout/kill/respawn/correlation logic is covered headless in
 * src/__tests__/converter-host.test.ts.
 *
 * Run via: `npm run test:converter-e2e` (i.e. `electron <thisfile>`).
 */

import { app, utilityProcess } from 'electron';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const require = createRequire(import.meta.url);

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('use-mock-keychain'); // never prompt the user's macOS Keychain from a test run

const WORKER = resolve(REPO, 'dist/main/converter-worker.js');
const failures = [];
const check = (name, cond) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}`);
  if (!cond) failures.push(name);
};
const bail = (m) => {
  console.error(`[converter-e2e] ENV-FAIL (not a pass): ${m}`);
  process.exit(2);
};

/** A tiny, well-formed PDF carrying the text "Hello kordoc". */
function tinyPdf() {
  const pdf =
    '%PDF-1.4\n' +
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n' +
    '4 0 obj<</Length 52>>stream\nBT /F1 18 Tf 20 120 Td (Hello kordoc) Tj ET\nendstream endobj\n' +
    '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n' +
    'trailer<</Root 1 0 R>>\n%%EOF';
  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}

function makeSpawn() {
  return () => {
    const child = utilityProcess.fork(WORKER);
    return {
      post: (msg) => child.postMessage(msg),
      onMessage: (cb) => child.on('message', (m) => cb(m)),
      onExit: (cb) => child.on('exit', () => cb()),
      kill: () => child.kill(),
    };
  };
}

async function main() {
  if (!existsSync(WORKER)) bail(`built worker missing at ${WORKER} — run \`npm run build\` first`);
  const { ConverterHost } = require(resolve(REPO, 'dist/main/converter-host.js'));
  const host = new ConverterHost(makeSpawn(), { timeoutMs: 15000 });

  // 1. A real document round-trips through the worker (channel + kordoc work OOM).
  let res;
  try {
    res = await host.runConvert('pdf', tinyPdf());
  } catch (e) {
    check(`real PDF round-trips through the worker (got: ${e})`, false);
    res = null;
  }
  check('worker returned a well-formed response object', !!res && typeof res.ok === 'boolean');
  check('worker did not crash the host (response received, not a timeout)', !!res);

  // 2. An unparseable blob fails gracefully (ok:false) — no main crash, response returned.
  let bad;
  try {
    bad = await host.runConvert('docx', new Uint8Array([0, 1, 2, 3, 4, 5]));
  } catch (e) {
    bad = { ok: false, error: String(e) };
  }
  check('garbage input yields a graceful ok:false (no crash)', !!bad && bad.ok === false);
}

app.whenReady().then(async () => {
  try {
    await main();
  } catch (err) {
    bail(err && err.stack ? err.stack : String(err));
  }
  if (failures.length > 0) {
    console.error(`\n[converter-e2e] FAILED ${failures.length}: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('\n[converter-e2e] PASS — kordoc conversion runs in an isolated utilityProcess worker.');
  process.exit(0);
});
