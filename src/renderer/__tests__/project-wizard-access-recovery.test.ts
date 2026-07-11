import { describe, expect, it, vi } from 'vitest';
import { retryProjectWizardAfterFolderGrant } from '../project-wizard-access-recovery';

describe('retryProjectWizardAfterFolderGrant', () => {
  it('retries the original document folder after granting a parent workspace', async () => {
    const grantWorkspace = vi.fn();
    const startProjectWizard = vi.fn(async () => {});

    await expect(
      retryProjectWizardAfterFolderGrant('/workspace/project', {
        openFolder: async () => '/workspace',
        grantWorkspace,
        startProjectWizard,
      }),
    ).resolves.toBe('/workspace/project');

    expect(grantWorkspace).toHaveBeenCalledWith('/workspace');
    expect(startProjectWizard).toHaveBeenCalledWith('/workspace/project');
  });
});
