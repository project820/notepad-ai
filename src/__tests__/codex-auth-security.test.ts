import { describe, it, expect, vi, beforeEach } from 'vitest';

// S1/S2: credential boundary. Mock electron + node:fs so we can drive
// codex-auth without network or a real Keychain.
const h = vi.hoisted(() => ({
  writeFile: vi.fn(),
  readFile: vi.fn(),
  mkdir: vi.fn(),
  unlink: vi.fn(),
  openExternal: vi.fn(),
  state: { encryptionAvailable: true },
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/notepad-ai-test-userdata' },
  safeStorage: {
    isEncryptionAvailable: () => h.state.encryptionAvailable,
    encryptString: (s: string) => Buffer.from(s, 'utf-8'),
    decryptString: (b: Buffer) => b.toString('utf-8'),
  },
  shell: { openExternal: h.openExternal },
}));

vi.mock('node:fs', () => ({
  promises: { writeFile: h.writeFile, readFile: h.readFile, mkdir: h.mkdir, unlink: h.unlink },
}));

beforeEach(() => {
  vi.resetModules();
  h.writeFile.mockReset();
  h.readFile.mockReset();
  h.mkdir.mockReset();
  h.unlink.mockReset();
  h.state.encryptionAvailable = true;
  delete process.env.NOTEPAD_AI_OPENAI_ACCESS_TOKEN;
  delete process.env.NOTEPAD_AI_OPENAI_REFRESH_TOKEN;
});

describe('codex-auth credential boundary (S1/S2)', () => {
  it('S1: getStatus exposes no token fields to the renderer', async () => {
    h.state.encryptionAvailable = true;
    const stored = {
      access_token: 'SECRET_ACCESS_TOKEN',
      refresh_token: 'SECRET_REFRESH_TOKEN',
      id_token: 'SECRET_ID_TOKEN',
      email: 'user@example.com',
      plan: 'pro',
      obtained_at: Math.floor(Date.now() / 1000),
      expires_in: 3600,
    };
    h.readFile.mockResolvedValue(Buffer.from(JSON.stringify(stored), 'utf-8'));

    const { getStatus } = await import('../main/codex-auth');
    const snap = await getStatus();

    expect(snap.signedIn).toBe(true);
    expect(snap.email).toBe('user@example.com');
    expect(snap.plan).toBe('pro');
    expect(snap.persisted).toBe(true);
    // No secret material may leak through the snapshot.
    expect((snap as Record<string, unknown>).accessToken).toBeUndefined();
    expect((snap as Record<string, unknown>).access_token).toBeUndefined();
    expect((snap as Record<string, unknown>).refreshToken).toBeUndefined();
    expect((snap as Record<string, unknown>).idToken).toBeUndefined();
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toContain('SECRET_ACCESS_TOKEN');
    expect(serialized).not.toContain('SECRET_REFRESH_TOKEN');
    expect(serialized).not.toContain('SECRET_ID_TOKEN');
  });

  it('S2: when safeStorage is unavailable, no plaintext is written and env is the read-only fallback', async () => {
    h.state.encryptionAvailable = false;
    process.env.NOTEPAD_AI_OPENAI_ACCESS_TOKEN = 'ENV_ACCESS_TOKEN';
    h.readFile.mockResolvedValue(Buffer.from('PLAINTEXT_SHOULD_NEVER_BE_READ', 'utf-8'));

    const { getStatus } = await import('../main/codex-auth');
    const snap = await getStatus();

    expect(snap.signedIn).toBe(true); // via env credential source
    expect(snap.persisted).toBe(false); // memory/env only, not persisted to disk
    expect(h.writeFile).not.toHaveBeenCalled(); // never write plaintext
    expect(JSON.stringify(snap)).not.toContain('ENV_ACCESS_TOKEN');
  });

  it('S2: no auth + no env + no encryption → signed out, no disk write', async () => {
    h.state.encryptionAvailable = false;
    h.readFile.mockRejectedValue(new Error('ENOENT'));

    const { getStatus } = await import('../main/codex-auth');
    const snap = await getStatus();

    expect(snap.signedIn).toBe(false);
    expect(h.writeFile).not.toHaveBeenCalled();
  });
});
