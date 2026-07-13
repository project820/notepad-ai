import { describe, expect, it, vi } from 'vitest';
import type { CliProcess } from '../main/ai/cli-runner';

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }));

class FakeChild implements CliProcess {
  stdinChunks: string[] = [];
  kills: Array<string | undefined> = [];
  private out: Array<(chunk: string) => void> = [];
  private err: Array<(chunk: string) => void> = [];
  private closes: Array<(code: number | null) => void> = [];
  private errors: Array<(error: Error) => void> = [];
  stdin = { write: (chunk: string) => this.stdinChunks.push(chunk), end: () => {} };
  stdout = { on: (_event: 'data', cb: (chunk: string) => void) => this.out.push(cb) };
  stderr = { on: (_event: 'data', cb: (chunk: string) => void) => this.err.push(cb) };
  on(event: 'error' | 'close', cb: ((error: Error) => void) | ((code: number | null) => void)): void {
    if (event === 'close') this.closes.push(cb as (code: number | null) => void);
    else this.errors.push(cb as (error: Error) => void);
  }
  kill(signal?: NodeJS.Signals): void { this.kills.push(signal); }
  emitOut(chunk: string): void { this.out.forEach((cb) => cb(chunk)); }
  close(code: number): void { this.closes.forEach((cb) => cb(code)); }
}

const modulePromise = import('../main/ai/subscription-login');

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
    const sender = { isDestroyed: () => false, send: (_channel: string, update: unknown) => updates.push(update) };
    await service.start('grok', sender);
    child.emitOut('https://accounts.x.ai/oauth2/de');
    child.emitOut('vice?user_code=ABCD\nWaiting for authorization');
    child.close(0);
    expect(openExternal).toHaveBeenCalledWith('https://accounts.x.ai/oauth2/device?user_code=ABCD');
    expect(updates).toEqual([
      { kind: 'opened-url', provider: 'grok', url: 'https://accounts.x.ai/oauth2/device?user_code=ABCD', code: 'ABCD' },
      { kind: 'success', provider: 'grok' },
    ]);
  });

  it('relays a Claude paste-back code and emits one terminal event', async () => {
    const { SubscriptionLoginService } = await modulePromise;
    const child = new FakeChild();
    const service = new SubscriptionLoginService({
      spawn: vi.fn(() => child), resolveCommand: async () => ({ command: '/trusted/claude' }),
      buildEnv: async () => ({ HOME: '/real-home' }), openExternal: vi.fn(async () => {}), timeoutMs: 10_000,
    });
    const updates: unknown[] = [];
    const sender = { isDestroyed: () => false, send: (_channel: string, update: unknown) => updates.push(update) };
    await service.start('claude', sender);
    child.emitOut('https://claude.com/cai/oauth/authorize?code=true\nPaste code here if prompted > ');
    service.submitCode('claude', ' user-code ');
    child.close(0);
    child.close(0);
    expect(child.stdinChunks).toEqual(['user-code\n']);
    expect(updates.filter((update: any) => update.kind === 'success')).toHaveLength(1);
    expect(updates.some((update: any) => update.kind === 'awaiting-code')).toBe(true);
  });
});
