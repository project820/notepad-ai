import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AtomicCliOverrideStore,
  resolveTrustedCliCommand,
  validateCmuxBundleCandidate,
  type CliOverrideBackend,
} from '../main/ai/cli-trust';
import { __resetCliSpawnPathForTests, __setCliProbeForTests, __setShellExecForTests } from '../main/ai/cli-runner';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

async function fixture(): Promise<{ root: string; executable: string; backend: CliOverrideBackend & { saved: () => string | null } }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'notepad-cli-trust-'));
  roots.push(root);
  const executable = path.join(root, 'grok');
  await fs.writeFile(executable, '#!/bin/sh\necho version\n', { mode: 0o700 });
  let saved: string | null = null;
  return {
    root,
    executable,
    backend: {
      readFile: async () => saved,
      writeFile: async (json) => { saved = json; },
      stagingRoot: () => path.join(root, 'staging'),
      saved: () => saved,
    },
  };
}

describe('trusted CLI override', () => {
  it('approves a verified executable, persists its identity, and resolves the staged copy', async () => {
    const f = await fixture();
    const store = new AtomicCliOverrideStore(f.backend);
    const approved = await store.approve('grok', f.executable);
    expect(approved).toHaveProperty('command');
    expect(f.backend.saved()).toContain('sha256');
    const resolved = await resolveTrustedCliCommand('grok', store);
    expect(resolved).toEqual({ command: (approved as { command: string }).command });
    expect(await fs.stat((approved as { command: string }).command)).toMatchObject({ mode: expect.any(Number) });
  });

  it('refuses spawning after an approved source is swapped', async () => {
    const f = await fixture();
    const store = new AtomicCliOverrideStore(f.backend);
    await store.approve('grok', f.executable);
    await fs.writeFile(f.executable, '#!/bin/sh\necho replaced\n', { mode: 0o700 });
    const resolved = await resolveTrustedCliCommand('grok', store);
    expect(resolved).toHaveProperty('error');
  });

  it('detects a staged artifact swap before it can be spawned', async () => {
    const f = await fixture();
    const store = new AtomicCliOverrideStore(f.backend);
    const approved = await store.approve('grok', f.executable) as { command: string };
    await fs.writeFile(approved.command, '#!/bin/sh\necho replaced\n', { mode: 0o700 });
    const resolved = await resolveTrustedCliCommand('grok', store);
    expect(resolved).toHaveProperty('error');
  });

  it('rejects an executable in a world-writable parent directory', async () => {
    const f = await fixture();
    const unsafe = path.join(f.root, 'unsafe');
    await fs.mkdir(unsafe, { mode: 0o777 });
    await fs.chmod(unsafe, 0o777);
    const executable = path.join(unsafe, 'grok');
    await fs.writeFile(executable, '#!/bin/sh\n', { mode: 0o700 });
    const store = new AtomicCliOverrideStore(f.backend);
    expect(await store.approve('grok', executable)).toHaveProperty('error');
    expect(await store.get('grok')).toBeNull();
  });

  it('requires the selected executable to pass its static version check', async () => {
    const f = await fixture();
    await fs.writeFile(f.executable, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    const store = new AtomicCliOverrideStore(f.backend);
    expect(await store.approve('grok', f.executable)).toHaveProperty('error');
    expect(await store.get('grok')).toBeNull();
  });
  it('accepts only the expected executable inside a fixed cmux bundle root', async () => {
    const f = await fixture();
    const bundle = path.join(f.root, 'cmux.app', 'Contents', 'Resources', 'bin');
    await fs.mkdir(bundle, { recursive: true, mode: 0o700 });
    const grok = path.join(bundle, 'grok');
    await fs.writeFile(grok, '#!/bin/sh\n', { mode: 0o700 });
    await expect(validateCmuxBundleCandidate('grok', grok, bundle)).resolves.toMatchObject({ realpath: await fs.realpath(grok) });
    await expect(validateCmuxBundleCandidate('grok', f.executable, bundle)).rejects.toThrow('canonical cmux bundle');
  });
  it('does not activate a half-applied override when the atomic config write fails', async () => {
    const f = await fixture();
    const store = new AtomicCliOverrideStore({ ...f.backend, writeFile: async () => { throw new Error('disk full'); } });
    expect(await store.approve('grok', f.executable)).toHaveProperty('error');
    expect(await store.get('grok')).toBeNull();
  });
  it('auto-registers an identity-verified login-shell PATH executable as a staged trusted command', async () => {
    const f = await fixture();
    const agy = path.join(f.root, 'agy');
    await fs.writeFile(agy, '#!/bin/sh\necho version\n', { mode: 0o700 });
    const store = new AtomicCliOverrideStore(f.backend);
    __resetCliSpawnPathForTests();
    __setShellExecForTests(async () => `GJC_PATH=${f.root}`);
    __setCliProbeForTests(() => true);

    try {
      const resolved = await resolveTrustedCliCommand('agy', store);

      expect(resolved).toHaveProperty('command');
      expect((resolved as { command: string }).command).toContain('/staging/agy-');
      expect(await store.get('agy')).not.toBeNull();
    } finally {
      __resetCliSpawnPathForTests();
    }
  });
});
