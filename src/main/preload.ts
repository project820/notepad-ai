import { contextBridge, ipcRenderer } from 'electron';
import type { AiProviderId, ModelRef, ProviderAuthStatus } from './ai/types';
import type { FileTreeEntry } from '../shared/file-types';

type OpenedFile = {
  filePath: string | null;
  content: string;
  html?: string;
  converted?: { from: string; originalPath: string };
  error?: string;
  progress?: string;
};

type AuthSnapshot = {
  signedIn: boolean;
  email?: string;
  plan?: string;
  expiresAt?: number;
  persisted?: boolean;
  warning?: string;
};

type LoginUpdate =
  | { kind: 'usercode'; userCode: string; verificationUri: string }
  | { kind: 'success'; auth: AuthSnapshot }
  | { kind: 'error'; message: string };

type ProjectWizardSaveApprovedDraftInput = {
  projectFolder: string;
  body: string;
  frontmatter: Record<string, unknown>;
  inherits: boolean;
  lastScanned: string | null;
};

type ProjectWizardStateResult = {
  projectFolder: string;
  overviewPath: string;
  stage:
    | 'idle'
    | 'consent'
    | 'scan_scope'
    | 'analysis_profile'
    | 'manual_questions'
    | 'scanned'
    | 'drafted'
    | 'approved'
    | 'canceled'
    | 'blocked';
  stageStatements: Array<{ at: string; stage: string; message: string; data?: Record<string, unknown> }>;
};

type ProjectWizardSaveApprovedDraftResult = {
  status: 'not_ready' | 'partially_ready' | 'ready';
  overviewPath: string;
  markdown: string;
};

const api = {
  onFileOpened: (cb: (file: OpenedFile) => void) => {
    ipcRenderer.on('file:opened', (_e, file) => cb(file));
  },
  onMenuNew: (cb: () => void) => {
    ipcRenderer.on('menu:new', () => cb());
  },
  onMenuSave: (cb: () => void) => {
    ipcRenderer.on('menu:save', () => cb());
  },
  onMenuSaveAs: (cb: () => void) => {
    ipcRenderer.on('menu:save-as', () => cb());
  },
  onTogglePreview: (cb: () => void) => {
    ipcRenderer.on('menu:toggle-preview', () => cb());
  },
  /** Tell main this renderer is ready to receive `file:opened` (flushes any queued payloads). */
  windowReady: (): void => ipcRenderer.send('window:ready'),
  saveFile: (
    filePath: string | null,
    content: string,
  ): Promise<{ saved: boolean; filePath?: string; error?: string; ownerWindowId?: number }> =>
    ipcRenderer.invoke('file:save', { filePath, content }),

  // Workspace / file tree (G004 — left-panel file tree)
  openFolder: (): Promise<string | null> => ipcRenderer.invoke('workspace:open-folder'),
  listDir: (
    rootPath: string,
    dirPath: string,
  ): Promise<{ ok: boolean; entries: FileTreeEntry[]; error?: string }> =>
    ipcRenderer.invoke('workspace:list-dir', { rootPath, dirPath }),
  openFileInCurrent: (
    filePath: string,
  ): Promise<{ opened: boolean; focusedOwner?: boolean; ownerWindowId?: number; error?: string }> =>
    ipcRenderer.invoke('file:open-in-current', filePath),
  openPath: (
    filePath: string,
  ): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('shell:open-path', filePath),

  // Codex OAuth
  authStatus: (): Promise<AuthSnapshot> => ipcRenderer.invoke('auth:status'),
  authLogin: (): Promise<void> => ipcRenderer.invoke('auth:login'),
  authCancelLogin: (): Promise<void> => ipcRenderer.invoke('auth:cancel-login'),
  authLogout: (): Promise<void> => ipcRenderer.invoke('auth:logout'),
  onAuthLoginUpdate: (cb: (u: LoginUpdate) => void): (() => void) => {
    const listener = (_e: unknown, u: LoginUpdate) => cb(u);
    ipcRenderer.on('auth:login-update', listener);
    return () => ipcRenderer.removeListener('auth:login-update', listener);
  },

  // AI Chat — streaming
  aiChat: (
    id: string,
    instructions: string,
    history: { role: 'user' | 'assistant'; text: string }[],
    userText: string,
    model?: string | { provider: AiProviderId; id: string },
  ): Promise<void> => ipcRenderer.invoke('ai:chat', { id, instructions, history, userText, model }),
  aiCancel: (id: string): Promise<void> => ipcRenderer.invoke('ai:cancel', id),
  onAiChatEvent: (
    id: string,
    cb: (e: { kind: 'delta' | 'done' | 'error'; text?: string; message?: string }) => void,
  ) => {
    const channel = `ai:chat:${id}`;
    const listener = (_e: any, evt: any) => cb(evt);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },

  aiModels: (force?: boolean): Promise<ModelRef[]> => ipcRenderer.invoke('ai:models', force),

  // Multi-provider auth (v1)
  aiProvidersStatus: (): Promise<ProviderAuthStatus[]> =>
    ipcRenderer.invoke('auth:providers-status'),
  aiHasAnyAuth: (): Promise<boolean> => ipcRenderer.invoke('auth:has-any'),
  aiSetApiKey: (provider: AiProviderId, key: string): Promise<{ persisted: boolean }> =>
    ipcRenderer.invoke('auth:set-api-key', { provider, key }),
  aiDeleteProviderKey: (provider: AiProviderId): Promise<void> =>
    ipcRenderer.invoke('auth:delete-provider-key', provider),

  // Local AI provider config (Ollama / LM Studio base URLs)
  localAiGetConfig: (): Promise<{ ollama: string; lmstudio: string }> =>
    ipcRenderer.invoke('local-ai:get-config'),
  localAiSetConfig: (
    partial: { ollama?: string; lmstudio?: string },
  ): Promise<{ ollama: string; lmstudio: string }> =>
    ipcRenderer.invoke('local-ai:set-config', partial),

  /**
   * Fetch the v1.1 prompt-assembly context from the main process.
   *
   * Returns the current toggle state together with the pre-loaded contents of
   * `userData/systemlaw.md` and `userData/Owner.md`.  When the toggle is off,
   * the file contents are empty strings (no I/O performed).
   *
   * Renderer surfaces call this before building the system prompt so they can
   * decide whether to use the new 7-layer assembly or the v1.0 legacy path.
   *
   * Never rejects — any main-process error returns `{ enabled: false, ... }`.
   */
  getPromptAssemblyContext: (): Promise<{
    enabled: boolean;
    systemlawContent: string;
    ownerContent: string;
  }> => ipcRenderer.invoke('prompt:assembly-context'),

  projectWizardStart: (projectFolder: string): Promise<ProjectWizardStateResult> =>
    ipcRenderer.invoke('project-wizard:start', projectFolder),
  projectWizardSaveApprovedDraft: (
    input: ProjectWizardSaveApprovedDraftInput,
  ): Promise<ProjectWizardSaveApprovedDraftResult> =>
    ipcRenderer.invoke('project-wizard:save-approved-draft', input),

  sessionGet: (): Promise<any> => ipcRenderer.invoke('session:get'),
  sessionWrite: (snap: any): Promise<void> => ipcRenderer.invoke('session:write', snap),
  sessionClear: (): Promise<void> => ipcRenderer.invoke('session:clear'),

  checkForUpdate: (): Promise<{ updateAvailable: boolean; currentVersion: string; latestVersion: string; url: string } | null> =>
    ipcRenderer.invoke('update:check'),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:open-external', url),
  appVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
  /** Relaunch the whole app (used to fully apply a language change). */
  relaunchApp: (): Promise<void> => ipcRenderer.invoke('app:relaunch'),

  // HTML export (⑤)
  fetchDesignMd: (
    input: string,
  ): Promise<{ ok: boolean; designMd?: string; rawUrl?: string; error?: string }> =>
    ipcRenderer.invoke('design:fetch', input),
  saveHtml: (args: { html: string; defaultName?: string }): Promise<{ saved: boolean; filePath?: string }> =>
    ipcRenderer.invoke('html:save', args),
  openSavedHtml: (filePath: string): Promise<{ opened: boolean; error?: string }> =>
    ipcRenderer.invoke('html:open-saved', filePath),

  // OS integration (⑥) — default .md editor handler
  mdHandlerStatus: (): Promise<{ supported: boolean; registered?: boolean }> =>
    ipcRenderer.invoke('os:md-handler-status'),
  registerMdHandler: (): Promise<{ ok: boolean; registered?: boolean; defaultSet?: boolean; error?: string }> =>
    ipcRenderer.invoke('os:register-md-handler'),
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
