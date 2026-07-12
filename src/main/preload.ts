import { contextBridge, ipcRenderer } from 'electron';
import type { AiProviderErrorKind, AiProviderId, ModelRef, ProviderAuthStatus, ReasoningEffort } from './ai/types';
import type { FileTreeEntry } from '../shared/file-types';
import type { AuthSnapshot, LoginUpdate } from '../shared/auth-protocol';

type OpenedFile = {
  filePath: string | null;
  content: string;
  html?: string;
  converted?: { from: string; originalPath: string };
  error?: string;
  progress?: string;
};

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

type AiChatRequest = {
  id: string;
  instructions: string;
  history: { role: 'user' | 'assistant'; text: string }[];
  userText: string;
  model?: string | { provider: AiProviderId; id: string };
  surfaceMode?: 'write' | 'advise' | 'html' | 'block';
  images?: { mime: string; base64: string; bytes: number; name?: string }[];
  reasoningEffort?: ReasoningEffort;
};

type ReasoningCapabilitiesSnapshot = {
  featureEnabled: boolean;
  snapshotGeneration: number;
  models: Array<{ modelId: string; efforts: ReasoningEffort[] }>;
  accountModels: string[];
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
  aiChat: (request: AiChatRequest): Promise<void> => ipcRenderer.invoke('ai:chat', request),
  aiCancel: (id: string): Promise<void> => ipcRenderer.invoke('ai:cancel', id),
  onAiChatEvent: (
    id: string,
    cb: (e: { kind: 'delta' | 'done' | 'error'; text?: string; message?: string; errorKind?: AiProviderErrorKind }) => void,
  ) => {
    const channel = `ai:chat:${id}`;
    const listener = (_e: any, evt: any) => cb(evt);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },

  aiModels: (force?: boolean): Promise<ModelRef[]> => ipcRenderer.invoke('ai:models', force),
  aiReasoningCapabilities: (): Promise<ReasoningCapabilitiesSnapshot> =>
    ipcRenderer.invoke('ai:reasoning-capabilities'),

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


  projectWizardStart: (projectFolder: string): Promise<ProjectWizardStateResult> =>
    ipcRenderer.invoke('project-wizard:start', projectFolder),
  projectWizardSaveApprovedDraft: (
    input: ProjectWizardSaveApprovedDraftInput,
  ): Promise<ProjectWizardSaveApprovedDraftResult> =>
    ipcRenderer.invoke('project-wizard:save-approved-draft', input),

  sessionGet: (): Promise<any> => ipcRenderer.invoke('session:get'),
  sessionWrite: (snap: any): Promise<void> => ipcRenderer.invoke('session:write', snap),
  sessionClear: (): Promise<void> => ipcRenderer.invoke('session:clear'),
  onCloseQueryState: (cb: (requestId: string) => void): (() => void) => {
    const listener = (_e: unknown, request: { requestId?: unknown }) => {
      if (typeof request?.requestId === 'string') cb(request.requestId);
    };
    ipcRenderer.on('close:query-state', listener);
    return () => ipcRenderer.removeListener('close:query-state', listener);
  },
  sendCloseState: (requestId: string, state: { dirty: boolean; hasPath: boolean; docEmpty: boolean; revision: number; syncFailed: boolean; locale: 'en' | 'ko' | 'zh-Hans' | 'zh-Hant' | 'ja' }): void =>
    ipcRenderer.send('close:state', { requestId, ...state }),
  onCloseSave: (cb: (requestId: string, revision: number) => void): (() => void) => {
    const listener = (_e: unknown, request: { requestId?: unknown; revision?: unknown }) => {
      const revision = request?.revision;
      if (typeof request?.requestId === 'string' && typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= -1) cb(request.requestId, revision);
    };
    ipcRenderer.on('close:save', listener);
    return () => ipcRenderer.removeListener('close:save', listener);
  },
  sendCloseSaveResult: (requestId: string, result: { saved: boolean; committedRevision: number | null }): void =>
    ipcRenderer.send('close:save-result', { requestId, ...result }),
  onCloseAuthorize: (cb: (requestId: string) => void): (() => void) => {
    const listener = (_e: unknown, request: { requestId?: unknown }) => {
      if (typeof request?.requestId === 'string') cb(request.requestId);
    };
    ipcRenderer.on('close:authorize', listener);
    return () => ipcRenderer.removeListener('close:authorize', listener);
  },
  sendCloseAuthorizeResult: (requestId: string, valid: boolean): void =>
    ipcRenderer.send('close:authorize-result', { requestId, valid }),
  onCloseConsume: (cb: (requestId: string) => void): (() => void) => {
    const listener = (_e: unknown, request: { requestId?: unknown }) => {
      if (typeof request?.requestId === 'string') cb(request.requestId);
    };
    ipcRenderer.on('close:consume', listener);
    return () => ipcRenderer.removeListener('close:consume', listener);
  },
  sendCloseConsumeResult: (requestId: string, consumed: boolean): void =>
    ipcRenderer.send('close:consume-result', { requestId, consumed }),
  onCloseDiscard: (cb: (request: { requestId: string; leaseId: string }) => void): (() => void) => {
    const listener = (_e: unknown, request: { requestId?: unknown; leaseId?: unknown }) => {
      if (typeof request?.requestId === 'string' && typeof request.leaseId === 'string') cb({ requestId: request.requestId, leaseId: request.leaseId });
    };
    ipcRenderer.on('close:discard', listener);
    return () => ipcRenderer.removeListener('close:discard', listener);
  },
  sendCloseDiscardResult: (requestId: string, fenced: boolean): void =>
    ipcRenderer.send('close:discard-result', { requestId, fenced }),
  onCloseDiscardRollback: (cb: (request: { requestId: string; leaseId: string }) => void): (() => void) => {
    const listener = (_e: unknown, request: { requestId?: unknown; leaseId?: unknown }) => {
      if (typeof request?.requestId === 'string' && typeof request.leaseId === 'string') cb({ requestId: request.requestId, leaseId: request.leaseId });
    };
    ipcRenderer.on('close:discard-rollback', listener);
    return () => ipcRenderer.removeListener('close:discard-rollback', listener);
  },
  sendCloseLeaseInvalidated: (requestId: string, revision: number): void =>
    ipcRenderer.send('close:lease-invalidated', { requestId, revision }),
  onCloseQuiescePrepare: (cb: (request: { requestId: string; ttlMs: number }) => void): (() => void) => {
    const listener = (_e: unknown, request: { requestId?: unknown; ttlMs?: unknown }) => {
      if (typeof request?.requestId === 'string' && typeof request.ttlMs === 'number') cb({ requestId: request.requestId, ttlMs: request.ttlMs });
    };
    ipcRenderer.on('close:quiesce-prepare', listener);
    return () => ipcRenderer.removeListener('close:quiesce-prepare', listener);
  },
  onCloseQuiesceRollback: (cb: (request: { requestId: string }) => void): (() => void) => {
    const listener = (_e: unknown, request: { requestId?: unknown }) => {
      if (typeof request?.requestId === 'string') cb({ requestId: request.requestId });
    };
    ipcRenderer.on('close:quiesce-rollback', listener);
    return () => ipcRenderer.removeListener('close:quiesce-rollback', listener);
  },
  onCloseQuiesceHeartbeat: (cb: (request: { requestId: string; ttlMs: number }) => void): (() => void) => {
    const listener = (_e: unknown, request: { requestId?: unknown; ttlMs?: unknown }) => {
      if (typeof request?.requestId === 'string' && typeof request.ttlMs === 'number') cb({ requestId: request.requestId, ttlMs: request.ttlMs });
    };
    ipcRenderer.on('close:quiesce-heartbeat', listener);
    return () => ipcRenderer.removeListener('close:quiesce-heartbeat', listener);
  },
  sendCloseQuiesceResult: (requestId: string, result: { prepared?: boolean; rolledBack?: boolean }): void =>
    ipcRenderer.send('close:quiesce-result', { requestId, ...result }),
  sendCloseQuiesceReady: (): void => ipcRenderer.send('close:quiesce-ready'),
  setCloseLocale: (locale: 'en' | 'ko' | 'zh-Hans' | 'zh-Hant' | 'ja'): void =>
    ipcRenderer.send('close:locale', locale),

  checkForUpdate: (): Promise<{ updateAvailable: boolean; currentVersion: string; latestVersion: string; url: string } | null> =>
    ipcRenderer.invoke('update:check'),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:open-external', url),
  appVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
  /** Relaunch the whole app (used to fully apply a language change). */
  relaunchApp: (): Promise<void> => ipcRenderer.invoke('app:relaunch'),
  /** Convert an attached document (PDF/DOCX/HWP/XLSX) buffer to Markdown text for AI context. */
  convertAttachment: (
    base64: string,
    ext: string,
  ): Promise<{ ok: boolean; markdown?: string; error?: string }> =>
    ipcRenderer.invoke('ai:convert-attachment', { base64, ext }),

  // HTML export (⑤)
  fetchDesignMd: (
    input: string,
  ): Promise<{ ok: boolean; designMd?: string; rawUrl?: string; error?: string }> =>
    ipcRenderer.invoke('design:fetch', input),
  listDesigns: (): Promise<{
    ok: boolean;
    designs?: { slug: string; name: string; pageUrl: string }[];
    error?: string;
  }> => ipcRenderer.invoke('design:list'),
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
