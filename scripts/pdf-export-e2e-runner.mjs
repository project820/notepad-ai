/**
 * pdf-export-e2e-runner.mjs — black-box PDF export check (#79).
 *
 * Boots the real app on an isolated userData, opens a long mixed Korean/English
 * document, switches the renderer to the dark theme, and drives the File >
 * Export as PDF… menu path with a stubbed save dialog. Asserts:
 *   - a canceled dialog writes nothing,
 *   - a saved export produces a multi-page A4 PDF at the chosen path,
 *   - the status line reports success,
 *   - the Markdown source on disk is unchanged,
 *   - a rich-preview edit still inside the sync debounce reaches the export,
 *   - the File menu item carries a localized label.
 */
import electron from 'electron';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { app, BrowserWindow, Menu, dialog, ipcMain } = electron;
const MENU_LABELS = { en: 'Export as PDF…', ko: 'PDF로 내보내기…', 'zh-Hans': '导出为 PDF…', 'zh-Hant': '匯出為 PDF…', ja: 'PDF として書き出す…' };

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
async function waitFor(name, predicate, timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await predicate().catch(() => null);
    if (value) return value;
    await delay(100);
  }
  throw new Error(`${name} timed out`);
}

function fixtureMarkdown() {
  const sections = Array.from({ length: 24 }, (_v, i) => [
    `## 섹션 ${i + 1} — Section ${i + 1}`,
    '',
    '다람쥐 헌 쳇바퀴에 타고파. The quick brown fox jumps over the lazy dog. **굵게**, *기울임*, ==형광펜==, `code`.',
    '',
    '- [x] 완료한 항목',
    '- [ ] 남은 항목',
    '',
    '| 항목 | 값 |',
    '| --- | --- |',
    `| 행 ${i + 1} | ${(i + 1) * 10} |`,
    '',
    '```ts',
    `const section = ${i + 1};`,
    '```',
    '',
  ].join('\n'));
  return `# PDF 내보내기 점검\n\n${sections.join('\n')}`;
}

async function main() {
  const userData = realpathSync(mkdtempSync(join(tmpdir(), 'notepad-ai-pdf-e2e-')));
  process.env.NOTEPAD_AI_USERDATA = userData;
  process.env.NOTEPAD_AI_INTEGRATION_TEST = '1';
  process.env.NOTEPAD_AI_HIDE_WINDOWS = '1';
  const docPath = join(userData, 'pdf-e2e.md');
  const markdown = fixtureMarkdown();
  writeFileSync(docPath, markdown, 'utf8');
  const target = join(userData, 'exported.pdf');

  let nextChoice = { canceled: true, filePath: undefined };
  let lastDefaultPath = null;
  dialog.showSaveDialog = async (_win, options) => {
    lastDefaultPath = options?.defaultPath ?? null;
    return nextChoice;
  };
  const exportedHtml = [];
  const originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => originalHandle(channel, channel !== 'pdf:export' ? listener : (event, request, ...rest) => {
    exportedHtml.push(typeof request?.html === 'string' ? request.html : '');
    return listener(event, request, ...rest);
  });

  require(resolve(REPO, 'dist/main/main.js'));
  app.emit('open-file', { preventDefault() {} }, docPath);
  await app.whenReady();
  const win = await waitFor('window', async () => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null);
  await waitFor('document loaded', () => win.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('.cm-line')).some((line) => (line.textContent || '').includes('PDF 내보내기 점검'))`,
  ));
  await win.webContents.executeJavaScript(`document.documentElement.dataset.theme = 'dark'; true`);
  const status = () => win.webContents.executeJavaScript(`document.getElementById('status')?.textContent || ''`);

  win.webContents.send('menu:export-pdf');
  await waitFor('cancel settles', async () => lastDefaultPath !== null && !(await status()).includes('…'));
  if (existsSync(target)) throw new Error('canceled export wrote a file');
  if (lastDefaultPath !== join(userData, 'pdf-e2e.pdf')) throw new Error(`unexpected default path ${lastDefaultPath}`);
  console.log('[pdf-export-e2e] cancel=PASS');

  nextChoice = { canceled: false, filePath: target };
  win.webContents.send('menu:export-pdf');
  await waitFor('pdf written', async () => existsSync(target) && (await status()).includes('exported.pdf'));
  const pdf = readFileSync(target);
  const text = pdf.toString('latin1');
  if (!text.startsWith('%PDF-')) throw new Error('output is not a PDF');
  const pages = text.match(/\/Type\s*\/Page(?!s)/g)?.length ?? 0;
  if (pages < 2) throw new Error(`expected a multi-page PDF, got ${pages}`);
  const box = text.match(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/);
  if (!box || Math.abs(Number(box[1]) - 595.28) > 1 || Math.abs(Number(box[2]) - 841.89) > 1) {
    throw new Error(`page size is not A4: ${box?.[0]}`);
  }
  if (readFileSync(docPath, 'utf8') !== markdown) throw new Error('export modified the Markdown source');
  console.log(`[pdf-export-e2e] save=PASS pages=${pages}`);
  if (process.env.NOTEPAD_AI_PDF_E2E_KEEP) writeFileSync(process.env.NOTEPAD_AI_PDF_E2E_KEEP, pdf);

  const marker = 'PDFLIVEEDIT';
  const liveTarget = join(userData, 'live-edit.pdf');
  nextChoice = { canceled: false, filePath: liveTarget };
  win.focus();
  win.webContents.focus();
  await win.webContents.executeJavaScript(`(() => {
    const preview = document.querySelector('.preview');
    const paragraph = preview?.querySelector('p');
    if (!preview || !paragraph) return false;
    preview.focus();
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  })()`);
  win.webContents.insertText(` ${marker}`);
  await waitFor('preview edit applied', () => win.webContents.executeJavaScript(`document.querySelector('.preview')?.textContent.includes('${marker}')`), 5_000);
  // Export inside the 350 ms preview-to-source debounce.
  win.webContents.send('menu:export-pdf');
  await waitFor('live-edit pdf written', async () => existsSync(liveTarget));
  if (!exportedHtml.at(-1)?.includes(marker)) throw new Error('export omitted a pending rich-preview edit');
  console.log('[pdf-export-e2e] pending-preview-edit=PASS');

  const lang = await win.webContents.executeJavaScript('document.documentElement.lang') || 'en';
  const expectedLabel = MENU_LABELS[lang];
  if (!expectedLabel) throw new Error(`unexpected renderer locale ${lang}`);
  const localized = await waitFor(`menu label ${expectedLabel}`, async () => {
    const current = Menu.getApplicationMenu()?.items.flatMap((top) => top.submenu?.items ?? [])
      .find((entry) => entry.accelerator === 'Shift+CmdOrCtrl+E');
    return current?.label === expectedLabel ? current.label : null;
  });
  console.log(`[pdf-export-e2e] menu-label=PASS (${localized})`);
  app.exit(0);
}

main().catch((error) => {
  console.error(`[pdf-export-e2e] failure: ${error?.stack ?? error}`);
  app.exit(2);
});
