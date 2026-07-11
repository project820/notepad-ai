import type { AiProviderId, ModelRef, ProviderAuthStatus } from '../main/ai/types';
import type { AuthSnapshot, LoginUpdate } from '../shared/auth-protocol';
import type { FileTreeEntry } from '../shared/file-types';

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

export type Api = {
  onFileOpened: (cb: (file: { filePath: string; content: string }) => void) => void;
  onMenuNew: (cb: () => void) => void;
  onMenuSave: (cb: () => void) => void;
  onMenuSaveAs: (cb: () => void) => void;
  onTogglePreview: (cb: () => void) => void;
  windowReady: () => void;
  saveFile: (filePath: string | null, content: string) => Promise<{ saved: boolean; filePath?: string; error?: string; ownerWindowId?: number }>;
  openFolder: () => Promise<string | null>;
  listDir: (rootPath: string, dirPath: string) => Promise<{ ok: boolean; entries: FileTreeEntry[]; error?: string }>;
  openFileInCurrent: (filePath: string) => Promise<{ opened: boolean; focusedOwner?: boolean; ownerWindowId?: number; error?: string }>;
  openPath: (filePath: string) => Promise<{ ok: boolean; error?: string }>;
  authStatus: () => Promise<AuthSnapshot>;
  authLogin: () => Promise<void>;
  authCancelLogin: () => Promise<void>;
  authLogout: () => Promise<void>;
  onAuthLoginUpdate: (cb: (u: LoginUpdate) => void) => () => void;
  aiChat: (id: string, instructions: string, history: { role: 'user' | 'assistant'; text: string }[], userText: string, model?: string | { provider: AiProviderId; id: string }, surfaceMode?: 'write' | 'advise' | 'html' | 'block', images?: { mime: string; base64: string; bytes: number; name?: string }[]) => Promise<void>;
  aiCancel: (id: string) => Promise<void>;
  onAiChatEvent: (id: string, cb: (e: { kind: 'delta' | 'done' | 'error'; text?: string; message?: string; errorKind?: string }) => void) => () => void;
  aiModels: (force?: boolean) => Promise<ModelRef[]>;
  aiProvidersStatus: () => Promise<ProviderAuthStatus[]>;
  aiHasAnyAuth: () => Promise<boolean>;
  aiSetApiKey: (provider: AiProviderId, key: string) => Promise<{ persisted: boolean }>;
  aiDeleteProviderKey: (provider: AiProviderId) => Promise<void>;
  localAiGetConfig: () => Promise<{ ollama: string; lmstudio: string }>;
  localAiSetConfig: (partial: { ollama?: string; lmstudio?: string }) => Promise<{ ollama: string; lmstudio: string }>;
  projectWizardStart: (projectFolder: string) => Promise<ProjectWizardStateResult>;
  projectWizardSaveApprovedDraft: (input: ProjectWizardSaveApprovedDraftInput) => Promise<ProjectWizardSaveApprovedDraftResult>;
  sessionGet: () => Promise<any>;
  sessionWrite: (snap: any) => Promise<void>;
  sessionClear: () => Promise<void>;
  onCloseQueryState: (cb: (requestId: string) => void) => () => void;
  sendCloseState: (requestId: string, state: { dirty: boolean; hasPath: boolean; docEmpty: boolean; locale: 'en' | 'ko' | 'zh-Hans' | 'zh-Hant' | 'ja' }) => void;
  onCloseSave: (cb: (requestId: string) => void) => () => void;
  sendCloseSaveResult: (requestId: string, saved: boolean) => void;
  checkForUpdate: () => Promise<{ updateAvailable: boolean; currentVersion: string; latestVersion: string; url: string } | null>;
  openExternal: (url: string) => Promise<void>;
  appVersion: () => Promise<string>;
  relaunchApp: () => Promise<void>;
  convertAttachment: (base64: string, ext: string) => Promise<{ ok: boolean; markdown?: string; error?: string }>;
  fetchDesignMd: (input: string) => Promise<{ ok: boolean; designMd?: string; rawUrl?: string; error?: string }>;
  listDesigns: () => Promise<{ ok: boolean; designs?: { slug: string; name: string; pageUrl: string }[]; error?: string }>;
  saveHtml: (args: { html: string; defaultName?: string }) => Promise<{ saved: boolean; filePath?: string }>;
  openSavedHtml: (filePath: string) => Promise<{ opened: boolean; error?: string }>;
  mdHandlerStatus: () => Promise<{ supported: boolean; registered?: boolean }>;
  registerMdHandler: () => Promise<{ ok: boolean; registered?: boolean; defaultSet?: boolean; error?: string }>;
};

declare global {
  interface Window {
    api: Api;
  }
}
