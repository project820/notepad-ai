import path from 'node:path';
import type { WizardState } from './types';

export type StateFs = {
  mkdir(dir: string, opts: { recursive: true }): Promise<void>;
  writeFile(filePath: string, content: string, encoding: 'utf8'): Promise<void>;
  readFile(filePath: string, encoding: 'utf8'): Promise<string>;
};

export function projectWizardStatePath(projectFolder: string): string {
  return path.join(projectFolder, '.notepad-ai', 'wizard-state.json');
}

export async function saveWizardState(state: WizardState, appStatePath: string, fs: StateFs): Promise<void> {
  const payload = `${JSON.stringify(state, null, 2)}\n`;
  const projectPath = projectWizardStatePath(state.projectFolder);
  await fs.mkdir(path.dirname(appStatePath), { recursive: true });
  await fs.mkdir(path.dirname(projectPath), { recursive: true });
  await Promise.all([fs.writeFile(appStatePath, payload, 'utf8'), fs.writeFile(projectPath, payload, 'utf8')]);
}

export async function loadWizardState(
  projectFolder: string,
  appStatePath: string,
  fs: StateFs,
): Promise<WizardState | null> {
  for (const filePath of [appStatePath, projectWizardStatePath(projectFolder)]) {
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
      if (isWizardStateForProject(parsed, projectFolder)) return parsed;
    } catch {
      // Try next state source.
    }
  }
  return null;
}

function isWizardStateForProject(value: unknown, projectFolder: string): value is WizardState {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Partial<WizardState>).projectFolder === projectFolder &&
    typeof (value as Partial<WizardState>).overviewPath === 'string' &&
    typeof (value as Partial<WizardState>).stage === 'string' &&
    Array.isArray((value as Partial<WizardState>).stageStatements)
  );
}
