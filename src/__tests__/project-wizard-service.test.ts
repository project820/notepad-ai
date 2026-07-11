import { describe, it, expect } from 'vitest';
import {
  createContextStackLoader,
  createWizardService,
  isProjectWizardSaveApprovedDraftInput,
} from '../main/project-wizard/service';

function wizardServiceForTarget(target: 'new' | 'existing' | 'symlink') {
  const writes = new Map<string, string>();
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
      async lstat(filePath: string) {
        if (filePath !== '/project/Overview.md' || target === 'new') {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        return { isSymbolicLink: () => target === 'symlink' };
      },
      async realpath(filePath: string) {
        return filePath.replace('/project', '/real/project');
      },
    },
    now: () => '2026-05-15T14:40:32+09:00',
    loadContextStack: async () => ({ ownerLoaded: true, systemlawLoaded: true, overviewLoaded: true }),
  });
  return { service, writes };
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
    expect(writes.get('/project/Overview.md')).toContain('# Overview');
    expect(JSON.parse(writes.get('/app/project-wizard-state.json') ?? '{}')).toMatchObject({
      projectFolder: '/project',
      stage: 'approved',
    });
  });

  it('saves a new Overview.md target after resolving its parent inside the project', async () => {
    const { service, writes } = wizardServiceForTarget('new');

    await saveOverview(service);

    expect(writes.get('/project/Overview.md')).toContain('# Overview');
  });

  it('saves an existing non-symlink Overview.md target inside the project', async () => {
    const { service, writes } = wizardServiceForTarget('existing');

    await saveOverview(service);

    expect(writes.get('/project/Overview.md')).toContain('# Overview');
  });

  it('rejects an Overview.md symlink before writing outside the project', async () => {
    const { service, writes } = wizardServiceForTarget('symlink');

    await expect(saveOverview(service)).rejects.toThrow('symbolic link');

    expect(writes.has('/project/Overview.md')).toBe(false);
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
