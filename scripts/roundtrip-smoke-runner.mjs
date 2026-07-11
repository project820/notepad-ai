/**
 * roundtrip-smoke-runner.mjs — REAL-window document roundtrip gate (G004).
 *
 * Boots the built application with an isolated temporary userData directory,
 * opens a temporary Markdown file through the app's normal macOS `open-file`
 * route, edits it in the rendered CodeMirror surface, and saves through the
 * exposed renderer API (the real `file:save` IPC handler). It then writes a
 * session snapshot through `session:write` and verifies its durable
 * userData/session.json aggregate.
 *
 * Electron cannot safely relaunch its primary app instance from inside this
 * runner without terminating the runner itself. The recovery assertion therefore
 * verifies the durable snapshot that `main.ts` consumes on the next launch,
 * rather than attempting a synthetic in-process relaunch.
 *
 * Exit NONZERO on any assertion failure or an unavailable built app.
 * Run via: `npm run test:roundtrip-smoke`.
 */

import { app, BrowserWindow } from 'electron';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const userData = mkdtempSync(join(tmpdir(), 'notepad-ai-roundtrip-'));
const documentPath = join(userData, 'roundtrip.md');
const initialContent = '# Before\n\nOpened through the app.\n';
const editedContent = '# After\n\nEdited through CodeMirror.\n한글 ✅\n';
const failures = [];

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', userData);

function check(name, condition) {
  console.log(`  ${condition ? '✓' : '✗'} ${name}`);
  if (!condition) failures.push(name);
}

function bail(message) {
  console.error(`[roundtrip-smoke] ENV-FAIL (not a pass): ${message}`);
  process.exit(2);
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitFor(name, predicate, timeoutMs = 10_000) {
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

function cleanup() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.destroy();
  }
  rmSync(userData, { recursive: true, force: true });
}

async function main() {
  const builtMain = resolve(REPO, 'dist/main/main.js');
  const builtRenderer = resolve(REPO, 'dist/renderer/index.html');
  if (!existsSync(builtMain)) bail(`built main missing at ${builtMain} — run \`npm run build\` first`);
  if (!existsSync(builtRenderer)) bail(`built renderer missing at ${builtRenderer} — run \`npm run build\` first`);

  writeFileSync(documentPath, initialContent, 'utf8');

  // main.ts calls configureAppIdentity at module load; restore the temporary path
  // before Electron becomes ready so every app store, including session.json, stays isolated.
  require(builtMain);
  app.setPath('userData', userData);

  await app.whenReady();
  const win = await waitFor('initial BrowserWindow creation', () => BrowserWindow.getAllWindows()[0] ?? null);
  await waitFor('renderer CodeMirror initialization', () =>
    win.webContents.executeJavaScript(`Boolean(document.querySelector('.cm-content'))`),
  );

  // This is the production OS document-open event handled by createAppWindows.
  app.emit('open-file', { preventDefault() {} }, documentPath);
  await waitFor('opened file reaches the rendered editor', () =>
    win.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('.cm-line')).map((line) => line.textContent || '').join('\\n').includes(${JSON.stringify('Opened through the app.')})`,
    ),
  );
  check('opened a temporary Markdown file through the app open-file route', true);

  await win.webContents.executeJavaScript(`document.querySelector('.cm-content')?.focus()`);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['meta'] });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['meta'] });
  await delay(30);
  win.webContents.insertText(editedContent);

  const renderedContent = await waitFor('CodeMirror edit', async () => {
    const content = await win.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('.cm-line')).map((line) => line.textContent || '').join('\\n')`,
    );
    return content === editedContent ? content : null;
  });
  check('edited content is present in the rendered CodeMirror document', renderedContent === editedContent);

  const saveResult = await win.webContents.executeJavaScript(
    `window.api.saveFile(${JSON.stringify(documentPath)}, ${JSON.stringify(renderedContent)})`,
  );
  check('saved the rendered edit through the real file:save IPC', saveResult?.saved === true && saveResult?.filePath === documentPath);
  const savedBytes = readFileSync(documentPath);
  check('saved file round-trips edited content byte-exactly', savedBytes.equals(Buffer.from(editedContent, 'utf8')));

  const snapshot = {
    path: documentPath,
    title: 'roundtrip.md',
    doc: editedContent,
    dirty: false,
    savedAt: Date.now(),
  };
  await win.webContents.executeJavaScript(`window.api.sessionWrite(${JSON.stringify(snapshot)})`);
  const sessionPath = join(userData, 'session.json');
  await waitFor('durable session.json write', () => existsSync(sessionPath));
  const aggregate = JSON.parse(readFileSync(sessionPath, 'utf8'));
  const restoredWindow = Array.isArray(aggregate.windows)
    ? aggregate.windows.find((entry) => entry?.path === documentPath && entry?.doc === editedContent)
    : null;
  check('session persistence contains the document state consumed on next launch', aggregate.cleanExit === false && !!restoredWindow);
}

app.whenReady().then(async () => {
  try {
    await main();
  } catch (error) {
    bail(error?.stack ?? String(error));
  } finally {
    cleanup();
  }

  if (failures.length > 0) {
    console.error(`\n[roundtrip-smoke] FAILED ${failures.length}: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('\n[roundtrip-smoke] PASS — open, edit, save, and durable session recovery state hold in a live window.');
  process.exit(0);
});
