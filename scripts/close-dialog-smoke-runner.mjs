import electron from 'electron';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scenario = process.env.NOTEPAD_AI_CLOSE_SMOKE_SCENARIO;
const documentPath = process.env.NOTEPAD_AI_CLOSE_SMOKE_DOCUMENT;
const secondDocumentPath = process.env.NOTEPAD_AI_CLOSE_SMOKE_SECOND_DOCUMENT;

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
async function waitFor(name, predicate, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await predicate();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`${name} timed out`);
}

async function worker() {
  const { app, BrowserWindow } = electron;
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
      // Keep the large body intact — just dirty it so the close path renders/
      // preview-syncs the full ~90KB document, which is what used to loop.
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

if (scenario) {
  void worker().catch((error) => {
    console.error(`[close-dialog-smoke] worker failure: ${error?.stack ?? error}`);
    process.exitCode = 2;
  });
} else {
  void (async () => {
    if (!existsSync(resolve(REPO, 'dist/main/main.js'))) throw new Error('dist/main/main.js missing; build the app before smoke execution');
    const userData = mkdtempSync(join(tmpdir(), 'notepad-ai-close-smoke-'));
    const doc = join(userData, 'close-smoke.md');
    const secondDoc = join(userData, 'close-smoke-second.md');
    const largeDoc = join(userData, 'close-smoke-large.md');
    writeFileSync(doc, '# Close smoke\n', 'utf8');
    writeFileSync(secondDoc, '# Close smoke second\n', 'utf8');
    // Regression guard for the large-document close loop: seed a ~90KB body so
    // the close path exercises the big-doc render/preview-sync route that used
    // to blow past the forward deadline and re-prompt the dialog forever.
    const largeBody = '# Close smoke large\n\n' + Array.from({ length: 1400 }, (_v, i) =>
      `- [ ] item ${i} — the quick brown fox jumps over the lazy dog, 다람쥐 헌 쳇바퀴에 타고파.`).join('\n') + '\n';
    writeFileSync(largeDoc, largeBody, 'utf8');
    for (const choice of ['discard', 'save', 'cancel', 'quit-cancel', 'quit-discard', 'discard-large', 'save-large']) {
      const base = choice.replace(/-large$/, '');
      const scenarioDoc = choice.endsWith('-large') ? largeDoc : doc;
      const child = spawn(electronBinary, [fileURLToPath(import.meta.url)], {
        cwd: REPO,
        env: {
          ...process.env,
          NOTEPAD_AI_CLOSE_SMOKE_SCENARIO: choice,
          NOTEPAD_AI_CLOSE_SMOKE_DOCUMENT: scenarioDoc,
          NOTEPAD_AI_CLOSE_SMOKE_SECOND_DOCUMENT: secondDoc,
          NOTEPAD_AI_CLOSE_DIALOG_CHOICE: base === 'quit-discard' ? 'discard' : base === 'quit-cancel' ? 'cancel' : base,
          NOTEPAD_AI_USERDATA: userData,
          NOTEPAD_AI_INTEGRATION_TEST: '1',
          NOTEPAD_AI_HIDE_WINDOWS: '1',
          ELECTRON_ENABLE_LOGGING: '1',
        },
        stdio: 'inherit',
      });
      const code = await new Promise((resolveExit) => child.once('exit', resolveExit));
      if (code !== 0) throw new Error(`${choice} worker exited ${code}`);
      console.log(`[close-dialog-smoke] ${choice}=PASS`);
    }
  })().catch((error) => {
    console.error(`[close-dialog-smoke] failure: ${error?.stack ?? error}`);
    process.exitCode = 2;
  });
}
