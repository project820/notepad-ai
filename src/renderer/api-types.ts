import type { AiProviderId, ModelRef, ProviderAuthStatus, ReasoningEffort } from '../main/ai/types';
import type { AuthSnapshot, LoginUpdate, SubscriptionLoginUpdate, SubscriptionProvider } from '../shared/auth-protocol';
import type { FileTreeEntry } from '../shared/file-types';
import type { HtmlExportPipelineApi, SaveFinalizedRequest, SaveFinalizedResult } from '../shared/html-export-pipeline';
import type { GenerationAttemptResult } from '../main/html-export-generation-orchestrator';
import type { HtmlExportAssetApi } from '../shared/html-export-assets';

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


export type Api = HtmlExportPipelineApi & HtmlExportAssetApi & {
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
  aiChat: (request: AiChatRequest) => Promise<void>;
  aiCancel: (id: string) => Promise<void>;
  onAiChatEvent: (id: string, cb: (e: { kind: 'delta' | 'done' | 'error'; text?: string; message?: string; errorKind?: string }) => void) => () => void;
  aiModels: (force?: boolean) => Promise<ModelRef[]>;
  aiModelsHtml: (force?: boolean) => Promise<ModelRef[]>;
  aiReasoningCapabilities: () => Promise<ReasoningCapabilitiesSnapshot>;
  aiProvidersStatus: () => Promise<ProviderAuthStatus[]>;
  aiHasAnyAuth: () => Promise<boolean>;
  aiSetApiKey: (provider: AiProviderId, key: string) => Promise<{ persisted: boolean }>;
  aiDeleteProviderKey: (provider: AiProviderId) => Promise<void>;
  subscriptionLogin: (provider: SubscriptionProvider) => Promise<void>;
  subscriptionSubmitLoginCode: (provider: SubscriptionProvider, code: string) => Promise<void>;
  subscriptionCancelLogin: (provider: SubscriptionProvider) => Promise<void>;
  subscriptionLogout: (provider: SubscriptionProvider) => Promise<void>;
  onSubscriptionLoginProgress: (cb: (u: SubscriptionLoginUpdate) => void) => () => void;
  localAiGetConfig: () => Promise<{ ollama: string; lmstudio: string }>;
  localAiSetConfig: (partial: { ollama?: string; lmstudio?: string }) => Promise<{ ollama: string; lmstudio: string }>;
  cliOverrides: () => Promise<Record<'claude' | 'grok', { path: string } | null>>;
  cliSelectOverride: (cli: 'claude' | 'grok') => Promise<{ ok: boolean; path?: string; error?: string; cancelled?: boolean }>;
  cliClearOverride: (cli: 'claude' | 'grok') => Promise<void>;
  projectWizardStart: (projectFolder: string) => Promise<ProjectWizardStateResult>;
  projectWizardSaveApprovedDraft: (input: ProjectWizardSaveApprovedDraftInput) => Promise<ProjectWizardSaveApprovedDraftResult>;
  sessionGet: () => Promise<any>;
  sessionWrite: (snap: any) => Promise<void>;
  sessionClear: () => Promise<void>;
  onCloseQueryState: (cb: (requestId: string) => void) => () => void;
  sendCloseState: (requestId: string, state: { dirty: boolean; hasPath: boolean; docEmpty: boolean; revision: number; syncFailed: boolean; locale: 'en' | 'ko' | 'zh-Hans' | 'zh-Hant' | 'ja' }) => void;
  onCloseSave: (cb: (requestId: string, revision: number) => void) => () => void;
  sendCloseSaveResult: (requestId: string, result: { saved: boolean; committedRevision: number | null }) => void;
  onCloseAuthorize: (cb: (requestId: string) => void) => () => void;
  sendCloseAuthorizeResult: (requestId: string, valid: boolean) => void;
  onCloseConsume: (cb: (requestId: string) => void) => () => void;
  sendCloseConsumeResult: (requestId: string, consumed: boolean) => void;
  onCloseDiscard: (cb: (request: { requestId: string; leaseId: string }) => void) => () => void;
  sendCloseDiscardResult: (requestId: string, fenced: boolean) => void;
  onCloseDiscardRollback: (cb: (request: { requestId: string; leaseId: string }) => void) => () => void;
  sendCloseLeaseInvalidated: (requestId: string, revision: number) => void;
  onCloseQuiescePrepare: (cb: (request: { requestId: string; ttlMs: number }) => void) => () => void;
  onCloseQuiesceRollback: (cb: (request: { requestId: string }) => void) => () => void;
  onCloseQuiesceHeartbeat: (cb: (request: { requestId: string; ttlMs: number }) => void) => () => void;
  sendCloseQuiesceResult: (requestId: string, result: { prepared?: boolean; rolledBack?: boolean }) => void;
  sendCloseQuiesceReady: () => void;
  setCloseLocale: (locale: 'en' | 'ko' | 'zh-Hans' | 'zh-Hant' | 'ja') => void;
  checkForUpdate: () => Promise<{ updateAvailable: boolean; currentVersion: string; latestVersion: string; url: string } | null>;
  openExternal: (url: string) => Promise<void>;
  appVersion: () => Promise<string>;
  relaunchApp: () => Promise<void>;
  convertAttachment: (base64: string, ext: string) => Promise<{ ok: boolean; markdown?: string; error?: string }>;
  fetchDesignMd: (input: string) => Promise<{ ok: boolean; designMd?: string; rawUrl?: string; error?: string }>;
  listDesigns: () => Promise<{ ok: boolean; designs?: { slug: string; name: string; pageUrl: string }[]; error?: string }>;
  generateHtmlExport: (
    request: {
      prompt: string;
      model: { provider: AiProviderId; id: string };
      instructions?: string;
      viewport?: { width: number; height: number };
    },
  ) => Promise<GenerationAttemptResult>;
  cancelHtmlGeneration: () => Promise<{ ok: boolean }>;
  saveHtmlFinalized: (request: SaveFinalizedRequest) => Promise<SaveFinalizedResult>;
  openSavedHtml: (filePath: string) => Promise<{ opened: boolean; error?: string }>;
  mdHandlerStatus: () => Promise<{ supported: boolean; registered?: boolean }>;
  registerMdHandler: () => Promise<{ ok: boolean; registered?: boolean; defaultSet?: boolean; error?: string }>;
};

declare global {
  interface Window {
    api: Api;
  }
}
