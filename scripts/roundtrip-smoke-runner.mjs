/**
 * roundtrip-smoke-runner.mjs — crash-recovery gate for the built Electron app.
 *
 * The Node entrypoint orchestrates two independent Electron processes against one
 * isolated userData directory. Electron worker mode boots the built main entry,
 * so both phases exercise the production lifecycle rather than a synthetic
 * BrowserWindow. Phase 1 saves and snapshots a document, then the orchestrator
 * sends SIGKILL. Phase 2 boots fresh and verifies the restored renderer DOM.
 *
 * Run via: `npm run test:roundtrip-smoke`.
 */

import electron from 'electron';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const workerPhase = process.env.NOTEPAD_AI_ROUNDTRIP_PHASE;
const documentPath = process.env.NOTEPAD_AI_ROUNDTRIP_DOCUMENT;
const initialContent = '# Before\n\nOpened through the app.\n';
const editedContent = '# After\n\nEdited through CodeMirror.\n한글 ✅\n';

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitFor(name, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(`${name} timed out${lastError ? `: ${lastError}` : ''}`);
}

async function runElectronWorker(phase) {
  const { app, BrowserWindow } = electron;
  if (!documentPath) throw new Error('NOTEPAD_AI_ROUNDTRIP_DOCUMENT is required in Electron worker mode');
  const builtMain = resolve(REPO, 'dist/main/main.js');
  require(builtMain);
  if (phase === 'save') app.emit('open-file', { preventDefault() {} }, documentPath);
  await app.whenReady();
  const win = await waitFor('initial BrowserWindow creation', () => BrowserWindow.getAllWindows()[0] ?? null);
  await waitFor('renderer CodeMirror initialization', () =>
    win.webContents.executeJavaScript(`Boolean(document.querySelector('.cm-content'))`),
  );

  if (phase === 'save') {
    await waitFor('opened file reaches the rendered editor', () =>
      win.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('.cm-line')).map((line) => line.textContent || '').join('\\n').includes(${JSON.stringify('Opened through the app.')})`,
      ),
    );
    const liveWindowCount = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed()).length;
    if (liveWindowCount !== 1) throw new Error(`open-file startup created ${liveWindowCount} windows; expected exactly one`);
    console.log('[roundtrip-smoke] phase-1-open-file-window-count=1');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['meta'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['meta'] });
    await delay(30);
    win.webContents.insertText(editedContent);
    const renderedContent = await waitFor('CodeMirror edit', async () => {
      const text = await win.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('.cm-line')).map((line) => line.textContent || '').join('\\n')`,
      );
      return text === editedContent ? text : null;
    });
    const saveResult = await win.webContents.executeJavaScript(
      `window.api.saveFile(${JSON.stringify(documentPath)}, ${JSON.stringify(renderedContent)})`,
    );
    if (saveResult?.saved !== true || saveResult.filePath !== documentPath) throw new Error('file:save IPC did not report the saved document');
    await win.webContents.executeJavaScript(
      `window.api.sessionWrite(${JSON.stringify({ path: documentPath, title: 'roundtrip.md', doc: editedContent, dirty: false, savedAt: Date.now() })})`,
    );
    const sessionPath = join(app.getPath('userData'), 'session.json');
    await waitFor('durable session snapshot', () => {
      if (!existsSync(sessionPath)) return false;
      const aggregate = JSON.parse(readFileSync(sessionPath, 'utf8'));
      return aggregate.cleanExit === false && aggregate.windows?.some((entry) => entry.path === documentPath && entry.doc === editedContent);
    }, 60_000);
    console.log('[roundtrip-smoke] phase-1-ready: document saved and snapshot flushed');
    await new Promise(() => {});
  }

  if (phase === 'restore') {
    await waitFor('restore banner from the fresh process', () =>
      win.webContents.executeJavaScript(`Boolean(document.querySelector('.restore-yes'))`),
    );
    await win.webContents.executeJavaScript(`document.querySelector('.restore-yes')?.click()`);
    const restoredContent = await waitFor('restored document in the renderer DOM', async () => {
      const text = await win.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('.cm-line')).map((line) => line.textContent || '').join('\\n')`,
      );
      return text === editedContent ? text : null;
    });
    if (restoredContent !== editedContent) throw new Error('renderer DOM did not contain the restored document');
    console.log('[roundtrip-smoke] phase-2-recovered: fresh renderer DOM contains exact saved document');
    app.quit();
    return;
  }

  throw new Error(`unknown Electron worker phase: ${phase}`);
}

if (workerPhase) {
  void runElectronWorker(workerPhase).catch((error) => {
    console.error(`[roundtrip-smoke] worker failure: ${error?.stack ?? String(error)}`);
    process.exitCode = 2;
  });
} else {
  void (async () => {
  const userData = mkdtempSync(join(tmpdir(), 'notepad-ai-roundtrip-'));
  const roundtripDocument = join(userData, 'roundtrip.md');
  const children = new Set();
  const failures = [];

  function check(name, condition) {
    console.log(`  ${condition ? '✓' : '✗'} ${name}`);
    if (!condition) failures.push(name);
  }

  function launchPhase(phase) {
    const logs = [];
    const child = spawn(electronBinary, [fileURLToPath(import.meta.url)], {
      cwd: REPO,
      env: {
        ...process.env,
        NOTEPAD_AI_ROUNDTRIP_PHASE: phase,
        NOTEPAD_AI_USERDATA: userData,
        NOTEPAD_AI_INTEGRATION_TEST: '1',
        NOTEPAD_AI_HIDE_WINDOWS: '1',
        NOTEPAD_AI_ROUNDTRIP_DOCUMENT: roundtripDocument,
        ELECTRON_ENABLE_LOGGING: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => {
        const text = chunk.toString();
        logs.push(text);
        process.stdout.write(text);
      });
    }
    child.once('exit', () => children.delete(child));
    return { child, logs };
  }

  function waitForExit(child, timeoutMs = 15_000) {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolveExit, rejectExit) => {
      const timer = setTimeout(() => rejectExit(new Error('Electron process did not exit')), timeoutMs);
      child.once('exit', () => {
        clearTimeout(timer);
        resolveExit();
      });
    });
  }

  let exitCode = 0;
  try {
    const builtMain = resolve(REPO, 'dist/main/main.js');
    const builtRenderer = resolve(REPO, 'dist/renderer/index.html');
    if (!existsSync(builtMain)) throw new Error(`built main missing at ${builtMain} — run \`npm run build\` first`);
    if (!existsSync(builtRenderer)) throw new Error(`built renderer missing at ${builtRenderer} — run \`npm run build\` first`);
    writeFileSync(roundtripDocument, initialContent, 'utf8');

    console.log('[roundtrip-smoke] phase 1: launch, save, snapshot, crash');
    const first = launchPhase('save');
    await waitFor('phase 1 snapshot flush', () => first.logs.join('').includes('phase-1-ready'), 60_000);
    check('opened, edited, and saved through the production Electron app', first.logs.join('').includes('phase-1-ready'));
    check('early open-file delivery creates exactly one window', first.logs.join('').includes('phase-1-open-file-window-count=1'));
    check('saved file round-trips edited content byte-exactly', readFileSync(roundtripDocument).equals(Buffer.from(editedContent, 'utf8')));
    first.child.kill('SIGKILL');
    await waitForExit(first.child);
    check('phase 1 Electron process was terminated with SIGKILL', first.child.signalCode === 'SIGKILL');

    console.log('[roundtrip-smoke] phase 2: fresh launch and real renderer recovery');
    const second = launchPhase('restore');
    await waitForExit(second.child);
    check('restorePreviousWindows ran in a fresh Electron process', second.logs.join('').includes('[session] restored windows=1'));
    check('recovery assertion: fresh renderer DOM contains the exact saved document', second.logs.join('').includes('phase-2-recovered'));
    check('phase 2 completed a clean app.quit shutdown', second.child.exitCode === 0);

    if (failures.length > 0) {
      console.error(`\n[roundtrip-smoke] FAILED ${failures.length}: ${failures.join(', ')}`);
      exitCode = 1;
    } else {
      console.log('\n[roundtrip-smoke] PASS — crash recovery restored the saved document in a fresh Electron renderer.');
    }
  } catch (error) {
    console.error(`[roundtrip-smoke] ENV-FAIL (not a pass): ${error?.stack ?? String(error)}`);
    exitCode = 2;
  } finally {
    const pending = [...children];
    for (const child of pending) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    // Wait for killed children to actually exit so none still holds files under
    // userData when we remove it; otherwise rmSync races and throws ENOTEMPTY on
    // slower CI runners and turns an env timeout into a hard crash.
    await Promise.allSettled(pending.map((child) => waitForExit(child, 10_000).catch(() => {})));
    // Best-effort temp cleanup: a cleanup race must never turn the result into a crash.
    try {
      rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (cleanupError) {
      console.warn(`[roundtrip-smoke] temp cleanup skipped: ${cleanupError?.message ?? cleanupError}`);
    }
  }
  process.exitCode = exitCode;
  })();
}
