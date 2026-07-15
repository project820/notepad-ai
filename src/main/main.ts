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
import { registerProviderAuthIpc } from './ipc/provider-auth-ipc';
import { registerFileIpc } from './ipc/file-ipc';
import { registerHtmlExportIpc } from './ipc/html-export-ipc';
import { registerHtmlExportAssetIpc } from './ipc/html-export-asset-ipc';
import { HtmlExportAttemptRegistry } from './html-export-attempt-registry';
import { HtmlExportAssetRegistry } from './html-export-asset-registry';
import { HtmlExportParseHost } from './html-export-parse-host';
import { HtmlExportPipelineService } from './html-export-pipeline-service';
import { bundleSanitizedHtml } from './html-export-shell';
import { HtmlExportQuarantinePool } from './html-export-quarantine';
import { ElectronQuarantineHost } from './html-export-quarantine-host';
import { createHtmlExportGenerator } from './html-export-generate';
import { htmlExportMaxTokens } from './ai/output-budget';
import {
  createHtmlExportQuarantineError,
  type HtmlExportAttemptId,
  type ResolvedArtifactId,
} from '../shared/html-export-pipeline';
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
const nodeIdentityFs: IdentityFs = {
  realpath: (p) => fs.realpath(p),
  stat: async (p) => {
    const stat = await fs.stat(p, { bigint: true });
    return {
      dev: stat.dev,
      ino: stat.ino,
      isFile: () => stat.isFile(),
      isDirectory: () => stat.isDirectory(),
    };
  },
  lstat: async (p) => {
    const stat = await fs.lstat(p, { bigint: true });
    return {
      dev: stat.dev,
      ino: stat.ino,
      isFile: () => stat.isFile(),
      isDirectory: () => stat.isDirectory(),
    };
  },
};
const fileGrants = new FileGrants(nodeIdentityFs);
const projectWizardRoots = new ProjectWizardRootStore();
const saveMutex = new KeyedMutex();
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
const htmlExportAttemptRegistry = new HtmlExportAttemptRegistry();
const htmlExportAssetRegistry = new HtmlExportAssetRegistry({
  isAttemptActive: (owner) => htmlExportAttemptRegistry.getActiveAttempt(owner.webContentsId) === owner.attemptId,
});
const htmlExportParseHost = new HtmlExportParseHost();
const htmlExportPipelineService = new HtmlExportPipelineService({
  registry: htmlExportAttemptRegistry,
  parseHost: htmlExportParseHost,
  resolver: async (payload) => bundleSanitizedHtml(payload).html,
});
// The pre-finalization quarantine pool is additive (PR-S3b) and not wired into
// the live wizard. Its Electron host is constructed after app.whenReady(); the
// module-level holder lets the IPC layer resolve it lazily.
let htmlExportQuarantinePool: HtmlExportQuarantinePool | undefined;
const htmlExportQuarantine = {
  measure: (webContentsId: number, attemptId: HtmlExportAttemptId, resolvedArtifactId: ResolvedArtifactId) =>
    htmlExportQuarantinePool
      ? htmlExportQuarantinePool.measure(webContentsId, attemptId, resolvedArtifactId)
      : Promise.resolve({
          ok: false as const,
          error: createHtmlExportQuarantineError('quarantine-unavailable'),
        }),
  cancelWebContents: (webContentsId: number) => htmlExportQuarantinePool?.cancelWebContents(webContentsId),
  cancelAttempt: (webContentsId: number, attemptId: HtmlExportAttemptId) =>
    htmlExportQuarantinePool?.cancelAttempt(webContentsId, attemptId),
};

const htmlExportGenerator = createHtmlExportGenerator({
  pipeline: htmlExportPipelineService,
  stream: (req, onEvent) => getRegistry().streamProviderChat(req, onEvent),
  maxOutputTokens: (m) => htmlExportMaxTokens(m.provider, m.id),
  quarantine: async ({ webContentsId, attemptId, resolvedArtifactId, signal }) => {
    const onAbort = () => htmlExportQuarantine.cancelAttempt(webContentsId, attemptId);
    if (signal.aborted) {
      onAbort();
      return { ok: false as const, kind: 'quarantine-cancelled' as const };
    }
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const measured = await htmlExportQuarantine.measure(webContentsId, attemptId, resolvedArtifactId);
      if (!measured.ok) return { ok: false as const, kind: measured.error.kind };
      // The quarantine gate must reject a document that renders but overflows its
      // viewport horizontally (a broken/uncontained layout) — otherwise an
      // overflowing export is finalized as a success. See #29 review (P1).
      if (measured.value.measurement.horizontalOverflow) {
        return { ok: false as const, kind: 'layout-violation' as const };
      }
      return { ok: true as const };
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  },
  resolveTransport: async (m) => {
    if (m.provider === 'grok') {
      const g = getRegistry().getProvider('grok');
      if (g && typeof (g as { htmlSurfaceTransport?: unknown }).htmlSurfaceTransport === 'function') {
        return (g as unknown as { htmlSurfaceTransport(): Promise<'api' | 'cli'> }).htmlSurfaceTransport();
      }
    }
    return undefined;
  },
});
const testCloseChoice = process.env.NOTEPAD_AI_CLOSE_DIALOG_CHOICE;
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
  removeSessionWindows: async (windowKeys) => {
    await mutateSessionAggregate((current) => windowKeys.reduce(removeWindowSnapshot, current));
  },
  commitQuitSession: (windowKeys) => markCleanExitQueued(windowKeys),
  showCloseDialog: process.env.NOTEPAD_AI_INTEGRATION_TEST === '1'
    && (testCloseChoice === 'save' || testCloseChoice === 'discard' || testCloseChoice === 'cancel')
    ? async () => testCloseChoice
    : undefined,
});

// All IPC handlers are registered at module load, before app.whenReady().
registerFileIpc({ registry, fileGrants, identityFs: nodeIdentityFs, saveMutex, backend: documentAtomicBackend, windowFromRecord: windows.windowFromRecord, openFilePath: windows.openFilePath });
registerAuthIpc({ getRegistry });
registerAiIpc({ getRegistry });
registerProviderAuthIpc({ getRegistry });
registerWizardIpc({ fileGrants, projectWizardRoots, identityFs: nodeIdentityFs });
registerSessionIpc({ registry, sinkFor: windows.sinkFor, isSessionWriteFenced: windows.isSessionWriteFenced });
registerConvertIpc({ converterHost });
handleTrusted('update:check', async () => checkForUpdate(app.getVersion()));
handleTrusted('app:version', () => app.getVersion());
handleTrusted('app:relaunch', async () => {
  if (await windows.approveAllForQuit('relaunch')) {
    relaunchApproved = true;
    app.relaunch();
    app.quit();
  }
});
handleTrusted('shell:open-external', async (_e, url: string) => { if (isAllowedExternalUrl(url)) await shell.openExternal(url); });
registerOsIpc();
registerHtmlExportIpc({
  windowForWebContents: (id) => windows.windowFromRecord(registry.getByWebContents(id)),
  pipelineService: htmlExportPipelineService,
  assetLifecycle: {
    getActiveAttempt: (id) => htmlExportAttemptRegistry.getActiveAttempt(id),
    invalidateAttempt: (owner) => htmlExportAssetRegistry.invalidateAttempt(owner),
    releaseWebContents: (id) => htmlExportAssetRegistry.releaseWebContents(id),
  },
  quarantine: htmlExportQuarantine,
  generateHtml: (webContentsId, input) => htmlExportGenerator.run(webContentsId, input),
  cancelGenerateHtml: (webContentsId) => htmlExportGenerator.cancel(webContentsId),
});
registerHtmlExportAssetIpc({
  windowForWebContents: (id) => windows.windowFromRecord(registry.getByWebContents(id)),
  currentDocumentPathForWebContents: (id) => registry.getByWebContents(id)?.currentPath,
  fileGrants,
  assetRegistry: htmlExportAssetRegistry,
  attemptRegistry: htmlExportAttemptRegistry,
});

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
  void windows.approveAllForQuit('quit').then((approved) => {
    if (!approved) return;
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
  // Construct the additive quarantine pool now that Electron is ready. It stays
  // unwired from the live wizard (PR-S3b); only the html:quarantine:measure IPC
  // reaches it.
  htmlExportQuarantinePool = new HtmlExportQuarantinePool({
    registry: htmlExportAttemptRegistry,
    host: new ElectronQuarantineHost(),
  });
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
