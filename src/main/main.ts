import { app, BrowserWindow, Menu, dialog, ipcMain, shell } from 'electron';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { startLogin, cancelLogin, getStatus, logout, type LoginUpdate } from './codex-auth';
import type { ChatTurn } from './codex-client';
import { getRegistry } from './ai/provider-registry';
import { isAiProviderId, type AiProviderId } from './ai/types';
import { readSession, writeSession, markCleanExit, clearSession, type SessionSnapshot } from './session-store';
import { isPromptAssemblyEnabled } from './prompts/toggle';
import { readSystemlaw } from './prompts/read-systemlaw';
import { readOwner } from './prompts/read-owner';
import {
  createContextStackLoader,
  createWizardService,
  isProjectWizardSaveApprovedDraftInput,
  isSafeAbsoluteProjectFolderPath,
} from './project-wizard/service';
import { nowInSeoulIso } from './project-wizard/time';
import { isAllowedExternalUrl } from './safe-external';

const APP_DISPLAY_NAME = 'Notepad AI';
const APP_STORAGE_NAME = 'notepad-ai';
const isDev = process.env.NODE_ENV === 'development';

let mainWindow: BrowserWindow | null = null;

function resolveAppIconPath(): string | undefined {
  const iconPath = path.resolve(__dirname, '../../build/icon.png');
  return existsSync(iconPath) ? iconPath : undefined;
}

function configureAppIdentity() {
  app.setPath('userData', path.join(app.getPath('appData'), APP_STORAGE_NAME));
  app.setName(APP_DISPLAY_NAME);
  app.setAboutPanelOptions({
    applicationName: APP_DISPLAY_NAME,
    applicationVersion: app.getVersion(),
  });
}

configureAppIdentity();

async function createWindow() {
  const windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: 1280,
    height: 820,
    minWidth: 920,
    minHeight: 560,
    title: APP_DISPLAY_NAME,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  };

  const iconPath = resolveAppIconPath();
  if (iconPath) windowOptions.icon = iconPath;

  mainWindow = new BrowserWindow(windowOptions);

  if (isDev) {
    await mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function buildMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'New',
          accelerator: 'CmdOrCtrl+N',
          click: () => mainWindow?.webContents.send('menu:new'),
        },
        {
          label: 'Open…',
          accelerator: 'CmdOrCtrl+O',
          click: () => handleOpen(),
        },
        { type: 'separator' },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () => mainWindow?.webContents.send('menu:save'),
        },
        {
          label: 'Save As…',
          accelerator: 'Shift+CmdOrCtrl+S',
          click: () => mainWindow?.webContents.send('menu:save-as'),
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Preview',
          accelerator: 'CmdOrCtrl+P',
          click: () => mainWindow?.webContents.send('menu:toggle-preview'),
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'close' }],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const CONVERTIBLE_EXTS = new Set(['hwp', 'hwpx', 'hwpml', 'docx', 'pdf', 'xlsx', 'xls']);

/**
 * Smarter conversion from kordoc IR blocks → Markdown.
 *
 * kordoc's `blocksToMarkdown` classifies almost every HWP paragraph as H1,
 * which produces visually broken documents. We re-interpret the blocks
 * using Korean-document conventions:
 *   - `□` / `■` prefix → section heading (H2)
 *   - `ㅇ` / `o` / `○` / `●` / `▶` / `※` / `·` prefix → bullet list item
 *   - "heading" blocks that match none of the above → plain paragraph
 *     (kordoc misclassification)
 *   - tables → render from IR cells with proper rowspan/colspan handling
 */
type KordocBlock = {
  type: 'paragraph' | 'table' | 'heading' | 'list' | 'image' | 'separator';
  text?: string;
  level?: number;
  listType?: 'ordered' | 'unordered';
  table?: {
    rows: number;
    cols: number;
    cells: Array<Array<{ text: string; colSpan: number; rowSpan: number }>>;
    hasHeader: boolean;
  };
};

const SECTION_PREFIX = /^[□■◆◇▣▤▥▦▧▨▩]\s+/;
const BULLET_PREFIX = /^[oO○●ㅇ▶▷※·•・◦‣⁃-]\s+/;

function classifyHeadingText(text: string): 'section' | 'bullet' | 'paragraph' {
  const t = text.trimStart();
  if (SECTION_PREFIX.test(t)) return 'section';
  if (BULLET_PREFIX.test(t)) return 'bullet';
  return 'paragraph';
}

function renderTable(t: KordocBlock['table']): string {
  if (!t || t.cells.length === 0) return '';
  const cells = t.cells;
  const cols = t.cols;
  // Flatten each row's cells to text; collapse to one MD row.
  const rows = cells.map((row) =>
    row.map((c) => (c.text ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim() || ' '),
  );
  if (rows.length === 0) return '';
  const header = rows[0];
  const body = rows.slice(1);
  // Normalize all rows to same column count
  const norm = (r: string[]) => {
    if (r.length === cols) return r;
    if (r.length > cols) return r.slice(0, cols);
    return [...r, ...Array(cols - r.length).fill(' ')];
  };
  const out: string[] = [];
  out.push('| ' + norm(header).join(' | ') + ' |');
  out.push('| ' + Array(cols).fill('---').join(' | ') + ' |');
  for (const r of body) out.push('| ' + norm(r).join(' | ') + ' |');
  return out.join('\n');
}

function blocksToCleanMarkdown(blocks: KordocBlock[]): string {
  const out: string[] = [];
  let prevWasList = false;
  for (const b of blocks) {
    if (b.type === 'separator') {
      out.push('', '---', '');
      prevWasList = false;
      continue;
    }
    if (b.type === 'image') {
      // Inline images aren't preserved in MD reliably; skip with a hint.
      out.push('', '<!-- (image) -->', '');
      prevWasList = false;
      continue;
    }
    if (b.type === 'table' && b.table) {
      out.push('', renderTable(b.table), '');
      prevWasList = false;
      continue;
    }
    const text = (b.text ?? '').trim();
    if (!text) continue;

    if (b.type === 'heading') {
      const klass = classifyHeadingText(text);
      if (klass === 'section') {
        // Strip the section glyph, render as H2
        const stripped = text.replace(SECTION_PREFIX, '').trim();
        out.push('', `## ${stripped}`, '');
        prevWasList = false;
      } else if (klass === 'bullet') {
        const stripped = text.replace(BULLET_PREFIX, '').trim();
        if (!prevWasList) out.push('');
        out.push(`- ${stripped}`);
        prevWasList = true;
      } else {
        // Genuine paragraph that kordoc misclassified.
        if (b.level && b.level >= 2 && b.level <= 6) {
          // Respect explicit H2/H3/etc. if present
          out.push('', `${'#'.repeat(b.level)} ${text}`, '');
          prevWasList = false;
        } else {
          out.push('', text, '');
          prevWasList = false;
        }
      }
      continue;
    }
    if (b.type === 'list') {
      out.push(`- ${text}`);
      prevWasList = true;
      continue;
    }
    // paragraph
    if (BULLET_PREFIX.test(text)) {
      const stripped = text.replace(BULLET_PREFIX, '').trim();
      if (!prevWasList) out.push('');
      out.push(`- ${stripped}`);
      prevWasList = true;
    } else if (SECTION_PREFIX.test(text)) {
      const stripped = text.replace(SECTION_PREFIX, '').trim();
      out.push('', `## ${stripped}`, '');
      prevWasList = false;
    } else {
      out.push('', text, '');
      prevWasList = false;
    }
  }
  // Collapse 3+ blank lines into 2
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

async function handleOpen() {
  if (!mainWindow) return;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Documents', extensions: ['md', 'markdown', 'mdx', 'txt', 'hwp', 'hwpx', 'hwpml', 'docx', 'pdf', 'xlsx', 'xls'] },
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdx'] },
      { name: 'Korean / Office', extensions: ['hwp', 'hwpx', 'hwpml', 'docx', 'pdf', 'xlsx', 'xls'] },
      { name: 'Text', extensions: ['txt'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return;
  const filePath = result.filePaths[0];
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  if (CONVERTIBLE_EXTS.has(ext)) {
    console.log(`[kordoc] converting ${ext.toUpperCase()}: ${filePath}`);
    mainWindow.webContents.send('file:opened', {
      filePath: null,
      content: '',
      // Status-only — used to display a progress hint while parsing.
      error: undefined,
      progress: `Converting ${ext.toUpperCase()}…`,
    });
    try {
      const buf = await fs.readFile(filePath);
      console.log(`[kordoc] read ${buf.length} bytes from ${filePath}`);
      // CRITICAL: kordoc's CJS build is broken (uses import.meta.url which is
      // ESM-only), so require() throws SyntaxError. We must use a NATIVE
      // dynamic import() so Node resolves the package's ESM entry.
      // TypeScript with `module: CommonJS` would transpile `import('kordoc')`
      // into `require('kordoc')` — we sidestep that by hiding the call inside
      // `new Function`, which TS cannot rewrite.
      const nativeImport: (s: string) => Promise<any> =
        new Function('s', 'return import(s)') as any;
      const kordoc = await nativeImport('kordoc');
      const parseFn = kordoc.parse ?? kordoc.default?.parse;
      const renderHtml = kordoc.renderHtml ?? kordoc.default?.renderHtml;
      console.log(
        `[kordoc] module loaded, parse=${typeof parseFn}, renderHtml=${typeof renderHtml}`,
      );
      if (typeof parseFn !== 'function') {
        throw new Error('kordoc.parse not found in module exports');
      }
      const r = await parseFn(buf, { removeHeaderFooter: true });
      console.log(`[kordoc] result success=${r.success} fileType=${r.fileType} mdLen=${r.success ? r.markdown.length : 0}`);
      if (r.success) {
        // Pipeline (per kordoc maintainers' best practice for visual fidelity):
        //   parse → renderHtml('gov-formal') → send HTML to renderer
        //   Renderer runs Turndown on that HTML to derive cleaner MD source.
        // Fall back to raw markdown if renderHtml isn't available.
        let html: string | undefined;
        if (typeof renderHtml === 'function') {
          try {
            html = renderHtml(r.markdown, { preset: 'gov-formal' });
          } catch (e: any) {
            console.warn('[kordoc] renderHtml failed, falling back:', e?.message);
          }
        }
        const baseName = filePath.replace(/\.[^/.]+$/, '.md');
        mainWindow.webContents.send('file:opened', {
          filePath: baseName,
          content: r.markdown,           // fallback raw markdown
          html,                          // preferred — renderer will turndown this
          converted: { from: ext.toUpperCase(), originalPath: filePath },
        });
      } else {
        const msg = ('error' in r && (r as any).error?.message) ?? 'unknown error';
        mainWindow.webContents.send('file:opened', {
          filePath: null,
          content: '',
          error: `Could not convert ${ext.toUpperCase()}: ${msg}`,
        });
      }
    } catch (e: any) {
      console.error('[kordoc] threw:', e);
      mainWindow.webContents.send('file:opened', {
        filePath: null,
        content: '',
        error: `Failed to convert ${ext.toUpperCase()}: ${e?.message ?? e}`,
      });
    }
    return;
  }
  const content = await fs.readFile(filePath, 'utf-8');
  mainWindow.webContents.send('file:opened', { filePath, content });
}

ipcMain.handle('file:save', async (_event, args: { filePath: string | null; content: string }) => {
  let target = args.filePath;
  if (!target) {
    if (!mainWindow) return { saved: false };
    const result = await dialog.showSaveDialog(mainWindow, {
      filters: [{ name: 'Markdown', extensions: ['md'] }],
      defaultPath: 'untitled.md',
    });
    if (result.canceled || !result.filePath) return { saved: false };
    target = result.filePath;
  }
  await fs.writeFile(target, args.content, 'utf-8');
  return { saved: true, filePath: target };
});

ipcMain.handle('file:open-path', async (_event, filePath: string) => {
  const content = await fs.readFile(filePath, 'utf-8');
  return { filePath, content };
});

// ---------- Codex OAuth IPC ----------

ipcMain.handle('auth:status', async () => getStatus());

ipcMain.handle('auth:login', async (event) => {
  const sender = event.sender;
  return new Promise<void>((resolve) => {
    void startLogin((update: LoginUpdate) => {
      sender.send('auth:login-update', update);
      if (update.kind === 'success' || update.kind === 'error') resolve();
    });
  });
});

ipcMain.handle('auth:cancel-login', async () => {
  cancelLogin();
});

ipcMain.handle('auth:logout', async () => {
  await logout();
});

ipcMain.handle('auth:providers-status', async () => getRegistry().getAuthStatuses());

ipcMain.handle('auth:has-any', async () => getRegistry().hasAnyAuth());

ipcMain.handle('auth:set-api-key', async (_e, args: { provider: AiProviderId; key: string }) => {
  if (!isAiProviderId(args?.provider)) throw new Error('Unknown provider');
  return getRegistry().setApiKey(args.provider, args.key);
});

ipcMain.handle('auth:delete-provider-key', async (_e, provider: AiProviderId) => {
  if (!isAiProviderId(provider)) throw new Error('Unknown provider');
  await getRegistry().deleteApiKey(provider);
});

// ---------- AI Chat IPC (streaming) ----------

const activeChats = new Map<string, AbortController>();

ipcMain.handle(
  'ai:chat',
  async (
    event,
    payload: {
      id: string;
      instructions: string;
      history: ChatTurn[];
      userText: string;
      model?: string | { provider: AiProviderId; id: string };
    },
  ) => {
    const controller = new AbortController();
    activeChats.set(payload.id, controller);
    const sender = event.sender;
    const model =
      typeof payload.model === 'string'
        ? { provider: 'chatgpt' as AiProviderId, id: payload.model }
        : payload.model && isAiProviderId(payload.model.provider)
          ? payload.model
          : { provider: 'chatgpt' as AiProviderId, id: 'gpt-5.4-mini' };
    try {
      await getRegistry().streamProviderChat(
        {
          instructions: payload.instructions,
          history: payload.history,
          userText: payload.userText,
          model,
          signal: controller.signal,
        },
        (e) => sender.send(`ai:chat:${payload.id}`, e),
      );
    } finally {
      activeChats.delete(payload.id);
    }
  },
);

ipcMain.handle('ai:cancel', async (_e, id: string) => {
  activeChats.get(id)?.abort();
  activeChats.delete(id);
});

ipcMain.handle('ai:models', async () => getRegistry().getAvailableModels());

// ---------- Prompt-assembly context IPC (v1.1 Phase 1) ----------

function makeProjectWizardService() {
  const userDataPath = app.getPath('userData');
  return createWizardService({
    userDataPath,
    fs,
    now: () => nowInSeoulIso(),
    loadContextStack: createContextStackLoader(userDataPath, fs),
  });
}

ipcMain.handle('project-wizard:start', async (_e, projectFolder: string) =>
  makeProjectWizardService().start(await requireProjectFolder(projectFolder)),
);

ipcMain.handle('project-wizard:save-approved-draft', async (_e, input) => {
  if (!isProjectWizardSaveApprovedDraftInput(input)) {
    throw new Error('Invalid project wizard draft payload');
  }
  const projectFolder = await requireProjectFolder(input.projectFolder);
  return makeProjectWizardService().saveApprovedDraft({ ...input, projectFolder });
});

async function requireProjectFolder(projectFolder: unknown): Promise<string> {
  if (!isSafeAbsoluteProjectFolderPath(projectFolder)) {
    throw new Error('Invalid project folder path');
  }
  const stat = await fs.stat(projectFolder);
  if (!stat.isDirectory()) {
    throw new Error('Project folder path is not a directory');
  }
  return projectFolder;
}

/**
 * Returns the current state of the v1.1 prompt-assembly feature toggle
 * together with the pre-loaded userData file contents that the renderer needs
 * to call `buildBlockAiInstructions` (and equivalent handlers on the other
 * three AI surfaces).
 *
 * When the toggle is OFF the file contents are empty strings — no filesystem
 * reads are performed — so the IPC cost when toggle is off is minimal.
 *
 * Graceful fallback: any I/O error causes the handler to return
 * `{ enabled: false, systemlawContent: '', ownerContent: '' }` rather than
 * propagating the error to the renderer.  The renderer treats this as "legacy
 * path" and proceeds without crashing.
 */
ipcMain.handle('prompt:assembly-context', async () => {
  const enabled = isPromptAssemblyEnabled();
  if (!enabled) {
    // Toggle off — skip filesystem reads; return minimal context.
    return { enabled: false, systemlawContent: '', ownerContent: '' };
  }
  try {
    const userDataPath = app.getPath('userData');
    const [systemlawContent, ownerContent] = await Promise.all([
      readSystemlaw(userDataPath),
      readOwner(userDataPath),
    ]);
    return { enabled, systemlawContent, ownerContent };
  } catch {
    // Unexpected error — fall back to legacy path to avoid crashing the renderer.
    return { enabled: false, systemlawContent: '', ownerContent: '' };
  }
});

// ---------- Session snapshot IPC ----------

ipcMain.handle('session:get', async () => readSession());
ipcMain.handle('session:write', async (_e, snap: SessionSnapshot) => writeSession(snap));
ipcMain.handle('session:clear', async () => clearSession());

app.on('before-quit', () => {
  // Best-effort: mark current snapshot as clean exit
  void markCleanExit();
});

app.whenReady().then(async () => {
  const iconPath = resolveAppIconPath();
  if (process.platform === 'darwin' && iconPath) {
    app.dock.setIcon(iconPath);
  }

  buildMenu();
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
