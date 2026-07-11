export type ScanScope = 'fast_structure' | 'document_centered' | 'codex_full' | 'manual_explanation';

type AnalysisProfile = 'spark' | 'normal' | 'detailed';

type WizardStage =
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

export type ContextStatus = 'not_ready' | 'partially_ready' | 'ready';

type StageStatement = {
  at: string;
  stage: WizardStage;
  message: string;
  data?: Record<string, unknown>;
};

type ManualExplanation = {
  purpose: string;
  folderScope: string;
  constraints: string;
  inheritance: 'inherit' | 'do_not_inherit' | 'unknown';
};

export type UnreadableItem = {
  path: string;
  reason: 'unsupported' | 'too_large' | 'binary' | 'read_error';
  critical: boolean;
  note?: string;
};

export type ScanSummary = {
  scope: ScanScope;
  projectFolder: string;
  scannedAt: string;
  filesSeen: string[];
  documentsRead: Array<{ path: string; excerpt: string }>;
  unreadableItems: UnreadableItem[];
};

export type OverviewFrontmatter = {
  overview_version: 1;
  scope: 'folder';
  status: 'active' | 'draft';
  created_by: 'notepad-ai';
  created_at: string;
  last_modified: string;
  last_reviewed: string | null;
  last_scanned: string | null;
  timezone: 'Asia/Seoul';
  inherits: boolean;
  confidence: 'draft' | 'reviewed';
  user_metadata: Record<string, unknown>;
};

export type OverviewDraft = {
  frontmatter: OverviewFrontmatter;
  body: string;
};

export type WizardState = {
  projectFolder: string;
  overviewPath: string;
  stage: WizardStage;
  scanScope?: ScanScope;
  analysisProfile?: AnalysisProfile;
  manualExplanation?: ManualExplanation;
  scanSummary?: ScanSummary;
  draft?: OverviewDraft;
  stageStatements: StageStatement[];
};
