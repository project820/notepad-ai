import { app, shell } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { prewarmCliSpawnPath } from './ai/cli-runner';
import { resolveOcrAssetPaths, configureOcr } from './ai/ocr';
import { getRegistry } from './ai/provider-registry';
import { handleTrusted } from './ipc-guard';
import { FileGrants } from './file-grants';
import { KeyedMutex } from './keyed-mutex';
import { type IdentityFs } from './path-identity';
import { nodeAtomicBackend } from './atomic-write';
import { getSessionAggregate, markCleanExitQueued, resetSessionAggregate } from './session-store';
import { createWindowRegistry } from './window-registry';
import { ProjectWizardRootStore } from './project-wizard/access';
import { isAllowedExternalUrl } from './safe-external';
import { checkForUpdate } from './update-check';
import { abortChatsForWebContents, registerAiIpc } from './ipc/ai-ipc';
import { registerAuthIpc } from './ipc/auth-ipc';
import { registerFileIpc } from './ipc/file-ipc';
import { registerHtmlExportIpc } from './ipc/html-export-ipc';
import { registerOsIpc } from './ipc/os-ipc';
import { registerSessionIpc } from './ipc/session-ipc';
import { registerWizardIpc } from './ipc/wizard-ipc';
import { createConverterHost, convertDocument, registerConvertIpc } from './convert';
import { createAppWindows, configureAppIdentity } from './app-windows';
import { buildMenu } from './menu';

const registry = createWindowRegistry();
const fileGrants = new FileGrants();
const projectWizardRoots = new ProjectWizardRootStore();
const saveMutex = new KeyedMutex();
const nodeIdentityFs: IdentityFs = {
  realpath: (p) => fs.realpath(p),
  stat: async (p) => { const s = await fs.stat(p); return { dev: s.dev, ino: s.ino }; },
};
const documentAtomicBackend = nodeAtomicBackend();
configureAppIdentity();
const hasSingleInstanceLock = app.requestSingleInstanceLock();
const converterHost = createConverterHost();
const windows = createAppWindows({
  registry,
  fileGrants,
  projectWizardRoots,
  convertDocument: (ext, buf) => convertDocument(converterHost, ext, buf),
  abortChatsForWebContents,
  hasSingleInstanceLock,
});

// All IPC handlers are registered at module load, before app.whenReady().
registerFileIpc({ registry, fileGrants, identityFs: nodeIdentityFs, saveMutex, backend: documentAtomicBackend, windowFromRecord: windows.windowFromRecord, openFilePath: windows.openFilePath });
registerAuthIpc({ getRegistry });
registerAiIpc({ getRegistry });
registerWizardIpc({ fileGrants, projectWizardRoots, identityFs: nodeIdentityFs });
registerSessionIpc({ registry, sinkFor: windows.sinkFor });
registerConvertIpc({ converterHost });
handleTrusted('update:check', async () => checkForUpdate(app.getVersion()));
handleTrusted('app:version', () => app.getVersion());
handleTrusted('app:relaunch', () => { app.relaunch(); app.exit(0); });
handleTrusted('shell:open-external', async (_e, url: string) => { if (isAllowedExternalUrl(url)) await shell.openExternal(url); });
registerOsIpc();
registerHtmlExportIpc({ windowForWebContents: (id) => windows.windowFromRecord(registry.getByWebContents(id)) });

app.on('before-quit', () => {
  // Mark the aggregate as a clean exit so the next launch starts fresh (no restore).
  void markCleanExitQueued();

});
app.whenReady().then(async () => {
  void prewarmCliSpawnPath();
  const iconPath = path.resolve(__dirname, '../../build/icon.png');
  if (process.platform === 'darwin' && require('node:fs').existsSync(iconPath)) app.dock.setIcon(iconPath);
  try {
    configureOcr(resolveOcrAssetPaths({ appPath: app.getAppPath(), resourcesPath: process.resourcesPath, packaged: app.isPackaged }));
  } catch {
    /* OCR stays unconfigured; runOcr will surface an actionable error if invoked */
  }
  buildMenu({ createWindow: windows.createWindow, handleOpen: windows.handleOpen, sendToFocused: windows.sendToFocused });
  windows.setReady();
  const restored = await restorePreviousWindows();
  if (windows.hasPendingOpenFiles()) {
    windows.flushPendingOpenFiles();
  } else if (!restored) {
    const win = await windows.createWindow();
    windows.setLaunchWindowId(win.id);
  }
  app.on('activate', () => {
    if (registry.all().length === 0) void windows.createWindow().then((win) => windows.setLaunchWindowId(win.id));
  });
});

async function restorePreviousWindows(): Promise<boolean> {
  const prev = await getSessionAggregate();
  if (prev.cleanExit === true) { await resetSessionAggregate(); return false; }
  const candidates = prev.windows.filter((w) => (w.doc?.length ?? 0) > 0 || (w.unifiedChatHistory?.length ?? 0) > 0);
  if (candidates.length === 0) return false;
  for (const snap of candidates) await windows.createWindow({ restore: snap });
  console.log(`[session] restored windows=${candidates.length}`);
  return true;
}
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
