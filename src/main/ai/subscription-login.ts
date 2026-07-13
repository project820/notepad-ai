import { shell } from 'electron';
import { buildMinimalEnv, nodeCliSpawn, type CliProcess, type CliSpawn } from './cli-runner';
import { resolveTrustedCliCommand, type TrustedCliResult } from './cli-trust';
import type { SubscriptionLoginUpdate, SubscriptionProvider } from '../../shared/auth-protocol';

const LOGIN_TIMEOUT_MS = 15 * 60_000;
const OUTPUT_CAP = 64 * 1024;

type LoginSender = {
  isDestroyed(): boolean;
  send(channel: string, update: SubscriptionLoginUpdate): void;
  once?(event: 'destroyed', listener: () => void): void;
};

type ActiveLogin = {
  process: CliProcess;
  sender: LoginSender;
  terminal: boolean;
  timer: ReturnType<typeof setTimeout>;
  provider: SubscriptionProvider;
  sawValidUrl: boolean;
  sawCodePrompt: boolean;
};

export type SubscriptionLoginDeps = {
  spawn: CliSpawn;
  resolveCommand: (provider: SubscriptionProvider) => Promise<TrustedCliResult>;
  buildEnv: () => Promise<Record<string, string>>;
  openExternal: (url: string) => Promise<void>;
  timeoutMs: number;
};

const defaults: SubscriptionLoginDeps = {
  spawn: nodeCliSpawn(),
  resolveCommand: resolveTrustedCliCommand,
  buildEnv: buildMinimalEnv,
  openExternal: (url) => shell.openExternal(url),
  timeoutMs: LOGIN_TIMEOUT_MS,
};

/** Removes terminal control bytes before parsing CLI chatter. Never persist CLI output. */
export function sanitizeLoginOutput(chunk: Buffer | string): string {
  return (typeof chunk === 'string' ? chunk : chunk.toString('utf-8')).replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '');
}

/** Exact provider URL validation before granting shell.openExternal. */
export function parseSubscriptionLoginUrl(provider: SubscriptionProvider, value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  if (provider === 'grok') {
    return url.hostname === 'accounts.x.ai' && url.pathname.startsWith('/oauth2/device') ? url.toString() : null;
  }
  return url.hostname === 'claude.com' && url.pathname.startsWith('/cai/oauth/authorize') ? url.toString() : null;
}

function extractUrl(buffer: string): string | null {
  // Device URLs often span chunks; only parse once a separator proves completion.
  const match = buffer.match(/https:\/\/[^\s'"<>]+(?=\s)/);
  return match?.[0] ?? null;
}

function extractGrokCode(buffer: string): string | undefined {
  const fromQuery = buffer.match(/[?&]user_code=([^&#\s]+)/i)?.[1];
  const fromText = buffer.match(/(?:user[ -]?code|code)\s*[:=]\s*([A-Z0-9-]{4,})/i)?.[1];
  return fromQuery ?? fromText;
}

export class SubscriptionLoginService {
  private readonly active = new Map<SubscriptionProvider, ActiveLogin>();

  constructor(private readonly deps: SubscriptionLoginDeps = defaults) {}

  async start(provider: SubscriptionProvider, sender: LoginSender, onResult?: (provider: SubscriptionProvider, state: 'succeeded' | 'unknown') => void): Promise<void> {
    if (this.active.has(provider)) throw new Error('A login is already in progress for this provider.');
    const trusted = await this.deps.resolveCommand(provider);
    if (!('command' in trusted)) {
      this.emit(sender, { kind: 'error', provider, code: 'cli_unavailable' });
      return;
    }
    const env = await this.deps.buildEnv();
    const args = provider === 'grok' ? ['login', '--device-auth'] : ['auth', 'login', '--claudeai'];
    const child = this.deps.spawn(trusted.command, args, { env, cwd: env.HOME || process.cwd() });
    let output = '';
    const entry: ActiveLogin = {
      process: child, sender, terminal: false, provider, sawValidUrl: false, sawCodePrompt: false,
      timer: setTimeout(() => this.finish(entry, { kind: 'error', provider, code: 'timeout' }, onResult), this.deps.timeoutMs),
    };
    this.active.set(provider, entry);
    const consume = (chunk: Buffer | string) => {
      if (entry.terminal) return;
      output = (output + sanitizeLoginOutput(chunk)).slice(-OUTPUT_CAP);
      const candidate = extractUrl(output);
      if (candidate && !entry.sawValidUrl) {
        const url = parseSubscriptionLoginUrl(provider, candidate);
        if (!url) return this.finish(entry, { kind: 'error', provider, code: 'invalid_login_url' }, onResult);
        entry.sawValidUrl = true;
        void this.deps.openExternal(url).catch(() => this.finish(entry, { kind: 'error', provider, code: 'login_failed' }, onResult));
        this.emit(sender, { kind: 'opened-url', provider, url, ...(provider === 'grok' ? { code: extractGrokCode(output) } : {}) });
      }
      if (provider === 'claude' && !entry.sawCodePrompt && /paste code here if prompted\s*>?/i.test(output)) {
        entry.sawCodePrompt = true;
        this.emit(sender, { kind: 'awaiting-code', provider: 'claude' });
      }
    };
    child.stdout?.on('data', consume);
    child.stderr?.on('data', consume);
    child.on('error', () => this.finish(entry, { kind: 'error', provider, code: 'login_failed' }, onResult));
    child.on('close', (code) => {
      if (entry.terminal) return;
      this.finish(entry, code === 0 && entry.sawValidUrl ? { kind: 'success', provider } : { kind: 'error', provider, code: 'login_failed' }, onResult);
    });
    sender.once?.('destroyed', () => this.cancel(provider));
    if (provider === 'grok') child.stdin?.end();
  }

  submitCode(provider: SubscriptionProvider, code: string): void {
    if (provider !== 'claude' || !/\S/.test(code)) return;
    const entry = this.active.get(provider);
    if (entry && !entry.terminal) entry.process.stdin?.write(`${code.trim()}\n`);
  }

  cancel(provider: SubscriptionProvider): void {
    const entry = this.active.get(provider);
    if (!entry || entry.terminal) return;
    entry.process.kill('SIGTERM');
    setTimeout(() => { if (!entry.terminal) entry.process.kill('SIGKILL'); }, 1_000);
    this.finish(entry, { kind: 'cancelled', provider });
  }

  async logout(provider: SubscriptionProvider, onResult?: (provider: SubscriptionProvider, state: 'unknown') => void): Promise<void> {
    const trusted = await this.deps.resolveCommand(provider);
    if (!('command' in trusted)) return;
    const env = await this.deps.buildEnv();
    const child = this.deps.spawn(trusted.command, provider === 'grok' ? ['logout'] : ['auth', 'logout'], { env, cwd: env.HOME || process.cwd() });
    await new Promise<void>((resolve) => { child.on('error', () => resolve()); child.on('close', () => resolve()); });
    onResult?.(provider, 'unknown');
  }

  private finish(entry: ActiveLogin, update: SubscriptionLoginUpdate, onResult?: (provider: SubscriptionProvider, state: 'succeeded' | 'unknown') => void): void {
    if (entry.terminal) return;
    entry.terminal = true;
    clearTimeout(entry.timer);
    this.active.delete(entry.provider);
    this.emit(entry.sender, update);
    if (update.kind === 'success') onResult?.(entry.provider, 'succeeded');
  }

  private emit(sender: LoginSender, update: SubscriptionLoginUpdate): void {
    if (!sender.isDestroyed()) sender.send('auth:provider-login-update', update);
  }
}

let service: SubscriptionLoginService | null = null;
export function getSubscriptionLoginService(): SubscriptionLoginService {
  if (!service) service = new SubscriptionLoginService();
  return service;
}
