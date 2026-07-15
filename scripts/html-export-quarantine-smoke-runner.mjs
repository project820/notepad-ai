/**
 * html-export-quarantine-smoke-runner.mjs — live §5.12 quarantine host smoke (G006).
 *
 * Boots a REAL Electron offscreen host (`ElectronQuarantineHost` +
 * `HtmlExportQuarantinePool`) and proves:
 *   1. Benign HTML → pass with finite measurement and blockedRemoteRequests === 0
 *   2. Remote resource HTML → result returned AND remote request cancelled (count > 0)
 *   3. >20000 DOM nodes → quarantine-oversize
 *   4. Concurrent measures for the same webContentsId → second is quarantine-busy
 *
 * Exit NONZERO on any failure. If Electron cannot open an offscreen window here,
 * print the exact limitation and exit NONZERO WITHOUT faking a pass.
 *
 * Run: `electron scripts/html-export-quarantine-smoke-runner.mjs`
 */

import { app } from 'electron';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const require = createRequire(import.meta.url);

// Offscreen + headless-friendly switches (mirror containment runner).
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('use-mock-keychain');
// Keep the process alive after the host destroys its only offscreen window between measures.
app.on('window-all-closed', () => {});

function log(...args) {
  // eslint-disable-next-line no-console
  console.log(...args);
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function withTimeout(promise, ms, what) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`timeout after ${ms}ms: ${what}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

/**
 * Load host+pool from dist/main if present; otherwise esbuild-bundle the TS sources
 * (electron external) into a temp CJS module and require it.
 */
async function loadModules() {
  const distHost = resolve(REPO, 'dist/main/html-export-quarantine-host.js');
  const distPool = resolve(REPO, 'dist/main/html-export-quarantine.js');
  if (existsSync(distHost) && existsSync(distPool)) {
    log('loading modules from dist/main');
    return {
      ElectronQuarantineHost: require(distHost).ElectronQuarantineHost,
      HtmlExportQuarantinePool: require(distPool).HtmlExportQuarantinePool,
    };
  }

  log('dist/main host missing — bundling TS via esbuild');
  let esbuild;
  try {
    esbuild = await import('esbuild');
  } catch (e) {
    throw new Error(
      `esbuild is required to bundle the quarantine host but could not be imported (${e && e.message}). ` +
        `Run \`npm install\` first.`,
    );
  }

  const result = await esbuild.build({
    entryPoints: [resolve(REPO, 'src/main/html-export-quarantine-host.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    write: false,
    external: ['electron'],
    logLevel: 'silent',
  });

  // Also need HtmlExportQuarantinePool — re-export from a tiny entry that pulls both.
  const poolResult = await esbuild.build({
    entryPoints: [resolve(REPO, 'src/main/html-export-quarantine.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    write: false,
    external: ['electron'],
    logLevel: 'silent',
  });

  const dir = mkdtempSync(join(tmpdir(), 'he-quarantine-smoke-'));
  const hostPath = join(dir, 'host.cjs');
  const poolPath = join(dir, 'pool.cjs');
  writeFileSync(hostPath, result.outputFiles[0].text, 'utf8');
  writeFileSync(poolPath, poolResult.outputFiles[0].text, 'utf8');

  const hostMod = require(hostPath);
  const poolMod = require(poolPath);
  if (!hostMod.ElectronQuarantineHost) {
    throw new Error('bundled host module missing ElectronQuarantineHost export');
  }
  if (!poolMod.HtmlExportQuarantinePool) {
    throw new Error('bundled pool module missing HtmlExportQuarantinePool export');
  }
  return {
    ElectronQuarantineHost: hostMod.ElectronQuarantineHost,
    HtmlExportQuarantinePool: poolMod.HtmlExportQuarantinePool,
  };
}

/** Mutable in-memory registry: key → html string. */
function makeRegistry(store) {
  return {
    read(webContentsId, attemptId, artifactId, _expectedStage) {
      const key = `${webContentsId}:${attemptId}:${artifactId}`;
      const html = store.get(key);
      if (html === undefined) {
        return { ok: false, error: { kind: 'unknown-artifact' } };
      }
      const bytes = Buffer.from(html, 'utf8');
      return {
        ok: true,
        value: {
          ref: { byteLength: bytes.byteLength, sha256: digest(bytes) },
          bytes,
        },
      };
    },
  };
}

function put(store, webContentsId, attemptId, artifactId, html) {
  store.set(`${webContentsId}:${attemptId}:${artifactId}`, html);
}

function buildOversizeHtml(nodeCount) {
  // html + head + body + N children ≈ N+3 elements via getElementsByTagName('*')
  const parts = ['<!doctype html><html><head></head><body>'];
  for (let i = 0; i < nodeCount; i++) parts.push('<i></i>');
  parts.push('</body></html>');
  return parts.join('');
}

async function run() {
  const { ElectronQuarantineHost, HtmlExportQuarantinePool } = await loadModules();
  const store = new Map();
  const host = new ElectronQuarantineHost();
  const pool = new HtmlExportQuarantinePool({
    registry: makeRegistry(store),
    host,
    deadlineMs: 15_000,
  });

  const failures = [];
  const check = (name, cond, detail = '') => {
    if (cond) {
      log(`  PASS  ${name}`);
    } else {
      log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
      failures.push(name);
    }
  };

  // Probe that an offscreen window can actually be created in this environment.
  {
    const { BrowserWindow } = await import('electron');
    let probe;
    try {
      probe = new BrowserWindow({
        show: false,
        width: 320,
        height: 240,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
          backgroundThrottling: false,
          offscreen: true,
        },
      });
      await withTimeout(probe.loadURL('about:blank'), 15_000, 'offscreen probe loadURL');
    } catch (e) {
      throw new Error(
        `ELECTRON-OFFSCREEN-UNAVAILABLE: ${e && e.message}. ` +
          `This is an environment limitation, NOT a quarantine pass.`,
      );
    } finally {
      try {
        if (probe && !probe.isDestroyed()) probe.destroy();
      } catch {
        /* ignore */
      }
    }
  }

  // ---- 1. Benign small HTML -------------------------------------------------
  log('\n[1] benign HTML → pass, finite measurement, external-requests=0');
  {
    const html =
      '<!doctype html><html><head><title>ok</title></head><body><p data-he-region="artifact">hello</p></body></html>';
    put(store, 1, 'a1', 'r1', html);
    const before = host.blockedRemoteRequests;
    const result = await withTimeout(pool.measure(1, 'a1', 'r1'), 20_000, 'benign measure');
    const blocked = host.blockedRemoteRequests - before;
    check('benign ok:true', result.ok === true, JSON.stringify(result));
    check('benign verdict:pass', result.ok && result.value.verdict === 'pass');
    if (result.ok) {
      const m = result.value.measurement;
      check(
        'benign measurement finite',
        Number.isFinite(m.nodeCount) &&
          Number.isFinite(m.maxDepth) &&
          Number.isFinite(m.documentWidth) &&
          Number.isFinite(m.documentHeight) &&
          Number.isFinite(m.viewportWidth) &&
          Number.isFinite(m.viewportHeight),
        JSON.stringify(m),
      );
      check('benign nodeCount > 0', m.nodeCount > 0, String(m.nodeCount));
    }
    check('benign blockedRemoteRequests === 0', blocked === 0, `blocked=${blocked}`);
  }

  // ---- 2. Remote resource HTML ---------------------------------------------
  log('\n[2] remote resource HTML → result + blocked remote request');
  {
    const html =
      '<!doctype html><html><body><img src="https://example.test/x.png" alt="x"><p>remote</p></body></html>';
    put(store, 2, 'a2', 'r2', html);
    const before = host.blockedRemoteRequests;
    const result = await withTimeout(pool.measure(2, 'a2', 'r2'), 20_000, 'remote measure');
    const blocked = host.blockedRemoteRequests - before;
    check(
      'remote returned a result (pass or typed error)',
      result && typeof result.ok === 'boolean',
      JSON.stringify(result),
    );
    check(
      'remote blockedRemoteRequests > 0 (cancelled, not fetched)',
      blocked > 0,
      `blocked=${blocked} total=${host.blockedRemoteRequests}`,
    );
    log(`    result=${JSON.stringify(result)} blockedDelta=${blocked}`);
  }

  // ---- 3. Oversize DOM ------------------------------------------------------
  log('\n[3] >20000 DOM nodes → quarantine-oversize');
  {
    // 20001 <i> + html/head/body > 20000 elements
    const html = buildOversizeHtml(20_001);
    put(store, 3, 'a3', 'r3', html);
    const result = await withTimeout(pool.measure(3, 'a3', 'r3'), 60_000, 'oversize measure');
    check(
      'oversize → quarantine-oversize',
      result.ok === false && result.error && result.error.kind === 'quarantine-oversize',
      JSON.stringify(result),
    );
  }

  // ---- 4. Concurrent same webContentsId → busy ------------------------------
  log('\n[4] two concurrent measures same webContentsId → second quarantine-busy');
  {
    const hangHtml =
      '<!doctype html><html><body><p>hang-probe</p><script>/* no remote */</script></body></html>';
    put(store, 4, 'a4a', 'r4a', hangHtml);
    put(store, 4, 'a4b', 'r4b', hangHtml);

    // Kick first measure without awaiting so the second hits admission.
    const first = pool.measure(4, 'a4a', 'r4a');
    // Yield a tick so first can pass the sync admission check.
    await new Promise((r) => setImmediate(r));
    const second = await withTimeout(pool.measure(4, 'a4b', 'r4b'), 5_000, 'busy second measure');
    check(
      'second concurrent → quarantine-busy',
      second.ok === false && second.error && second.error.kind === 'quarantine-busy',
      JSON.stringify(second),
    );
    // Drain first so reset completes before process exit.
    try {
      await withTimeout(first, 20_000, 'busy first measure drain');
    } catch (e) {
      log(`    (first measure drain: ${e && e.message})`);
    }
  }

  log(`\n=== quarantine smoke: ${failures.length === 0 ? 'PASS' : 'FAIL'} (${failures.length} failure(s)) ===`);
  if (failures.length > 0) {
    for (const f of failures) log(`  - ${f}`);
  }
  return failures.length === 0 ? 0 : 1;
}

async function main() {
  try {
    await withTimeout(app.whenReady(), 60_000, 'app.whenReady (no display / sandbox?)');
  } catch (e) {
    log(`\nELECTRON-CANNOT-LAUNCH: ${e && e.message}`);
    log('This is an environment limitation, NOT a quarantine pass.');
    process.exit(3);
  }

  let code = 1;
  try {
    code = await run();
  } catch (e) {
    log(`\nRUNNER ERROR: ${(e && e.stack) || e}`);
    log('This is NOT a quarantine pass.');
    code = 4;
  }
  app.exit(code);
}

main();
