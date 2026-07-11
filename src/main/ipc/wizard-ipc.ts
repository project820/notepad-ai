import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { handleTrusted } from '../ipc-guard';
import { FileGrants } from '../file-grants';
import { type IdentityFs } from '../path-identity';
import {
  createContextStackLoader,
  createWizardService,
  isProjectWizardSaveApprovedDraftInput,
  isSafeAbsoluteProjectFolderPath,
} from '../project-wizard/service';
import { ProjectWizardRootStore, resolveGrantedProjectFolder } from '../project-wizard/access';
import { nowInSeoulIso } from '../project-wizard/time';

type WizardIpcDeps = {
  fileGrants: FileGrants;
  projectWizardRoots: ProjectWizardRootStore;
  identityFs: IdentityFs;
};

export function registerWizardIpc({ fileGrants, projectWizardRoots, identityFs }: WizardIpcDeps): void {
  const makeProjectWizardService = () => {
    const userDataPath = app.getPath('userData');
    return createWizardService({
      userDataPath,
      fs,
      now: () => nowInSeoulIso(),
      loadContextStack: createContextStackLoader(userDataPath, fs),
    });
  };

  const requireProjectFolder = async (wcId: number, projectFolder: unknown): Promise<string> => {
    if (!isSafeAbsoluteProjectFolderPath(projectFolder)) throw new Error('Invalid project folder path');
    const canonicalRoot = await resolveGrantedProjectFolder(fileGrants, wcId, projectFolder, identityFs);
    if (!canonicalRoot) throw new Error('Project folder is not authorized');
    const stat = await fs.stat(canonicalRoot);
    if (!stat.isDirectory()) throw new Error('Project folder path is not a directory');
    return canonicalRoot;
  };

  handleTrusted('project-wizard:start', async (event, projectFolder: string) => {
    const canonicalRoot = await requireProjectFolder(event.sender.id, projectFolder);
    projectWizardRoots.record(event.sender.id, canonicalRoot);
    return makeProjectWizardService().start(canonicalRoot);
  });
  handleTrusted('project-wizard:save-approved-draft', async (event, input) => {
    if (!isProjectWizardSaveApprovedDraftInput(input)) throw new Error('Invalid project wizard draft payload');
    const projectFolder = projectWizardRoots.get(event.sender.id);
    if (!projectFolder) throw new Error('Project Wizard has not been started for this window');
    return makeProjectWizardService().saveApprovedDraft({ ...input, projectFolder });
  });
}
