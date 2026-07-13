import { shell } from 'electron';
import { buildMinimalEnv, nodeCliSpawn, type CliProcess, type CliSpawn } from './cli-runner';
import { resolveTrustedCliCommand, type TrustedCliResult } from './cli-trust';
import type { SubscriptionLoginUpdate, SubscriptionProvider } from '../../shared/auth-protocol';

const LOGIN_TIMEOUT_MS = 15 * 60_000;
const KILL_GRACE_MS = 1_000;
const OUTPUT_CAP = 64 * 1024;

type LoginSender = {
  isDestroyed(): boolean;
  send(channel: string, update: SubscriptionLoginUpdate): void;
  once?(event: 'destroyed', listener: () => void): void;
};

type ActiveLogin = {
  sender: LoginSender;
  terminal: boolean;
  timer: ReturnType<typeof setTimeout>;
  killTimer: ReturnType<typeof setTimeout> | null;
  process: CliProcess | null;
  provider: SubscriptionProvider;
  operation: 'login' | 'logout';
  phase: 'preparing' | 'login' | 'verify' | 'logout';
  sawValidUrl: boolean;
  sawCodePrompt: boolean;
  openPending: boolean;
  loginExitCode: number | null | undefined;
  command?: string;
  env?: Record<string, string>;
  onResult?: (provider: SubscriptionProvider, state: 'succeeded' | 'unknown') => void;
  onLogout?: (provider: SubscriptionProvider, state: 'unknown') => void;
};
const DISCARDED_SENDER: LoginSender = {
  isDestroyed: () => true,
  send: () => {},
};

export type SubscriptionLoginDeps = {
  spawn: CliSpawn;
  resolveCommand: (provider: SubscriptionProvider) => Promise<TrustedCliResult>;
  buildEnv: () => Promise<Record<string, string>>;
  openExternal: (url: string) => Promise<void>;
  timeoutMs: number;
  killGraceMs?: number;
};

const defaults: SubscriptionLoginDeps = {
  spawn: nodeCliSpawn(),
  resolveCommand: resolveTrustedCliCommand,
  buildEnv: buildMinimalEnv,
  openExternal: (url) => shell.openExternal(url),
  timeoutMs: LOGIN_TIMEOUT_MS,
  killGraceMs: KILL_GRACE_MS,
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

function isLoggedInClaudeStatus(output: string): boolean {
  try {
    const parsed: unknown = JSON.parse(output.trim());
    return typeof parsed === 'object' && parsed !== null && (parsed as { loggedIn?: unknown }).loggedIn === true;
  } catch {
    return false;
  }
}

export class SubscriptionLoginService {
  private readonly active = new Map<SubscriptionProvider, ActiveLogin>();

  constructor(private readonly deps: SubscriptionLoginDeps = defaults) {}

  async start(provider: SubscriptionProvider, sender: LoginSender, onResult?: (provider: SubscriptionProvider, state: 'succeeded' | 'unknown') => void): Promise<void> {
    if (this.active.has(provider)) throw new Error('A login is already in progress for this provider.');
    // Reserve synchronously before any asynchronous command/env work. This prevents
    // concurrent starts from spawning multiple provider CLIs.
    const entry = this.reserve(provider, sender, onResult);
    sender.once?.('destroyed', () => this.cancelEntry(entry));
    if (sender.isDestroyed()) {
      this.cancelEntry(entry);
      return;
    }
    try {
      const trusted = await this.deps.resolveCommand(provider);
      if (!this.isCurrent(entry)) return;
      if (!('command' in trusted)) return this.fail(entry, { kind: 'error', provider, code: 'cli_unavailable' });
      const env = await this.deps.buildEnv();
      if (!this.isCurrent(entry)) return;
      entry.command = trusted.command;
      entry.env = env;
      const args = provider === 'grok' ? ['login', '--device-auth'] : ['auth', 'login', '--claudeai'];
      this.attachLoginProcess(entry, this.deps.spawn(trusted.command, args, { env, cwd: env.HOME || process.cwd() }));
    } catch {
      if (this.isCurrent(entry)) this.fail(entry, { kind: 'error', provider, code: 'login_failed' });
    }
  }

  submitCode(provider: SubscriptionProvider, code: string): void {
    if (provider !== 'claude' || !/\S/.test(code)) return;
    const entry = this.active.get(provider);
    if (!entry || !this.isCurrent(entry)) return;
    const stdin = entry.operation === 'login' && entry.phase === 'login' ? entry.process?.stdin : null;
    if (!stdin || stdin.writable === false) return;
    try {
      stdin.write(`${code.trim()}\n`);
    } catch {
      // Late/duplicate user input must never crash the main process.
    }
  }

  cancel(provider: SubscriptionProvider): void {
    const entry = this.active.get(provider);
    if (!entry) return;
    if (entry.operation === 'logout') this.finishLogout(entry);
    else this.cancelEntry(entry);
  }

  async logout(provider: SubscriptionProvider, onResult?: (provider: SubscriptionProvider, state: 'unknown') => void): Promise<void> {
    if (this.active.has(provider)) throw new Error('A login is already in progress for this provider.');
    const entry = this.reserve(provider, DISCARDED_SENDER);
    entry.operation = 'logout';
    entry.phase = 'logout';
    entry.onLogout = onResult;
    try {
      const trusted = await this.deps.resolveCommand(provider);
      if (!this.isCurrent(entry)) return;
      if (!('command' in trusted)) return this.finishLogout(entry);
      const env = await this.deps.buildEnv();
      if (!this.isCurrent(entry)) return;
      const child = this.deps.spawn(trusted.command, provider === 'grok' ? ['logout'] : ['auth', 'logout'], { env, cwd: env.HOME || process.cwd() });
      if (!this.isCurrent(entry)) return this.killDetached(child);
      entry.process = child;
      this.absorbStdinErrors(child);
      child.on('error', () => this.finishLogout(entry));
      child.on('close', () => {
        if (entry.process === child) entry.process = null;
        this.clearKillTimer(entry);
        if (entry.terminal) return this.release(entry);
        this.finishLogout(entry);
      });
      child.stdin?.end();
    } catch {
      if (this.isCurrent(entry)) this.finishLogout(entry);
    }
  }

  private reserve(provider: SubscriptionProvider, sender: LoginSender, onResult?: ActiveLogin['onResult']): ActiveLogin {
    const entry = {} as ActiveLogin;
    entry.sender = sender;
    entry.provider = provider;
    entry.terminal = false;
    entry.operation = 'login';
    entry.phase = 'preparing';
    entry.killTimer = null;
    entry.process = null;
    entry.sawValidUrl = false;
    entry.sawCodePrompt = false;
    entry.openPending = false;
    entry.loginExitCode = undefined;
    entry.onResult = onResult;
    entry.timer = setTimeout(
      () => entry.operation === 'logout'
        ? this.finishLogout(entry)
        : this.fail(entry, { kind: 'error', provider, code: 'timeout' }),
      this.deps.timeoutMs,
    );
    this.active.set(provider, entry);
    return entry;
  }

  private attachLoginProcess(entry: ActiveLogin, child: CliProcess): void {
    if (!this.isCurrent(entry)) {
      this.killDetached(child);
      return;
    }
    entry.process = child;
    this.absorbStdinErrors(child);
    entry.phase = 'login';
    let output = '';
    const consume = (chunk: Buffer | string) => {
      if (entry.terminal) return;
      output = (output + sanitizeLoginOutput(chunk)).slice(-OUTPUT_CAP);
      const candidate = extractUrl(output);
      if (candidate && !entry.sawValidUrl) {
        const url = parseSubscriptionLoginUrl(entry.provider, candidate);
        if (!url) return this.fail(entry, { kind: 'error', provider: entry.provider, code: 'invalid_login_url' });
        entry.sawValidUrl = true;
        entry.openPending = true;
        void this.deps.openExternal(url).then(() => {
          if (entry.terminal) return;
          entry.openPending = false;
          this.emit(entry.sender, { kind: 'opened-url', provider: entry.provider, url, ...(entry.provider === 'grok' ? { code: extractGrokCode(output) } : {}) });
          if (entry.loginExitCode !== undefined) this.completeLoginClose(entry, entry.loginExitCode);
        }).catch(() => this.fail(entry, { kind: 'error', provider: entry.provider, code: 'login_failed' }));
      }
      if (entry.provider === 'claude' && !entry.sawCodePrompt && /paste code here if prompted\s*>?/i.test(output)) {
        entry.sawCodePrompt = true;
        this.emit(entry.sender, { kind: 'awaiting-code', provider: 'claude' });
      }
    };
    child.stdout?.on('data', consume);
    child.stderr?.on('data', consume);
    child.on('error', () => this.fail(entry, { kind: 'error', provider: entry.provider, code: 'login_failed' }));
    child.on('close', (code) => {
      if (entry.process === child) entry.process = null;
      this.clearKillTimer(entry);
      if (entry.terminal) return this.release(entry);
      if (entry.openPending) {
        entry.loginExitCode = code;
        return;
      }
      this.completeLoginClose(entry, code);
    });
    if (entry.provider === 'grok') child.stdin?.end();
  }
  private completeLoginClose(entry: ActiveLogin, code: number | null): void {
    if (entry.terminal) return;
    if (code !== 0 || !entry.sawValidUrl) return this.fail(entry, { kind: 'error', provider: entry.provider, code: 'login_failed' });
    if (entry.provider === 'claude') void this.verifyClaudeStatus(entry);
    else this.finish(entry, { kind: 'success', provider: entry.provider });
  }

  private async verifyClaudeStatus(entry: ActiveLogin): Promise<void> {
    if (!this.isCurrent(entry) || !entry.command || !entry.env) return;
    let output = '';
    try {
      const child = this.deps.spawn(entry.command, ['auth', 'status'], { env: entry.env, cwd: entry.env.HOME || process.cwd() });
      if (!this.isCurrent(entry)) return this.killDetached(child);
      entry.process = child;
      this.absorbStdinErrors(child);
      entry.phase = 'verify';
      const collect = (chunk: Buffer | string) => { output = (output + sanitizeLoginOutput(chunk)).slice(-OUTPUT_CAP); };
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);
      child.on('error', () => this.fail(entry, { kind: 'error', provider: 'claude', code: 'login_failed' }));
      child.on('close', (code) => {
        if (entry.process === child) entry.process = null;
        this.clearKillTimer(entry);
        if (entry.terminal) return this.release(entry);
        if (code === 0 && isLoggedInClaudeStatus(output)) this.finish(entry, { kind: 'success', provider: 'claude' });
        else this.fail(entry, { kind: 'error', provider: 'claude', code: 'login_failed' });
      });
      child.stdin?.end();
    } catch {
      this.fail(entry, { kind: 'error', provider: 'claude', code: 'login_failed' });
    }
  }

  private cancelEntry(entry: ActiveLogin): void {
    if (!this.isCurrent(entry)) return;
    this.fail(entry, { kind: 'cancelled', provider: entry.provider });
  }

  private fail(entry: ActiveLogin, update: Extract<SubscriptionLoginUpdate, { kind: 'error' | 'cancelled' }>): void {
    this.finish(entry, update);
    this.stopProcess(entry);
  }

  private finish(entry: ActiveLogin, update: SubscriptionLoginUpdate): void {
    if (entry.terminal) return;
    entry.terminal = true;
    clearTimeout(entry.timer);
    this.emit(entry.sender, update);
    if (update.kind === 'success') entry.onResult?.(entry.provider, 'succeeded');
    if (!entry.process) this.release(entry);
  }
  private finishLogout(entry: ActiveLogin): void {
    if (entry.terminal) return;
    this.finish(entry, { kind: 'error', provider: entry.provider, code: 'login_failed' });
    entry.onLogout?.(entry.provider, 'unknown');
    this.stopProcess(entry);
  }

  private stopProcess(entry: ActiveLogin): void {
    const child = entry.process;
    if (!child) return this.release(entry);
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    entry.killTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      if (entry.process === child) entry.process = null;
      this.release(entry);
    }, this.killGraceMs);
  }
  /** A child stdin may emit EPIPE asynchronously after end/kill; consume it locally. */
  private absorbStdinErrors(child: CliProcess): void {
    child.stdin?.on?.('error', () => {
      // Expected race during cancellation or a CLI closing its prompt; never crash main.
    });
  }

  private killDetached(child: CliProcess): void {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, this.killGraceMs);
  }

  private clearKillTimer(entry: ActiveLogin): void {
    if (entry.killTimer) clearTimeout(entry.killTimer);
    entry.killTimer = null;
  }

  private release(entry: ActiveLogin): void {
    this.clearKillTimer(entry);
    if (this.active.get(entry.provider) === entry) this.active.delete(entry.provider);
  }

  private isCurrent(entry: ActiveLogin): boolean {
    return this.active.get(entry.provider) === entry && !entry.terminal;
  }

  private get killGraceMs(): number {
    return this.deps.killGraceMs ?? KILL_GRACE_MS;
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
