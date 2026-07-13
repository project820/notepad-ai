import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CliProcess } from '../main/ai/cli-runner';

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }));

class FakeChild implements CliProcess {
  stdinChunks: string[] = [];
  kills: Array<string | undefined> = [];
  private out: Array<(chunk: string) => void> = [];
  private err: Array<(chunk: string) => void> = [];
  private closes: Array<(code: number | null) => void> = [];
  private errors: Array<(error: Error) => void> = [];
  private stdinErrors: Array<(error: Error) => void> = [];
  stdin = {
    writable: true,
    write: (chunk: string) => this.stdinChunks.push(chunk),
    end: () => {},
    on: (_event: 'error', cb: (error: Error) => void) => this.stdinErrors.push(cb),
  };
  stdout = { on: (_event: 'data', cb: (chunk: string) => void) => this.out.push(cb) };
  stderr = { on: (_event: 'data', cb: (chunk: string) => void) => this.err.push(cb) };
  on(event: 'error' | 'close', cb: ((error: Error) => void) | ((code: number | null) => void)): void {
    if (event === 'close') this.closes.push(cb as (code: number | null) => void);
    else this.errors.push(cb as (error: Error) => void);
  }
  kill(signal?: NodeJS.Signals): void { this.kills.push(signal); }
  emitOut(chunk: string): void { this.out.forEach((cb) => cb(chunk)); }
  close(code: number | null): void { this.closes.forEach((cb) => cb(code)); }
  emitStdinError(error = new Error('EPIPE')): void { this.stdinErrors.forEach((cb) => cb(error)); }
}

const modulePromise = import('../main/ai/subscription-login');
const senderFor = (updates: unknown[]) => ({ isDestroyed: () => false, send: (_channel: string, update: unknown) => updates.push(update) });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

afterEach(() => vi.useRealTimers());

describe('subscription CLI login', () => {
  it('rejects malformed, lookalike, custom scheme, and wrong-path URLs', async () => {
    const { parseSubscriptionLoginUrl } = await modulePromise;
    expect(parseSubscriptionLoginUrl('grok', 'not a url')).toBeNull();
    expect(parseSubscriptionLoginUrl('grok', 'https://accounts.x.ai.evil.test/oauth2/device')).toBeNull();
    expect(parseSubscriptionLoginUrl('claude', 'file:///cai/oauth/authorize')).toBeNull();
    expect(parseSubscriptionLoginUrl('claude', 'https://claude.com/other')).toBeNull();
  });

  it('handles burst/partial Grok output once and completes device login', async () => {
    const { SubscriptionLoginService } = await modulePromise;
    const child = new FakeChild();
    const openExternal = vi.fn(async () => {});
    const service = new SubscriptionLoginService({
      spawn: vi.fn(() => child), resolveCommand: async () => ({ command: '/trusted/grok' }),
      buildEnv: async () => ({ HOME: '/real-home' }), openExternal, timeoutMs: 10_000,
    });
    const updates: unknown[] = [];
    await service.start('grok', senderFor(updates));
    child.emitOut('https://accounts.x.ai/oauth2/de');
    child.emitOut('vice?user_code=ABCD\nWaiting for authorization');
    child.close(0);
    await flush();
    expect(openExternal).toHaveBeenCalledWith('https://accounts.x.ai/oauth2/device?user_code=ABCD');
    expect(updates).toEqual([
      { kind: 'opened-url', provider: 'grok', url: 'https://accounts.x.ai/oauth2/device?user_code=ABCD', code: 'ABCD' },
      { kind: 'success', provider: 'grok' },
    ]);
  });

  it('relays a Claude paste-back code and verifies auth status before success', async () => {
    const { SubscriptionLoginService } = await modulePromise;
    const login = new FakeChild();
    const status = new FakeChild();
    const spawn = vi.fn().mockReturnValueOnce(login).mockReturnValueOnce(status);
    const service = new SubscriptionLoginService({
      spawn, resolveCommand: async () => ({ command: '/trusted/claude' }),
      buildEnv: async () => ({ HOME: '/real-home' }), openExternal: vi.fn(async () => {}), timeoutMs: 10_000,
    });
    const updates: unknown[] = [];
    await service.start('claude', senderFor(updates));
    login.emitOut('https://claude.com/cai/oauth/authorize?code=true\nPaste code here if prompted > ');
    service.submitCode('claude', ' user-code ');
    login.close(0);
    await flush();
    expect(spawn).toHaveBeenNthCalledWith(2, '/trusted/claude', ['auth', 'status', '--json'], expect.any(Object));
    status.emitOut('{"loggedIn":true,"authMethod":"oauth_token"}');
    status.close(0);
    status.close(0);
    expect(login.stdinChunks).toEqual(['user-code\n']);
    expect(updates.filter((update: any) => update.kind === 'success')).toHaveLength(1);
    expect(updates.some((update: any) => update.kind === 'awaiting-code')).toBe(true);
  });

  it('treats Claude loggedIn:false status as login failure', async () => {
    const { SubscriptionLoginService } = await modulePromise;
    const login = new FakeChild();
    const status = new FakeChild();
    const service = new SubscriptionLoginService({
      spawn: vi.fn().mockReturnValueOnce(login).mockReturnValueOnce(status), resolveCommand: async () => ({ command: '/trusted/claude' }),
      buildEnv: async () => ({ HOME: '/real-home' }), openExternal: vi.fn(async () => {}), timeoutMs: 10_000,
    });
    const updates: any[] = [];
    await service.start('claude', senderFor(updates));
    login.emitOut('https://claude.com/cai/oauth/authorize?code=true\n');
    login.close(0);
    await flush();
    status.emitOut('{"loggedIn":false}');
    status.close(0);
    expect(updates.some((update) => update.kind === 'success')).toBe(false);
    expect(updates.at(-1)).toMatchObject({ kind: 'error', provider: 'claude', code: 'login_failed' });
  });

  it('ignores late Claude code while auth-status verification owns the process', async () => {
    const { SubscriptionLoginService } = await modulePromise;
    const login = new FakeChild();
    const status = new FakeChild();
    const statusWrite = vi.fn(() => { throw new Error('write after end'); });
    status.stdin.write = statusWrite;
    const service = new SubscriptionLoginService({
      spawn: vi.fn().mockReturnValueOnce(login).mockReturnValueOnce(status), resolveCommand: async () => ({ command: '/trusted/claude' }),
      buildEnv: async () => ({ HOME: '/real-home' }), openExternal: vi.fn(async () => {}), timeoutMs: 10_000,
    });
    await service.start('claude', senderFor([]));
    login.emitOut('https://claude.com/cai/oauth/authorize?code=true\n');
    login.close(0);
    await flush();
    service.submitCode('claude', 'late-code');
    expect(statusWrite).not.toHaveBeenCalled();
  });
  it('ignores non-writable Claude login stdin', async () => {
    const { SubscriptionLoginService } = await modulePromise;
    const child = new FakeChild();
    child.stdin.writable = false;
    const service = new SubscriptionLoginService({
      spawn: vi.fn(() => child), resolveCommand: async () => ({ command: '/trusted/claude' }),
      buildEnv: async () => ({ HOME: '/real-home' }), openExternal: vi.fn(async () => {}), timeoutMs: 10_000,
    });
    await service.start('claude', senderFor([]));
    service.submitCode('claude', 'late-code');
    expect(child.stdinChunks).toEqual([]);
  });
  it('blocks Claude code immediately after cancel and absorbs asynchronous stdin EPIPE', async () => {
    const { SubscriptionLoginService } = await modulePromise;
    const child = new FakeChild();
    const service = new SubscriptionLoginService({
      spawn: vi.fn(() => child), resolveCommand: async () => ({ command: '/trusted/claude' }),
      buildEnv: async () => ({ HOME: '/real-home' }), openExternal: vi.fn(async () => {}), timeoutMs: 10_000,
    });
    await service.start('claude', senderFor([]));
    service.cancel('claude');
    service.submitCode('claude', 'late-code');
    expect(child.stdinChunks).toEqual([]);
    expect(() => child.emitStdinError()).not.toThrow();
  });

  it('reports unavailable CLI without spawning and releases its slot', async () => {
    const { SubscriptionLoginService } = await modulePromise;
    const spawn = vi.fn();
    const service = new SubscriptionLoginService({
      spawn, resolveCommand: async () => ({ error: 'CLI executable is unavailable.' }),
      buildEnv: async () => ({ HOME: '/real-home' }), openExternal: vi.fn(async () => {}), timeoutMs: 10_000,
    });
    const updates: any[] = [];
    await service.start('grok', senderFor(updates));
    expect(spawn).not.toHaveBeenCalled();
    expect(updates).toEqual([{ kind: 'error', provider: 'grok', code: 'cli_unavailable' }]);
    await expect(service.start('grok', senderFor([]))).resolves.toBeUndefined();
  });
  it('kills a timed-out child with TERM followed by KILL', async () => {
    vi.useFakeTimers();
    const { SubscriptionLoginService } = await modulePromise;
    const child = new FakeChild();
    const service = new SubscriptionLoginService({
      spawn: vi.fn(() => child), resolveCommand: async () => ({ command: '/trusted/grok' }), buildEnv: async () => ({ HOME: '/real-home' }),
      openExternal: vi.fn(async () => {}), timeoutMs: 10, killGraceMs: 1,
    });
    await service.start('grok', senderFor([]));
    await vi.advanceTimersByTimeAsync(10);
    expect(child.kills).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('does not kill again when cancelled after normal completion', async () => {
    const { SubscriptionLoginService } = await modulePromise;
    const child = new FakeChild();
    const service = new SubscriptionLoginService({
      spawn: vi.fn(() => child), resolveCommand: async () => ({ command: '/trusted/grok' }), buildEnv: async () => ({ HOME: '/real-home' }),
      openExternal: vi.fn(async () => {}), timeoutMs: 10_000,
    });
    await service.start('grok', senderFor([]));
    child.emitOut('https://accounts.x.ai/oauth2/device?user_code=ABCD\n');
    child.close(0);
    await flush();
    service.cancel('grok');
    expect(child.kills).toEqual([]);
  });

  it('reserves a provider before awaits so concurrent starts spawn one child', async () => {
    const { SubscriptionLoginService } = await modulePromise;
    const child = new FakeChild();
    let resolveCommand!: (value: { command: string }) => void;
    const service = new SubscriptionLoginService({
      spawn: vi.fn(() => child), resolveCommand: () => new Promise((resolve) => { resolveCommand = resolve; }),
      buildEnv: async () => ({ HOME: '/real-home' }), openExternal: vi.fn(async () => {}), timeoutMs: 10_000,
    });
    const first = service.start('grok', senderFor([]));
    await expect(service.start('grok', senderFor([]))).rejects.toThrow('already in progress');
    resolveCommand({ command: '/trusted/grok' });
    await first;
    expect((service as any).deps.spawn).toHaveBeenCalledTimes(1);
  });
  it('reserves the provider slot for logout, allowing only one concurrent logout child', async () => {
    const { SubscriptionLoginService } = await modulePromise;
    const child = new FakeChild();
    let resolveCommand!: (value: { command: string }) => void;
    const spawn = vi.fn(() => child);
    const service = new SubscriptionLoginService({
      spawn, resolveCommand: () => new Promise((resolve) => { resolveCommand = resolve; }),
      buildEnv: async () => ({ HOME: '/real-home' }), openExternal: vi.fn(async () => {}), timeoutMs: 10_000,
    });
    const first = service.logout('grok');
    await expect(service.logout('grok')).rejects.toThrow('already in progress');
    resolveCommand({ command: '/trusted/grok' });
    await flush();
    expect(spawn).toHaveBeenCalledTimes(1);
    child.close(0);
    await first;
  });
  it('cancels preparation when the sender is destroyed before command resolution', async () => {
    const { SubscriptionLoginService } = await modulePromise;
    const spawn = vi.fn(() => new FakeChild());
    let destroyed = false;
    let destroy!: () => void;
    let resolveCommand!: (value: { command: string }) => void;
    const sender = {
      isDestroyed: () => destroyed,
      send: vi.fn(),
      once: (_event: 'destroyed', listener: () => void) => { destroy = listener; },
    };
    const service = new SubscriptionLoginService({
      spawn, resolveCommand: () => new Promise((resolve) => { resolveCommand = resolve; }),
      buildEnv: async () => ({ HOME: '/real-home' }), openExternal: vi.fn(async () => {}), timeoutMs: 10_000,
    });
    const start = service.start('grok', sender);
    destroyed = true;
    destroy();
    resolveCommand({ command: '/trusted/grok' });
    await start;
    expect(spawn).not.toHaveBeenCalled();
  });

  it('times out logout and escalates its child from TERM to KILL', async () => {
    vi.useFakeTimers();
    const { SubscriptionLoginService } = await modulePromise;
    const child = new FakeChild();
    const service = new SubscriptionLoginService({
      spawn: vi.fn(() => child), resolveCommand: async () => ({ command: '/trusted/grok' }), buildEnv: async () => ({ HOME: '/real-home' }),
      openExternal: vi.fn(async () => {}), timeoutMs: 10, killGraceMs: 1,
    });
    const logout = service.logout('grok');
    await flush();
    await vi.advanceTimersByTimeAsync(10);
    expect(child.kills).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(1);
    await logout;
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL']);
  });
});
