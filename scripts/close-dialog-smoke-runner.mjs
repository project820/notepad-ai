import electron from 'electron';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scenario = process.env.NOTEPAD_AI_CLOSE_SMOKE_SCENARIO;
const shutdownPhase = process.env.NOTEPAD_AI_CLOSE_SMOKE_SHUTDOWN_PHASE;
const documentPath = process.env.NOTEPAD_AI_CLOSE_SMOKE_DOCUMENT;
const secondDocumentPath = process.env.NOTEPAD_AI_CLOSE_SMOKE_SECOND_DOCUMENT;

const shutdownPathContent = '# Shutdown path document\n\nLatest path revision.\n';
const shutdownUntitledContent = '# Shutdown untitled document\n\nLatest untitled revision.\n';

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
async function waitFor(name, predicate, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < until) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(`${name} timed out${lastError ? `: ${lastError}` : ''}`);
}

function editorText(win) {
  return win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.cm-line')).map((line) => line.textContent || '').join('\\n')`);
}

async function replaceEditorText(win, content) {
  await waitFor('editor', () => win.webContents.executeJavaScript(`Boolean(document.querySelector('.cm-content'))`));
  return waitFor('CodeMirror edit', async () => {
    win.focus();
    win.webContents.focus();
    win.webContents.selectAll();
    await delay(30);
    win.webContents.insertText(content);
    await delay(30);
    return (await editorText(win)) === content;
  }, 60_000);
}

function createFixture(userData) {
  const doc = join(userData, 'close-smoke.md');
  const secondDoc = join(userData, 'close-smoke-second.md');
  const largeDoc = join(userData, 'close-smoke-large.md');
  writeFileSync(doc, '# Close smoke\n', 'utf8');
  writeFileSync(secondDoc, '# Close smoke second\n', 'utf8');
  // Keep the large body intact — just dirty it so the close path renders/
  // preview-syncs the full ~90KB document, which is what used to loop.
  const largeBody = '# Close smoke large\n\n' + Array.from({ length: 1400 }, (_v, i) =>
    `- [ ] item ${i} — the quick brown fox jumps over the lazy dog, 다람쥐 헌 쳇바퀴에 타고파.`).join('\n') + '\n';
  writeFileSync(largeDoc, largeBody, 'utf8');
  return { doc, secondDoc, largeDoc };
}

async function worker() {
  const { app, BrowserWindow, Menu } = electron;
  require(resolve(REPO, 'dist/main/main.js'));
  const base = scenario.replace(/-large$/, '');
  app.emit('open-file', { preventDefault() {} }, documentPath);
  if (base.startsWith('quit')) app.emit('open-file', { preventDefault() {} }, secondDocumentPath);
  await app.whenReady();
  const win = await waitFor('window', () => BrowserWindow.getAllWindows()[0] ?? null);
  const dirtyWindows = base.startsWith('quit')
    ? await waitFor('two windows', () => BrowserWindow.getAllWindows().filter((candidate) => !candidate.isDestroyed()).length === 2 ? BrowserWindow.getAllWindows() : null)
    : [win];
  await Promise.all(dirtyWindows.map((dirtyWindow) => waitFor('editor', () =>
    dirtyWindow.webContents.executeJavaScript(`Boolean(document.querySelector('.cm-content'))`),
  )));
  for (const dirtyWindow of dirtyWindows) {
    if (scenario.endsWith('-large')) {
      dirtyWindow.webContents.insertText(`\nclose smoke ${scenario} ${dirtyWindow.id}\n`);
    } else {
      dirtyWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['meta'] });
      dirtyWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['meta'] });
      await delay(30);
      dirtyWindow.webContents.insertText(`close smoke ${scenario} ${dirtyWindow.id}`);
    }
  }
  await delay(100);

  if (base === 'cancel') {
    win.close();
    await delay(1_000);
    if (win.isDestroyed()) throw new Error('cancel closed the window');
    console.log('[close-dialog-smoke] cancel-kept-window');
    app.exit(0);
    return;
  }
  if (base === 'quit-cancel') {
    app.quit();
    await delay(1_000);
    if (dirtyWindows.some((dirtyWindow) => dirtyWindow.isDestroyed())) throw new Error('quit cancel closed a dirty window');
    console.log('[close-dialog-smoke] quit-cancel-kept-two-dirty-windows');
    app.exit(0);
    return;
  }
  if (base === 'quit-discard') {
    const closed = new Promise((resolveClosed) => app.once('window-all-closed', resolveClosed));
    app.quit();
    await Promise.race([
      closed,
      delay(10_000).then(() => { throw new Error('quit discard did not close both dirty windows'); }),
    ]);
    console.log('[close-dialog-smoke] quit-discard-closed-two-dirty-windows');
    return;
  }
  const closed = new Promise((resolveClosed) => win.once('closed', resolveClosed));
  win.close();
  await Promise.race([
    closed,
    delay(10_000).then(() => { throw new Error(`${scenario} did not close the window`); }),
  ]);
  console.log(`[close-dialog-smoke] ${scenario}-closed-window`);
  app.exit(0);
}

function clickNewWindow(Menu) {
  const fileMenu = Menu.getApplicationMenu()?.items.find((item) => item.label === 'File');
  const newItem = fileMenu?.submenu?.items.find((item) => item.label === 'New');
  if (!newItem?.click) throw new Error('File > New menu item is unavailable');
  newItem.click();
}

async function shutdownWorker() {
  const { app, BrowserWindow, Menu } = electron;
  require(resolve(REPO, 'dist/main/main.js'));
  await app.whenReady();

  if (shutdownPhase === 'first') {
    app.emit('open-file', { preventDefault() {} }, documentPath);
    const pathWindow = await waitFor('path window', () => BrowserWindow.getAllWindows()[0] ?? null);
    await replaceEditorText(pathWindow, shutdownPathContent);

    clickNewWindow(Menu);
    const untitledWindow = await waitFor('untitled window', () => {
      const windows = BrowserWindow.getAllWindows().filter((candidate) => !candidate.isDestroyed());
      return windows.length === 2 ? windows.find((candidate) => candidate.id !== pathWindow.id) ?? null : null;
    });
    await replaceEditorText(untitledWindow, shutdownUntitledContent);

    clickNewWindow(Menu);
    await waitFor('empty window', () => BrowserWindow.getAllWindows().filter((candidate) => !candidate.isDestroyed()).length === 3);
    await waitFor('shutdown trigger API', () => pathWindow.webContents.executeJavaScript(
      `typeof window.api.closeSmokeBeginShutdown === 'function'`,
    ));
    await pathWindow.webContents.executeJavaScript(`window.api.closeSmokeBeginShutdown()`);
    await new Promise((resolveClosed) => app.once('window-all-closed', resolveClosed));
    console.log('[close-dialog-smoke] shutdown-first-closed');
    return;
  }

  if (shutdownPhase === 'restore') {
    const restored = await waitFor('two restored windows', () => {
      const windows = BrowserWindow.getAllWindows().filter((candidate) => !candidate.isDestroyed());
      return windows.length === 2 ? windows : null;
    }, 30_000);
    await Promise.all(restored.map((win) => waitFor('restored editor', () =>
      win.webContents.executeJavaScript(`Boolean(document.querySelector('.cm-content'))`),
    )));
    const states = await Promise.all(restored.map(async (win) => ({
      win,
      text: await editorText(win),
      session: await win.webContents.executeJavaScript(`window.api.sessionGet()`),
      hasBanner: await win.webContents.executeJavaScript(`Boolean(document.querySelector('.restore-yes'))`),
    })));
    if (states.some((state) => state.hasBanner)) throw new Error('shutdown restore showed a crash recovery banner');
    const pathState = states.find((state) => state.text === shutdownPathContent);
    const untitledState = states.find((state) => state.text === shutdownUntitledContent);
    if (!pathState?.session?.snapshot?.path) throw new Error('path document was not immediately restored with its path');
    if (pathState.session.snapshot.dirty !== (process.env.NOTEPAD_AI_CLOSE_SMOKE_EXPECT_PATH_DIRTY === '1')) {
      throw new Error('path document dirty state was not immediately restored');
    }
    if (untitledState?.session?.snapshot?.path !== null || untitledState.session.snapshot.dirty !== true) {
      throw new Error('untitled dirty document was not immediately restored');
    }
    console.log('[close-dialog-smoke] shutdown-restore-observable-state');
    app.exit(0);
    return;
  }

  throw new Error(`unknown shutdown worker phase: ${shutdownPhase}`);
}

function spawnWorker(env) {
  return spawn(electronBinary, [fileURLToPath(import.meta.url)], {
    cwd: REPO,
    env: {
      ...process.env,
      ...env,
      NOTEPAD_AI_INTEGRATION_TEST: '1',
      NOTEPAD_AI_HIDE_WINDOWS: '1',
      ELECTRON_ENABLE_LOGGING: '1',
    },
    stdio: 'inherit',
  });
}

async function waitForWorker(name, env) {
  const child = spawnWorker(env);
  const code = await new Promise((resolveExit) => child.once('exit', resolveExit));
  if (code !== 0) throw new Error(`${name} worker exited ${code}`);
}

async function runShutdownPair(name, failFileSave) {
  const userData = mkdtempSync(join(tmpdir(), `notepad-ai-close-smoke-${name}-`));
  const { doc } = createFixture(userData);
  await waitForWorker(`${name} first`, {
    NOTEPAD_AI_CLOSE_SMOKE_SHUTDOWN_PHASE: 'first',
    NOTEPAD_AI_CLOSE_SMOKE_DOCUMENT: doc,
    NOTEPAD_AI_CLOSE_SMOKE_TRIGGER: 'shutdown',
    NOTEPAD_AI_CLOSE_DIALOG_CHOICE: 'fail',
    NOTEPAD_AI_SMOKE_FAIL_FILE_SAVE: failFileSave ? '1' : undefined,
    NOTEPAD_AI_USERDATA: userData,
  });

  if (!failFileSave && !readFileSync(doc).equals(Buffer.from(shutdownPathContent, 'utf8'))) {
    throw new Error(`${name} path document did not save byte-exactly`);
  }
  const aggregate = JSON.parse(readFileSync(join(userData, 'session.json'), 'utf8'));
  const contentWindows = aggregate.windows?.filter((entry) => (entry.doc?.length ?? 0) > 0) ?? [];
  if (aggregate.cleanExit !== false || aggregate.restoreReason !== 'shutdown') {
    throw new Error(`${name} session did not contain the shutdown restore marker`);
  }
  if (contentWindows.length !== 2 || aggregate.windows.length !== 2) {
    throw new Error(`${name} session did not exclude the empty window`);
  }
  const pathSnapshot = contentWindows.find((entry) => entry.path !== null);
  if (pathSnapshot?.doc !== shutdownPathContent) throw new Error(`${name} session lacks the latest path document`);
  if (failFileSave && pathSnapshot.dirty !== true) throw new Error(`${name} fault session lacks a dirty path document`);
  const untitledSnapshot = contentWindows.find((entry) => entry.path === null);
  if (untitledSnapshot?.doc !== shutdownUntitledContent || untitledSnapshot.dirty !== true) {
    throw new Error(`${name} session lacks the latest dirty untitled document`);
  }

  await waitForWorker(`${name} restore`, {
    NOTEPAD_AI_CLOSE_SMOKE_SHUTDOWN_PHASE: 'restore',
    NOTEPAD_AI_CLOSE_SMOKE_DOCUMENT: doc,
    NOTEPAD_AI_CLOSE_SMOKE_EXPECT_PATH_DIRTY: failFileSave ? '1' : '0',
    NOTEPAD_AI_USERDATA: userData,
  });
  console.log(`[close-dialog-smoke] ${name}=PASS`);
}

if (scenario) {
  void worker().catch((error) => {
    console.error(`[close-dialog-smoke] worker failure: ${error?.stack ?? error}`);
    process.exitCode = 2;
  });
} else if (shutdownPhase) {
  void shutdownWorker().catch((error) => {
    console.error(`[close-dialog-smoke] shutdown worker failure: ${error?.stack ?? error}`);
    process.exitCode = 2;
  });
} else {
  void (async () => {
    if (!existsSync(resolve(REPO, 'dist/main/main.js'))) throw new Error('dist/main/main.js missing; build the app before smoke execution');
    for (const choice of ['discard', 'save', 'cancel', 'quit-cancel', 'quit-discard', 'discard-large', 'save-large']) {
      const userData = mkdtempSync(join(tmpdir(), 'notepad-ai-close-smoke-'));
      const { doc, secondDoc, largeDoc } = createFixture(userData);
      const base = choice.replace(/-large$/, '');
      await waitForWorker(choice, {
        NOTEPAD_AI_CLOSE_SMOKE_SCENARIO: choice,
        NOTEPAD_AI_CLOSE_SMOKE_DOCUMENT: choice.endsWith('-large') ? largeDoc : doc,
        NOTEPAD_AI_CLOSE_SMOKE_SECOND_DOCUMENT: secondDoc,
        NOTEPAD_AI_CLOSE_DIALOG_CHOICE: base === 'quit-discard' ? 'discard' : base === 'quit-cancel' ? 'cancel' : base,
        NOTEPAD_AI_USERDATA: userData,
      });
      console.log(`[close-dialog-smoke] ${choice}=PASS`);
    }
    await runShutdownPair('shutdown-restore', false);
    await runShutdownPair('file-failure-restore', true);
  })().catch((error) => {
    console.error(`[close-dialog-smoke] failure: ${error?.stack ?? error}`);
    process.exitCode = 2;
  });
}
