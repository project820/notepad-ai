import { describe, it, expect } from 'vitest';
import { saveWizardState, loadWizardState, type StateFs } from '../main/project-wizard/state-store';
import type { WizardState } from '../main/project-wizard/types';

function memoryFs() {
  const files = new Map<string, string>();
  const fs: StateFs = {
    async mkdir() {},
    async writeFile(filePath, content) {
      files.set(filePath, content);
    },
    async readFile(filePath) {
      const value = files.get(filePath);
      if (value === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return value;
    },
  };
  return { fs, files };
}

const state: WizardState = {
  projectFolder: '/project',
  overviewPath: '/project/Overview.md',
  stage: 'scanned',
  scanScope: 'fast_structure',
  analysisProfile: 'normal',
  stageStatements: [{ at: '2026-05-15T14:40:32+09:00', stage: 'scanned', message: 'Scan complete' }],
};

describe('wizard state store', () => {
  it('saves app state and project hidden metadata state', async () => {
    const { fs, files } = memoryFs();
    await saveWizardState(state, '/app/wizard.json', fs);

    expect(files.has('/app/wizard.json')).toBe(true);
    expect(files.has('/project/.notepad-ai/wizard-state.json')).toBe(true);
  });

  it('loads app state first', async () => {
    const { fs } = memoryFs();
    await saveWizardState(state, '/app/wizard.json', fs);

    const loaded = await loadWizardState('/project', '/app/wizard.json', fs);
    expect(loaded?.stage).toBe('scanned');
  });

  it('falls back to project hidden metadata state when app state is missing', async () => {
    const { fs, files } = memoryFs();
    await saveWizardState(state, '/app/wizard.json', fs);
    files.delete('/app/wizard.json');

    const loaded = await loadWizardState('/project', '/app/wizard.json', fs);
    expect(loaded?.projectFolder).toBe('/project');
  });

  it('ignores app state for a different project and falls back to project metadata', async () => {
    const { fs } = memoryFs();
    await saveWizardState({ ...state, projectFolder: '/other', overviewPath: '/other/Overview.md' }, '/app/wizard.json', fs);
    await saveWizardState({ ...state, stage: 'drafted' }, '/app/other-wizard.json', fs);

    const loaded = await loadWizardState('/project', '/app/wizard.json', fs);
    expect(loaded?.projectFolder).toBe('/project');
    expect(loaded?.stage).toBe('drafted');
  });

  it('returns null when no state can be loaded', async () => {
    const { fs } = memoryFs();

    await expect(loadWizardState('/project', '/app/wizard.json', fs)).resolves.toBeNull();
  });
});
