import { app, type WebContents } from 'electron';
import { promises as fs } from 'node:fs';
import { nodeAtomicBackend, type DescriptorAtomicWriteBackend } from '../atomic-write';
import { handleTrusted } from '../ipc-guard';
import { FileGrants } from '../file-grants';
import { type IdentityFs } from '../path-identity';
import {
  createContextStackLoader,
  createWizardService,
  isProjectWizardSaveApprovedDraftInput,
  isSafeAbsoluteProjectFolderPath,
} from '../project-wizard/service';
import {
  ProjectWizardRootStore,
  resolveGrantedProjectFolder,
  revalidateCurrentProjectWizardRoot,
} from '../project-wizard/access';
import { nowInSeoulIso } from '../project-wizard/time';

type WizardIpcDeps = {
  fileGrants: FileGrants;
  projectWizardRoots: ProjectWizardRootStore;
  identityFs: IdentityFs;
  /** Injectable only for IPC tests; production uses a node descriptor backend. */
  atomicBackend?: DescriptorAtomicWriteBackend;
};

export function registerWizardIpc({
  fileGrants,
  projectWizardRoots,
  identityFs,
  atomicBackend = nodeAtomicBackend(),
}: WizardIpcDeps): void {
  type StartOwner = { readonly sender: WebContents; readonly generation: number };
  const startOwners = new Map<number, StartOwner>();
  const boundStartSenders = new WeakSet<object>();
  const pendingStarts = new Map<number, Promise<unknown>>();
  const bindStartSender = (sender: WebContents): void => {
    if (boundStartSenders.has(sender)) return;
    const webContentsId = sender.id;
    sender.once('destroyed', () => {
      if (startOwners.get(webContentsId)?.sender === sender) startOwners.delete(webContentsId);
    });
    boundStartSenders.add(sender);
  };
  const makeProjectWizardService = (revalidateApprovedProjectWrite: () => Promise<boolean>) => {
    const userDataPath = app.getPath('userData');
    return createWizardService({
      userDataPath,
      fs,
      now: () => nowInSeoulIso(),
      loadContextStack: createContextStackLoader(userDataPath, fs),
      revalidateApprovedProjectWrite,
      overviewWrite: { backend: atomicBackend, identityFs },
    });
  };

  const requireProjectFolder = async (wcId: number, projectFolder: unknown) => {
    if (!isSafeAbsoluteProjectFolderPath(projectFolder)) throw new Error('Invalid project folder path');
    const authorization = await resolveGrantedProjectFolder(fileGrants, wcId, projectFolder, identityFs);
    if (!authorization) throw new Error('Project folder is not authorized');
    return authorization;
  };

  handleTrusted('project-wizard:start', async (event, projectFolder: string) => {
    const sender = event.sender;
    const webContentsId = sender.id;
    bindStartSender(sender);
    const previousOwner = startOwners.get(webContentsId);
    const owner: StartOwner = {
      sender,
      generation: previousOwner?.sender === sender ? previousOwner.generation + 1 : 1,
    };
    startOwners.set(webContentsId, owner);
    const isCurrent = () => startOwners.get(webContentsId) === owner;
    const previous = pendingStarts.get(webContentsId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      const authorization = await requireProjectFolder(webContentsId, projectFolder);
      if (!isCurrent()) throw new Error('Project Wizard start was superseded');
      const result = await makeProjectWizardService(async () => false).start(authorization.project.realpath);
      if (!isCurrent()) throw new Error('Project Wizard start was superseded');
      projectWizardRoots.record(webContentsId, authorization);
      return result;
    });
    pendingStarts.set(webContentsId, run);
    try {
      return await run;
    } finally {
      if (pendingStarts.get(webContentsId) === run) pendingStarts.delete(webContentsId);
      if (isCurrent()) startOwners.delete(webContentsId);
    }
  });
  handleTrusted('project-wizard:save-approved-draft', async (event, input) => {
    if (!isProjectWizardSaveApprovedDraftInput(input)) throw new Error('Invalid project wizard draft payload');
    const record = projectWizardRoots.get(event.sender.id);
    if (!record || !projectWizardRoots.isCurrent(event.sender.id, record)) {
      throw new Error('Project Wizard has not been started for this window');
    }

    const projectFolder = await revalidateCurrentProjectWizardRoot(
      fileGrants,
      projectWizardRoots,
      event.sender.id,
      record,
      identityFs,
    );
    if (!projectFolder) throw new Error('Project folder is not authorized');

    return makeProjectWizardService(async () => {
      const revalidatedProjectFolder = await revalidateCurrentProjectWizardRoot(
        fileGrants,
        projectWizardRoots,
        event.sender.id,
        record,
        identityFs,
      );
      return revalidatedProjectFolder === record.authorization.project.realpath;
    }).saveApprovedDraft({ ...input, projectFolder });
  });
}
