import path from 'node:path';
import {
  atomicWriteWithExclusiveTemp,
  type DescriptorAtomicWriteBackend,
  type ExclusiveTempFile,
} from '../atomic-write';
import { identityFromStat, type IdentityFs } from '../path-identity';
import { repairOverviewDraft, renderOverviewMarkdown } from './overview-template';
import { loadWizardState, saveWizardState, type StateFs } from './state-store';
import type { ContextStatus, OverviewFrontmatter, WizardState } from './types';

type ServiceFs = {
  mkdir(dir: string, opts: { recursive: true }): Promise<unknown>;
  writeFile(filePath: string, content: string, encoding: 'utf8'): Promise<unknown>;
  readFile(filePath: string, encoding: 'utf8'): Promise<string>;
  readdir(dir: string, options: { withFileTypes: true }): Promise<unknown[]>;
  stat(filePath: string): Promise<{ size: number }>;
  lstat(filePath: string): Promise<{ isSymbolicLink(): boolean }>;
  realpath(filePath: string): Promise<string>;
};

export type ContextStackLoadResult = {
  ownerLoaded: boolean;
  systemlawLoaded: boolean;
  overviewLoaded: boolean;
};

export type ProjectWizardSaveApprovedDraftInput = {
  projectFolder: string;
  body: string;
  frontmatter: Partial<OverviewFrontmatter> & Record<string, unknown>;
  inherits: boolean;
  lastScanned: string | null;
};

export type WizardServiceDeps = {
  userDataPath: string;
  fs: ServiceFs;
  now: () => string;
  loadContextStack: (projectFolder: string, overviewPath: string) => Promise<ContextStackLoadResult>;
  revalidateApprovedProjectWrite: () => Promise<boolean>;
  /**
   * Descriptor-bound write dependencies. They are deliberately absent by
   * default so a service constructed outside the main-process IPC cannot write.
   */
  overviewWrite?: {
    backend: DescriptorAtomicWriteBackend;
    identityFs: IdentityFs;
  };
};

export function createWizardService(deps: WizardServiceDeps) {
  const appStatePath = path.join(deps.userDataPath, 'project-wizard-state.json');
  const stateFs: StateFs = {
    mkdir: async (dir, opts) => {
      await deps.fs.mkdir(dir, opts);
    },
    writeFile: async (filePath, content, encoding) => {
      await deps.fs.writeFile(filePath, content, encoding);
    },
    readFile: (filePath, encoding) => deps.fs.readFile(filePath, encoding),
    lstat: (filePath) => deps.fs.lstat(filePath),
    realpath: (filePath) => deps.fs.realpath(filePath),
  };

  return {
    async start(projectFolder: string): Promise<WizardState> {
      const now = deps.now();
      const state: WizardState = {
        projectFolder,
        overviewPath: path.join(projectFolder, 'Overview.md'),
        stage: 'consent',
        stageStatements: [
          {
            at: now,
            stage: 'consent',
            message: 'Project Wizard started',
          },
        ],
      };

      await saveWizardState(state, appStatePath, stateFs);
      return state;
    },

    async saveApprovedDraft(
      input: ProjectWizardSaveApprovedDraftInput,
    ): Promise<{ status: ContextStatus; overviewPath: string; markdown: string }> {
      const now = deps.now();
      const overviewPath = path.join(input.projectFolder, 'Overview.md');
      const existing = await loadWizardState(input.projectFolder, appStatePath, stateFs);
      if (!existing) {
        throw new Error('Project Wizard has not been started for this folder');
      }

      const draft = repairOverviewDraft({
        body: input.body,
        frontmatter: input.frontmatter,
        now,
        createdAtFallback: now,
        lastScanned: input.lastScanned,
        inherits: input.inherits,
      });
      const markdown = renderOverviewMarkdown(draft);

      const overviewWrite = deps.overviewWrite;
      if (!overviewWrite?.identityFs.lstat) {
        throw new Error('Project Wizard descriptor write dependencies are unavailable');
      }
      await atomicWriteWithExclusiveTemp(overviewPath, markdown, {
        backend: overviewWrite.backend,
        prepareDirectory: false,
        beforeWrite: async () => {
          if (!(await deps.revalidateApprovedProjectWrite())) {
            throw new Error('Project folder is not authorized');
          }
        },
        beforeRename: async (temp) => {
          if (!(await deps.revalidateApprovedProjectWrite())) {
            throw new Error('Project folder is not authorized');
          }
          await verifyExclusiveTempPath(temp, overviewWrite.identityFs);
        },
      });

      const loaded = await deps.loadContextStack(input.projectFolder, overviewPath);
      const status: ContextStatus =
        loaded.ownerLoaded && loaded.systemlawLoaded && loaded.overviewLoaded ? 'ready' : 'partially_ready';

      await saveWizardState(
        {
          ...existing,
          overviewPath,
          stage: 'approved',
          draft,
          stageStatements: [
            ...existing.stageStatements,
            {
              at: now,
              stage: 'approved',
              message: 'Overview approved and saved',
              data: { status },
            },
          ],
        },
        appStatePath,
        stateFs,
      );

      return { status, overviewPath, markdown };
    },
  };
}

export function createContextStackLoader(userDataPath: string, fs: Pick<ServiceFs, 'readFile'>) {
  return async (_projectFolder: string, overviewPath: string): Promise<ContextStackLoadResult> => {
    const [ownerLoaded, systemlawLoaded, overviewLoaded] = await Promise.all([
      canReadNonEmptyFile(path.join(userDataPath, 'Owner.md'), fs),
      canReadNonEmptyFile(path.join(userDataPath, 'systemlaw.md'), fs),
      canReadNonEmptyFile(overviewPath, fs),
    ]);

    return { ownerLoaded, systemlawLoaded, overviewLoaded };
  };
}

export function isProjectWizardSaveApprovedDraftInput(value: unknown): value is ProjectWizardSaveApprovedDraftInput {
  if (!isRecord(value)) return false;
  return (
    isSafeAbsoluteProjectFolderPath(value.projectFolder) &&
    typeof value.body === 'string' &&
    isRecord(value.frontmatter) &&
    typeof value.inherits === 'boolean' &&
    (typeof value.lastScanned === 'string' || value.lastScanned === null)
  );
}

export function isSafeAbsoluteProjectFolderPath(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && path.isAbsolute(value) && !value.includes('\0');
}

async function canReadNonEmptyFile(filePath: string, fs: Pick<ServiceFs, 'readFile'>): Promise<boolean> {
  try {
    return (await fs.readFile(filePath, 'utf8')).trim().length > 0;
  } catch {
    return false;
  }
}
async function verifyExclusiveTempPath(temp: ExclusiveTempFile, fs: IdentityFs): Promise<void> {
  if (!fs.lstat) {
    throw new Error('Project Wizard descriptor write dependencies are unavailable');
  }
  const stat = await fs.lstat(temp.path);
  if (!stat.isFile() || identityFromStat(stat) !== identityFromStat(temp.identity)) {
    throw new Error('Project Wizard temporary file was replaced');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
