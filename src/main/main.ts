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
import { getSessionAggregate, markCleanExitQueued, mutateSessionAggregate, resetSessionAggregate } from './session-store';
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
import { removeWindowSnapshot } from './session-schema';
import { shouldUseMockKeychain } from './lifecycle-flags';
import { shouldPreventBeforeQuit } from './close-guard';
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
// Isolated integration runs must not touch the user's real macOS Keychain:
// every new/unsigned Electron binary can re-trigger the "Safe Storage" access
// prompt, creating a password-prompt storm. Chromium's mock keychain uses a
// known test password; encrypted blobs still persist in the isolated userData
// directory.
if (shouldUseMockKeychain(process.env)) app.commandLine.appendSwitch('use-mock-keychain');
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
  removeSessionWindow: async (windowKey) => {
    await mutateSessionAggregate((current) => removeWindowSnapshot(current, windowKey));
  },
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
handleTrusted('app:relaunch', async () => {
  if (!(await windows.approveAllForQuit())) {
    windows.clearCloseApprovals();
    return;
  }
  relaunchApproved = true;
  windows.preserveSessionOnClose();
  app.relaunch();
  app.quit();
});
handleTrusted('shell:open-external', async (_e, url: string) => { if (isAllowedExternalUrl(url)) await shell.openExternal(url); });
registerOsIpc();
registerHtmlExportIpc({ windowForWebContents: (id) => windows.windowFromRecord(registry.getByWebContents(id)) });

let quitGuardPending = false;
let quitApproved = false;
let relaunchApproved = false;

app.on('before-quit', (event) => {
  if (!shouldPreventBeforeQuit({ quitApproved, relaunchApproved })) return;
  // This must happen synchronously: native dialogs are async and Electron would
  // otherwise start tearing windows down underneath the pending dialog.
  event.preventDefault();
  if (quitGuardPending) return;
  quitGuardPending = true;
  void windows.approveAllForQuit().then(async (approved) => {
    if (!approved) {
      windows.clearCloseApprovals();
      return;
    }
    await markCleanExitQueued();
    quitApproved = true;
    app.quit();
  }).catch((error) => {
    windows.clearCloseApprovals();
    console.error('[close] quit guard failed:', error);
  }).finally(() => {
    quitGuardPending = false;
  });
});
app.whenReady().then(async () => {
  void prewarmCliSpawnPath();
  const iconPath = path.resolve(__dirname, '../../build/icon.png');
  if (process.platform === 'darwin' && require('node:fs').existsSync(iconPath)) app.dock?.setIcon(iconPath);
  try {
    configureOcr(resolveOcrAssetPaths({ appPath: app.getAppPath(), resourcesPath: process.resourcesPath, packaged: app.isPackaged }));
  } catch {
    /* OCR stays unconfigured; runOcr will surface an actionable error if invoked */
  }
  buildMenu({ createWindow: windows.createWindow, handleOpen: windows.handleOpen, sendToFocused: windows.sendToFocused });
  const restored = await restorePreviousWindows();
  if (windows.hasPendingOpenFiles()) {
    windows.setReady();
    windows.flushPendingOpenFiles();
  } else if (!restored) {
    await windows.createWindow({ isLaunchWindow: true });
    windows.setReady();
    if (windows.hasPendingOpenFiles()) windows.flushPendingOpenFiles();
  } else {
    windows.setReady();
    if (windows.hasPendingOpenFiles()) windows.flushPendingOpenFiles();
  }
  app.on('activate', () => {
    if (registry.all().length === 0) void windows.createWindow({ isLaunchWindow: true });
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
