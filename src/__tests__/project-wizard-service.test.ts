import { describe, it, expect } from 'vitest';
import type { DescriptorAtomicWriteBackend, ExclusiveTempFileHandle } from '../main/atomic-write';
import type { IdentityFs, IdentityStat } from '../main/path-identity';
import {
  createContextStackLoader,
  createWizardService,
  isProjectWizardSaveApprovedDraftInput,
} from '../main/project-wizard/service';

type OverviewTarget = 'new' | 'existing' | 'symlink' | 'existing-realpath-escape';

type OverviewNode = {
  content: string;
  dev: bigint;
  ino: bigint;
  kind: 'file' | 'directory' | 'symlink';
};

function enoent(target: string) {
  return Object.assign(new Error(`ENOENT: ${target}`), { code: 'ENOENT' });
}

function identityStat(node: OverviewNode): IdentityStat & { isSymbolicLink(): boolean } {
  return {
    dev: node.dev,
    ino: node.ino,
    isFile: () => node.kind === 'file',
    isDirectory: () => node.kind === 'directory',
    isSymbolicLink: () => node.kind === 'symlink',
  };
}

function createOverviewWriteHarness(target: OverviewTarget = 'new') {
  const files = new Map<string, string>();
  const calls: string[] = [];
  const tempNodes = new Map<string, OverviewNode>();
  const nodes = new Map<string, OverviewNode>([
    ['/real/project', { content: '', dev: 10n, ino: 1n, kind: 'directory' }],
  ]);
  let nextId = 0;
  let nextIno = 100n;

  if (target === 'existing') {
    nodes.set('/real/project/Overview.md', { content: 'old overview', dev: 10n, ino: 2n, kind: 'file' });
    files.set('/project/Overview.md', 'old overview');
  } else if (target === 'symlink') {
    nodes.set('/project/Overview.md', { content: 'outside overview', dev: 10n, ino: 3n, kind: 'symlink' });
    nodes.set('/outside-project/Overview.md', { content: 'outside overview', dev: 20n, ino: 4n, kind: 'file' });
    files.set('/project/Overview.md', 'outside overview');
    files.set('/outside-project/Overview.md', 'outside overview');
  } else if (target === 'existing-realpath-escape') {
    nodes.set('/outside-project/Overview.md', { content: 'outside overview', dev: 20n, ino: 4n, kind: 'file' });
    files.set('/outside-project/Overview.md', 'outside overview');
  }

  const identityFs: IdentityFs = {
    async realpath(filePath: string) {
      if (filePath === '/project') return '/real/project';
      if (filePath === '/project/Overview.md') {
        if (target === 'new') throw enoent(filePath);
        if (target === 'existing') return '/real/project/Overview.md';
        return '/outside-project/Overview.md';
      }
      if (nodes.has(filePath)) return filePath;
      throw enoent(filePath);
    },
    async stat(filePath: string) {
      const node = nodes.get(filePath);
      if (!node) throw enoent(filePath);
      return identityStat(node);
    },
    async lstat(filePath: string) {
      const temp = tempNodes.get(filePath);
      if (temp) return identityStat(temp);
      if (filePath === '/project/Overview.md' && target === 'new') throw enoent(filePath);
      const node = nodes.get(filePath);
      if (!node) throw enoent(filePath);
      return identityStat(node);
    },
  };

  const backend: DescriptorAtomicWriteBackend = {
    async mkdir() {
      calls.push('mkdir');
      throw new Error('Overview root must not be recreated');
    },
    async writeFile() {
      throw new Error('Overview writes must use an exclusive descriptor');
    },
    async rename(tempPath, targetPath) {
      calls.push(`rename:${targetPath}`);
      const node = tempNodes.get(tempPath);
      if (!node) throw enoent(tempPath);
      tempNodes.delete(tempPath);
      files.set(targetPath, node.content);
      nodes.set(targetPath, { ...node, kind: 'file' });
    },
    async unlink(tempPath) {
      calls.push(`unlink:${tempPath}`);
      tempNodes.delete(tempPath);
    },
    async fsyncFile() {
      throw new Error('Overview writes must sync the exclusive descriptor');
    },
    randomId() {
      return `overview-${++nextId}`;
    },
    async openExclusiveTemp(tempPath: string): Promise<ExclusiveTempFileHandle> {
      if (tempNodes.has(tempPath)) throw Object.assign(new Error(`EEXIST: ${tempPath}`), { code: 'EEXIST' });
      const node: OverviewNode = { content: '', dev: 10n, ino: nextIno++, kind: 'file' };
      tempNodes.set(tempPath, node);
      calls.push(`open:${tempPath}`);
      return {
        async writeFile(data) {
          node.content = String(data);
          calls.push(`write:${tempPath}`);
        },
        async sync() {
          calls.push(`sync:${tempPath}`);
        },
        async stat() {
          return { dev: node.dev, ino: node.ino };
        },
        async close() {
          calls.push(`close:${tempPath}`);
        },
      };
    },
  };

  return { backend, calls, files, identityFs, tempNodes };
}

function wizardServiceForTarget(
  target: OverviewTarget,
  revalidateApprovedProjectWrite: () => Promise<boolean> = async () => true,
) {
  const writes = new Map<string, string>();
  const overview = createOverviewWriteHarness(target);
  const service = createWizardService({
    userDataPath: '/app',
    fs: {
      async mkdir() {},
      async writeFile(filePath: string, content: string) {
        writes.set(filePath, content);
      },
      async readFile(filePath: string) {
        const content = writes.get(filePath);
        if (content === undefined) throw enoent(filePath);
        return content;
      },
      async readdir() {
        return [] as any;
      },
      async stat() {
        return { size: 0 } as any;
      },
      async lstat(filePath: string) {
        if (filePath !== '/project/Overview.md' || target === 'new') throw enoent(filePath);
        return { isSymbolicLink: () => target === 'symlink' };
      },
      async realpath(filePath: string) {
        if (target === 'existing-realpath-escape' && filePath === '/project/Overview.md') {
          return '/outside-project/Overview.md';
        }
        return filePath.replace('/project', '/real/project');
      },
    },
    now: () => '2026-05-15T14:40:32+09:00',
    loadContextStack: async () => ({ ownerLoaded: true, systemlawLoaded: true, overviewLoaded: true }),
    revalidateApprovedProjectWrite,
    overviewWrite: { backend: overview.backend, identityFs: overview.identityFs },
  });
  return { service, writes, overview };
}

async function saveOverview(service: ReturnType<typeof createWizardService>) {
  await service.start('/project');
  return service.saveApprovedDraft({
    projectFolder: '/project',
    body: '## Purpose\nDemo.',
    frontmatter: {},
    inherits: true,
    lastScanned: null,
  });
}

describe('project wizard service', () => {
  it('starts a project wizard in consent stage without writing Overview.md', async () => {
    const writes: string[] = [];
    const service = createWizardService({
      userDataPath: '/app',
      fs: {
        async mkdir() {},
        async writeFile(filePath: string) {
          writes.push(filePath);
        },
        async readFile() {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        },
        async readdir() {
          return [] as any;
        },
        async stat() {
          return { size: 0 } as any;
        },
        async lstat() {
          return { isSymbolicLink: () => false };
        },
        async realpath(filePath: string) {
          return filePath;
        },
      },
      now: () => '2026-05-15T14:40:32+09:00',
      loadContextStack: async () => ({ ownerLoaded: true, systemlawLoaded: true, overviewLoaded: true }),
      revalidateApprovedProjectWrite: async () => true,
    });

    const state = await service.start('/project');

    expect(state.stage).toBe('consent');
    expect(state.overviewPath).toBe('/project/Overview.md');
    expect(state.stageStatements[0]).toMatchObject({
      stage: 'consent',
      message: 'Project Wizard started',
    });
    expect(writes.some((p) => p.endsWith('Overview.md'))).toBe(false);
  });

  it('marks partially ready when Owner and Overview load but systemlaw does not', async () => {
    const writes = new Map<string, string>();
    const overview = createOverviewWriteHarness();
    const service = createWizardService({
      userDataPath: '/app',
      fs: {
        async mkdir() {},
        async writeFile(filePath: string, content: string) {
          writes.set(filePath, content);
        },
        async readFile(filePath: string) {
          const content = writes.get(filePath);
          if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          return content;
        },
        async readdir() {
          return [] as any;
        },
        async stat() {
          return { size: 0 } as any;
        },
        async lstat() {
          return { isSymbolicLink: () => false };
        },
        async realpath(filePath: string) {
          return filePath;
        },
      },
      now: () => '2026-05-15T14:40:32+09:00',
      loadContextStack: async () => ({ ownerLoaded: true, systemlawLoaded: false, overviewLoaded: true }),
      revalidateApprovedProjectWrite: async () => true,
      overviewWrite: { backend: overview.backend, identityFs: overview.identityFs },
    });

    await service.start('/project');
    const result = await service.saveApprovedDraft({
      projectFolder: '/project',
      body: '## Purpose\nDemo.',
      frontmatter: {},
      inherits: true,
      lastScanned: null,
    });

    expect(result.status).toBe('partially_ready');
    expect(result.overviewPath).toBe('/project/Overview.md');
    expect(result.markdown).toContain('last_modified: 2026-05-15T14:40:32+09:00');
  });

  it('marks ready when Owner, systemlaw, and Overview all load', async () => {
    const writes = new Map<string, string>();
    const overview = createOverviewWriteHarness();
    const service = createWizardService({
      userDataPath: '/app',
      fs: {
        async mkdir() {},
        async writeFile(filePath: string, content: string) {
          writes.set(filePath, content);
        },
        async readFile(filePath: string) {
          const content = writes.get(filePath);
          if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          return content;
        },
        async readdir() {
          return [] as any;
        },
        async stat() {
          return { size: 0 } as any;
        },
        async lstat() {
          return { isSymbolicLink: () => false };
        },
        async realpath(filePath: string) {
          return filePath;
        },
      },
      now: () => '2026-05-15T14:40:32+09:00',
      loadContextStack: async () => ({ ownerLoaded: true, systemlawLoaded: true, overviewLoaded: true }),
      revalidateApprovedProjectWrite: async () => true,
      overviewWrite: { backend: overview.backend, identityFs: overview.identityFs },
    });

    await service.start('/project');
    const result = await service.saveApprovedDraft({
      projectFolder: '/project',
      body: '## Purpose\nDemo.',
      frontmatter: {},
      inherits: true,
      lastScanned: null,
    });

    expect(result.status).toBe('ready');
    expect(overview.files.get('/project/Overview.md')).toContain('# Overview');
    expect(JSON.parse(writes.get('/app/project-wizard-state.json') ?? '{}')).toMatchObject({
      projectFolder: '/project',
      stage: 'approved',
    });
  });

  it('saves a new Overview.md target after resolving its parent inside the project', async () => {
    const { service, overview } = wizardServiceForTarget('new');

    await saveOverview(service);

    expect(overview.files.get('/project/Overview.md')).toContain('# Overview');
  });

  it('saves an existing non-symlink Overview.md target inside the project', async () => {
    const { service, overview } = wizardServiceForTarget('existing');

    await saveOverview(service);

    expect(overview.files.get('/project/Overview.md')).toContain('# Overview');
  });

  it('atomically replaces an Overview.md leaf symlink without following it', async () => {
    const { service, overview } = wizardServiceForTarget('symlink');

    await saveOverview(service);

    expect(overview.files.get('/project/Overview.md')).toContain('# Overview');
    expect(overview.files.get('/outside-project/Overview.md')).toBe('outside overview');
    expect(overview.calls).toEqual([
      'open:/project/Overview.md.overview-1.tmp',
      'write:/project/Overview.md.overview-1.tmp',
      'sync:/project/Overview.md.overview-1.tmp',
      'rename:/project/Overview.md',
      'close:/project/Overview.md.overview-1.tmp',
    ]);
  });

  it('atomically replaces an existing Overview.md alias without following its canonical target', async () => {
    const { service, overview } = wizardServiceForTarget('existing-realpath-escape');

    await saveOverview(service);

    expect(overview.files.get('/project/Overview.md')).toContain('# Overview');
    expect(overview.files.get('/outside-project/Overview.md')).toBe('outside overview');
  });

  it('rejects a new Overview.md before opening a temp descriptor when root authority is stale', async () => {
    let revalidationCalls = 0;
    const { service, overview } = wizardServiceForTarget('new', async () => {
      revalidationCalls += 1;
      return false;
    });

    await expect(saveOverview(service)).rejects.toThrow('Project folder is not authorized');

    expect(revalidationCalls).toBe(1);
    expect(overview.calls).toEqual([]);
    expect(overview.files.has('/project/Overview.md')).toBe(false);
  });

  it('revalidates again immediately before rename and removes the temp on revocation', async () => {
    let revalidationCalls = 0;
    const { service, overview } = wizardServiceForTarget('new', async () => {
      revalidationCalls += 1;
      return revalidationCalls === 1;
    });

    await expect(saveOverview(service)).rejects.toThrow('Project folder is not authorized');

    expect(revalidationCalls).toBe(2);
    expect(overview.calls).toEqual([
      'open:/project/Overview.md.overview-1.tmp',
      'write:/project/Overview.md.overview-1.tmp',
      'sync:/project/Overview.md.overview-1.tmp',
      'close:/project/Overview.md.overview-1.tmp',
      'unlink:/project/Overview.md.overview-1.tmp',
    ]);
    expect(overview.files.has('/project/Overview.md')).toBe(false);
  });

  it('never recreates the authorized project root during an Overview save', async () => {
    const { service, overview } = wizardServiceForTarget('new');

    await saveOverview(service);

    expect(overview.calls.some((call) => call === 'mkdir')).toBe(false);
  });
  it('rejects saving an approved draft before the wizard starts', async () => {
    const service = createWizardService({
      userDataPath: '/app',
      fs: {
        async mkdir() {},
        async writeFile() {},
        async readFile() {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        },
        async readdir() {
          return [] as any;
        },
        async stat() {
          return { size: 0 } as any;
        },
        async lstat() {
          return { isSymbolicLink: () => false };
        },
        async realpath(filePath: string) {
          return filePath;
        },
      },
      now: () => '2026-05-15T14:40:32+09:00',
      loadContextStack: async () => ({ ownerLoaded: true, systemlawLoaded: true, overviewLoaded: true }),
      revalidateApprovedProjectWrite: async () => true,
    });

    await expect(
      service.saveApprovedDraft({
        projectFolder: '/project',
        body: '## Purpose\nDemo.',
        frontmatter: {},
        inherits: true,
        lastScanned: null,
      }),
    ).rejects.toThrow('Project Wizard has not been started');
  });
  it('rejects an absolute project folder that differs from the started wizard scope', async () => {
    const { service, overview } = wizardServiceForTarget('new');
    await service.start('/project');

    await expect(
      service.saveApprovedDraft({
        projectFolder: '/different-project',
        body: '## Purpose\nDemo.',
        frontmatter: {},
        inherits: true,
        lastScanned: null,
      }),
    ).rejects.toThrow('Project Wizard has not been started for this folder');

    expect(overview.calls).toEqual([]);
    expect(overview.files.has('/different-project/Overview.md')).toBe(false);
  });

  it('loads context readiness from actual files instead of fallback defaults', async () => {
    const files = new Map<string, string>([
      ['/app/Owner.md', '# Owner'],
      ['/project/Overview.md', '# Overview'],
    ]);
    const loadContextStack = createContextStackLoader('/app', {
      async readFile(filePath) {
        const content = files.get(filePath);
        if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return content;
      },
    });

    await expect(loadContextStack('/project', '/project/Overview.md')).resolves.toEqual({
      ownerLoaded: true,
      systemlawLoaded: false,
      overviewLoaded: true,
    });
  });

  it('validates save-approved-draft IPC payload shape', () => {
    expect(
      isProjectWizardSaveApprovedDraftInput({
        projectFolder: '/project',
        body: '## Purpose\nDemo.',
        frontmatter: {},
        inherits: true,
        lastScanned: null,
      }),
    ).toBe(true);

    expect(isProjectWizardSaveApprovedDraftInput({ projectFolder: '/project' })).toBe(false);
    expect(
      isProjectWizardSaveApprovedDraftInput({
        projectFolder: 'relative/project',
        body: '## Purpose\nDemo.',
        frontmatter: {},
        inherits: true,
        lastScanned: null,
      }),
    ).toBe(false);
    expect(
      isProjectWizardSaveApprovedDraftInput({
        projectFolder: '/project',
        body: '## Purpose\nDemo.',
        frontmatter: [],
        inherits: true,
        lastScanned: null,
      }),
    ).toBe(false);
  });
});
