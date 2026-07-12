import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';

export type TrustedCliName = 'claude' | 'grok' | 'agy';

export type CliIdentity = {
  realpath: string;
  sizeBytes: number;
  mtimeMs: number;
  sha256: string;
};

export type CliOverride = {
  identity: CliIdentity;
  stagedPath: string;
  stagedIdentity: CliIdentity;
};

export type TrustedCliResult = { command: string } | { error: string };

export interface CliOverrideBackend {
  readFile(): Promise<string | null>;
  writeFile(json: string): Promise<void>;
  stagingRoot(): string;
}

export interface CliOverrideStore {
  get(cli: TrustedCliName): Promise<CliOverride | null>;
  approve(cli: TrustedCliName, selectedPath: string): Promise<TrustedCliResult>;
  clear(cli: TrustedCliName): Promise<void>;
}

const CMUX_BUNDLE_ROOT = '/Applications/cmux.app/Contents/Resources/bin';
const CMUX_COMMANDS: Record<Exclude<TrustedCliName, 'agy'>, string> = {
  claude: path.join(CMUX_BUNDLE_ROOT, 'claude'),
  grok: path.join(CMUX_BUNDLE_ROOT, 'grok'),
};

function isIdentity(value: unknown): value is CliIdentity {
  const v = value as CliIdentity;
  return !!v && typeof v.realpath === 'string' && Number.isSafeInteger(v.sizeBytes) && v.sizeBytes >= 0 &&
    typeof v.mtimeMs === 'number' && Number.isFinite(v.mtimeMs) && /^[a-f0-9]{64}$/.test(v.sha256);
}

function parseOverrides(raw: string | null): Partial<Record<TrustedCliName, CliOverride>> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as { overrides?: Record<string, unknown> };
    const entries = parsed?.overrides;
    if (!entries || typeof entries !== 'object') return {};
    const out: Partial<Record<TrustedCliName, CliOverride>> = {};
    for (const cli of ['claude', 'grok', 'agy'] as const) {
      const value = entries[cli] as CliOverride | undefined;
      if (value && isIdentity(value.identity) && isIdentity(value.stagedIdentity) && typeof value.stagedPath === 'string') out[cli] = value;
    }
    return out;
  } catch {
    return {};
  }
}

async function assertSafeParents(filePath: string): Promise<void> {
  for (let dir = path.dirname(filePath); ; dir = path.dirname(dir)) {
    const stat = await fs.stat(dir);
    if ((stat.mode & 0o002) !== 0) throw new Error('CLI executable has a world-writable parent directory.');
    const parent = path.dirname(dir);
    if (parent === dir) return;
  }
}
function minimalCliEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TMPDIR']) {
    const value = process.env[key];
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/** Approval-time liveness check: only a selected, already-validated path is executed. */
async function verifyCliVersion(command: string): Promise<void> {
  const { execFile } = require('node:child_process') as typeof import('node:child_process');
  await new Promise<void>((resolve, reject) => {
    execFile(command, ['--version'], { env: minimalCliEnv(), timeout: 5_000 }, (error) => error ? reject(error) : resolve());
  });
}

/** Read an executable by descriptor so the checked bytes are exactly the staged bytes. */
async function readVerifiedCliFile(inputPath: string, requireCmuxBundle = false): Promise<{ identity: CliIdentity; bytes: Buffer }> {
  const realpath = await fs.realpath(inputPath);
  if (requireCmuxBundle && !isInside(realpath, CMUX_BUNDLE_ROOT)) throw new Error('CLI is outside the canonical cmux bundle.');
  await assertSafeParents(realpath);
  const handle = await fs.open(realpath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('CLI executable must be a regular file.');
    if ((stat.mode & 0o111) === 0) throw new Error('CLI executable is not executable.');
    if ((stat.mode & 0o002) !== 0) throw new Error('CLI executable is world-writable.');
    const bytes = await handle.readFile();
    return {
      identity: {
        realpath,
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
      bytes,
    };
  } finally {
    await handle.close();
  }
}

function isInside(filePath: string, root: string): boolean {
  const relative = path.relative(root, filePath);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}
/** Validate a fixed executable inside the canonical cmux bundle; no directory scan occurs. */
export async function validateCmuxBundleCandidate(
  cli: Exclude<TrustedCliName, 'agy'>,
  candidate: string,
  expectedRoot: string = CMUX_BUNDLE_ROOT,
): Promise<CliIdentity> {
  const verified = await readVerifiedCliFile(candidate);
  const canonicalRoot = await fs.realpath(expectedRoot);
  if (path.basename(verified.identity.realpath) !== cli || !verified.identity.realpath.startsWith(`${canonicalRoot}${path.sep}`)) {
    throw new Error('CLI is outside the canonical cmux bundle.');
  }
  return verified.identity;
}

function sameIdentity(actual: CliIdentity, expected: CliIdentity): boolean {
  return actual.realpath === expected.realpath && actual.sizeBytes === expected.sizeBytes &&
    actual.mtimeMs === expected.mtimeMs && actual.sha256 === expected.sha256;
}

export class AtomicCliOverrideStore implements CliOverrideStore {
  private loaded: Promise<void> | null = null;
  private overrides: Partial<Record<TrustedCliName, CliOverride>> = {};
  private mutationChain: Promise<unknown> = Promise.resolve();

  constructor(private backend: CliOverrideBackend) {}

  private async load(): Promise<void> {
    if (!this.loaded) {
      this.loaded = this.backend.readFile().then((raw) => { this.overrides = parseOverrides(raw); });
    }
    await this.loaded;
  }

  async get(cli: TrustedCliName): Promise<CliOverride | null> {
    await this.load();
    const value = this.overrides[cli];
    return value ? { ...value, identity: { ...value.identity }, stagedIdentity: { ...value.stagedIdentity } } : null;
  }

  approve(cli: TrustedCliName, selectedPath: string): Promise<TrustedCliResult> {
    const run = this.mutationChain.then(async () => {
      await this.load();
      const checked = await readVerifiedCliFile(selectedPath);
      await verifyCliVersion(checked.identity.realpath);
      const source = await readVerifiedCliFile(selectedPath);
      if (!sameIdentity(source.identity, checked.identity)) throw new Error('CLI executable changed during approval. Select it again.');
      const root = this.backend.stagingRoot();
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      await fs.chmod(root, 0o700);
      const stagedPath = path.join(root, `${cli}-${source.identity.sha256}`);
      const temporary = `${stagedPath}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(temporary, source.bytes, { mode: 0o700, flag: 'wx' });
      await fs.rename(temporary, stagedPath);
      await fs.chmod(stagedPath, 0o700);
      const staged = await readVerifiedCliFile(stagedPath);
      const next = { ...this.overrides, [cli]: { identity: source.identity, stagedPath, stagedIdentity: staged.identity } };
      await this.backend.writeFile(JSON.stringify({ version: 1, overrides: next }));
      this.overrides = next;
      return { command: stagedPath };
    });
    this.mutationChain = run.catch(() => {});
    return run.catch((error) => ({ error: (error as Error).message || 'Could not approve CLI executable.' }));
  }

  clear(cli: TrustedCliName): Promise<void> {
    const run = this.mutationChain.then(async () => {
      await this.load();
      const next = { ...this.overrides };
      delete next[cli];
      await this.backend.writeFile(JSON.stringify({ version: 1, overrides: next }));
      this.overrides = next;
    });
    this.mutationChain = run.catch(() => {});
    return run;
  }
}

function createElectronBackend(): CliOverrideBackend {
  const { app } = require('electron') as typeof import('electron');
  const configPath = () => path.join(app.getPath('userData'), 'cli-overrides.json');
  return {
    stagingRoot: () => path.join(app.getPath('userData'), 'trusted-cli'),
    readFile: async () => {
      try { return await fs.readFile(configPath(), 'utf-8'); } catch { return null; }
    },
    writeFile: async (json) => {
      const target = configPath();
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(temporary, json, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, target);
    },
  };
}

let defaultStore: CliOverrideStore | null = null;
export function getCliOverrideStore(): CliOverrideStore {
  if (!defaultStore) defaultStore = new AtomicCliOverrideStore(createElectronBackend());
  return defaultStore;
}

/** The only port that supplies a command pathname to CLI probe and completion spawns. */
export async function resolveTrustedCliCommand(cli: TrustedCliName, store: CliOverrideStore = getCliOverrideStore()): Promise<TrustedCliResult> {
  const override = await store.get(cli);
  if (override) {
    try {
      const source = await readVerifiedCliFile(override.identity.realpath);
      if (!sameIdentity(source.identity, override.identity)) return { error: 'CLI executable changed after approval. Select it again to re-approve.' };
      const staged = await readVerifiedCliFile(override.stagedPath);
      if (!sameIdentity(staged.identity, override.stagedIdentity)) return { error: 'Trusted CLI staging artifact changed. Select the executable again to re-approve.' };
      return { command: override.stagedPath };
    } catch {
      return { error: 'CLI executable changed after approval. Select it again to re-approve.' };
    }
  }
  const candidate = CMUX_COMMANDS[cli as Exclude<TrustedCliName, 'agy'>];
  if (!candidate) return { error: 'No approved CLI executable selected.' };
  try {
    const verified = await validateCmuxBundleCandidate(cli as Exclude<TrustedCliName, 'agy'>, candidate);
    return { command: verified.realpath };
  } catch {
    return { error: 'CLI executable is unavailable.' };
  }
}
