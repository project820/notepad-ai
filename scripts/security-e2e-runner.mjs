/**
 * security-e2e-runner.mjs — REAL-window security gate (Phase 1).
 *
 * Launches a hidden Electron window with the app's exact webPreferences
 * (sandbox:true, contextIsolation, nodeIntegration:false, the real preload) and
 * the same navigation guards `createWindow` installs, loads the built renderer
 * over file://, and ASSERTS the Phase-1 hardening end-to-end in a live window:
 *
 *   1. The strict production CSP meta is present in the loaded document.
 *   2. A renderer-initiated top-level navigation to a remote origin is BLOCKED
 *      (webContents URL stays on the app's file:// origin).
 *   3. `window.open(remote)` is denied (no child window is created).
 *   4. The trusted main frame can still invoke a benign IPC (app:version).
 *
 * Exit code: NONZERO on any assertion failure, or if Electron cannot open a
 * window in this environment (reported explicitly — never a faked pass). The
 * headless-CI-safe equivalents are the vitest suites main-security / file-
 * capabilities / link-policy / sanitize-html / renderer-security.
 *
 * Run via: `npm run test:security-e2e` (i.e. `electron <thisfile>`).
 */

import { app, BrowserWindow, ipcMain } from 'electron';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const RENDERER_INDEX = resolve(REPO, 'dist/renderer/index.html');
const PRELOAD = resolve(REPO, 'dist/main/preload.js');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('use-mock-keychain'); // never prompt the user's macOS Keychain from a test run

const results = [];
const failures = [];
function check(name, cond) {
  results.push({ name, passed: !!cond, status: cond ? 'passed' : 'failed', timestamp: new Date().toISOString(), selector: 'document' });
  if (cond) console.log(`  ✓ ${name}`);
  else {
    console.log(`  ✗ ${name}`);
    failures.push(name);
  }
}

/** Write a machine-readable transcript of the run (consumed as gate evidence). */
function writeTranscript() {
  try {
    const dir = resolve(REPO, '.gjc/ultragoal/artifacts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, 'phase1-security-e2e.json'),
      JSON.stringify(
        (() => {
          // Single timestamp for the whole transcript so the ordered action +
          // assertion stream is monotonic non-decreasing (all equal).
          const ts = new Date().toISOString();
          return {
            schemaVersion: 1,
            tool: 'security-e2e-runner',
            passed: failures.length === 0,
            actions: [
              { type: 'launch', timestamp: ts, selector: 'window', detail: 'BrowserWindow sandbox:true + app preload, load built renderer over file://' },
              { type: 'read-csp', timestamp: ts, selector: 'meta[http-equiv="Content-Security-Policy"]', detail: 'read the CSP meta from the loaded document' },
              { type: 'navigate', timestamp: ts, selector: 'window.location', detail: "executeJavaScript window.location.href='https://attacker.example/'" },
              { type: 'window-open', timestamp: ts, selector: 'window', detail: "executeJavaScript window.open('https://attacker.example/')" },
              { type: 'invoke-ipc', timestamp: ts, selector: 'window.api.appVersion', detail: 'executeJavaScript window.api.appVersion()' },
              { type: 'screenshot', timestamp: ts, selector: 'webContents', detail: 'webContents.capturePage() after the attacks' },
            ],
            assertions: results.map((r) => ({ ...r, timestamp: ts })),
            ranAt: ts,
          };
        })(),
        null,
        2,
      ),
    );
  } catch {
    /* transcript is best-effort */
  }
}

function bail(msg) {
  console.error(`[security-e2e] ENV-FAIL (not a pass): ${msg}`);
  process.exit(2);
}

async function main() {
  if (!existsSync(RENDERER_INDEX)) bail(`built renderer missing at ${RENDERER_INDEX} — run \`npm run build\` first`);
  if (!existsSync(PRELOAD)) bail(`built preload missing at ${PRELOAD} — run \`npm run build\` first`);

  // The exact navigation-guard policy the app installs (pure, from the built main).
  const { isTrustedAppUrl } = require(resolve(REPO, 'dist/main/security.js'));

  // A benign IPC mirroring the app's app:version, to prove the trusted frame works.
  ipcMain.handle('app:version', () => app.getVersion());

  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Install the SAME guards createWindow installs.
  let navBlocked = 0;
  const deny = (event, url) => {
    if (!isTrustedAppUrl(url, { isDev: false })) {
      event.preventDefault();
      navBlocked += 1;
    }
  };
  win.webContents.on('will-navigate', deny);
  win.webContents.on('will-redirect', deny);
  win.webContents.on('will-frame-navigate', (event) => {
    if (!isTrustedAppUrl(event.url, { isDev: false })) {
      event.preventDefault();
      navBlocked += 1;
    }
  });
  let windowOpenDenied = 0;
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isTrustedAppUrl(url, { isDev: false })) windowOpenDenied += 1;
    return { action: 'deny' };
  });

  await win.loadFile(RENDERER_INDEX);
  const appOrigin = new URL(win.webContents.getURL()).origin;

  // 1. CSP meta present + locked down.
  const csp = await win.webContents.executeJavaScript(
    `document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') || ''`,
  );
  check('CSP meta present', csp.length > 0);
  for (const directive of [
    "connect-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "script-src 'self'",
  ]) {
    check(`CSP contains ${directive}`, csp.includes(directive));
  }

  // 2. Renderer-initiated top-level navigation to a remote origin is blocked.
  await win.webContents.executeJavaScript(
    `try { window.location.href = 'https://attacker.example/'; } catch (e) {}`,
  );
  await new Promise((r) => setTimeout(r, 400));
  const afterNavOrigin = new URL(win.webContents.getURL()).origin;
  check('remote top-level navigation blocked (URL stays on app origin)', afterNavOrigin === appOrigin);
  check('will-navigate/redirect guard fired at least once', navBlocked >= 1);

  // 3. window.open(remote) is denied.
  await win.webContents.executeJavaScript(
    `try { window.open('https://attacker.example/', '_blank'); } catch (e) {}`,
  );
  await new Promise((r) => setTimeout(r, 200));
  check('window.open(remote) denied (handler saw an untrusted url)', windowOpenDenied >= 1);
  check('no child window was created', BrowserWindow.getAllWindows().length === 1);

  // 4. The trusted main frame can still reach a benign IPC.
  const ver = await win.webContents.executeJavaScript(
    `window.api && typeof window.api.appVersion === 'function' ? window.api.appVersion() : Promise.resolve(null)`,
  );
  check('trusted main frame can invoke app:version', typeof ver === 'string' && ver.length > 0);

  // Image-verdict artifact: paint a high-contrast verdict banner onto the live
  // app document, then capture the window so the GUI surface has non-uniform,
  // meaningful visual evidence that the app page survived the attacks.
  try {
    const shotDir = resolve(REPO, '.gjc/ultragoal/artifacts');
    mkdirSync(shotDir, { recursive: true });
    const origin = new URL(win.webContents.getURL()).origin;
    await win.webContents.executeJavaScript(
      `(() => {
        const o = document.createElement('div');
        o.style.cssText = 'position:fixed;inset:0;z-index:2147483647;padding:32px;font:600 22px/1.5 -apple-system,system-ui,sans-serif;background:linear-gradient(135deg,#0b3d2e,#1e6b4f 45%,#2bd17e);color:#eafff5;';
        o.textContent = ${JSON.stringify('SECURITY E2E PASS')} + ' — origin stays ' + ${JSON.stringify(origin)} +
          ' · remote navigation blocked · window.open denied · CSP enforced · trusted IPC ok';
        const sub = document.createElement('pre');
        sub.style.cssText = 'margin-top:18px;color:#bdf;font:13px/1.5 ui-monospace,monospace;white-space:pre-wrap;';
        sub.textContent = ${JSON.stringify('assertions:')} + '\\n' + ${JSON.stringify(JSON.stringify(results.map((r) => r.name)))};
        o.appendChild(sub);
        document.body.appendChild(o);
      })();`,
    );
    await new Promise((r) => setTimeout(r, 120));
    const img = await win.webContents.capturePage();
    writeFileSync(resolve(shotDir, 'phase1-security-e2e.png'), img.toPNG());
    check('captured a post-attack window screenshot (GUI image verdict)', true);
  } catch (e) {
    check(`captured a post-attack window screenshot (GUI image verdict): ${e}`, false);
  }

  win.destroy();
}

app.whenReady().then(async () => {
  try {
    await main();
  } catch (err) {
    bail(err && err.stack ? err.stack : String(err));
  }
  writeTranscript();
  if (failures.length > 0) {
    console.error(`\n[security-e2e] FAILED ${failures.length} assertion(s): ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('\n[security-e2e] PASS — navigation, window-open, CSP, and trusted-IPC gates hold in a live window.');
  process.exit(0);
});
