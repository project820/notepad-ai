export type ProjectWizardAccessRecoveryDeps = {
  openFolder: () => Promise<string | null>;
  grantWorkspace: (folder: string) => void;
  startProjectWizard: (folder: string) => Promise<unknown>;
};

/** Retry the original document folder after the user grants a workspace root. */
export async function retryProjectWizardAfterFolderGrant(
  originalFolder: string,
  deps: ProjectWizardAccessRecoveryDeps,
): Promise<string | null> {
  const grantedFolder = await deps.openFolder();
  if (!grantedFolder) return null;

  deps.grantWorkspace(grantedFolder);
  await deps.startProjectWizard(originalFolder);
  return originalFolder;
}
