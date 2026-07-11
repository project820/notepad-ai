import path from 'node:path';
import type { WizardState } from './types';

export type StateFs = {
  mkdir(dir: string, opts: { recursive: true }): Promise<void>;
  writeFile(filePath: string, content: string, encoding: 'utf8'): Promise<void>;
  readFile(filePath: string, encoding: 'utf8'): Promise<string>;
  lstat(filePath: string): Promise<{ isSymbolicLink(): boolean }>;
  realpath(filePath: string): Promise<string>;
};

function projectWizardStatePath(projectFolder: string): string {
  return path.join(projectFolder, '.notepad-ai', 'wizard-state.json');
}

export async function saveWizardState(state: WizardState, appStatePath: string, fs: StateFs): Promise<void> {
  const payload = `${JSON.stringify(state, null, 2)}\n`;
  const projectPath = projectWizardStatePath(state.projectFolder);
  const projectStateDir = path.dirname(projectPath);

  await fs.mkdir(path.dirname(appStatePath), { recursive: true });
  await ensureNotSymbolicLink(projectStateDir, fs);
  await fs.mkdir(projectStateDir, { recursive: true });
  await ensureSafeProjectStateTarget(state.projectFolder, projectPath, fs);
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
async function ensureSafeProjectStateTarget(projectFolder: string, projectPath: string, fs: Pick<StateFs, 'lstat' | 'realpath'>): Promise<void> {
  const projectRoot = await fs.realpath(projectFolder);
  const projectStateDir = path.dirname(projectPath);

  await ensureNotSymbolicLink(projectStateDir, fs);
  let existingTarget = false;
  try {
    const targetStat = await fs.lstat(projectPath);
    if (targetStat.isSymbolicLink()) {
      throw new Error('Refusing to write wizard state through a symbolic link');
    }
    existingTarget = true;
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
  }

  const targetRealpath = existingTarget
    ? await fs.realpath(projectPath)
    : path.join(await fs.realpath(projectStateDir), path.basename(projectPath));
  if (!isPathWithinRoot(projectRoot, targetRealpath)) {
    throw new Error('Wizard state target is outside the project folder');
  }
}

async function ensureNotSymbolicLink(dirPath: string, fs: Pick<StateFs, 'lstat'>): Promise<void> {
  try {
    if ((await fs.lstat(dirPath)).isSymbolicLink()) {
      throw new Error('Refusing to write wizard state through a symbolic link');
    }
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
  }
}

function isNotFoundError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT';
}

function isPathWithinRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
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
