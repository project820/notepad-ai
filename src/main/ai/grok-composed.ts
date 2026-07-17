/**
 * grok-composed.ts — registry-facing Grok provider.
 *
 * A saved xAI API key makes the OpenAI-compatible API the primary transport.
 * Without one, Grok uses the user's local CLI. API-to-CLI fallback is deliberately
 * narrow: only a shared model and a pre-output missing-key, transport-unavailable,
 * or auth-startup failure may switch transports.
 */

import type { ApiKeyStore } from './api-key-store';
import { buildMinimalEnv, type CliProcess, type CliSpawn } from './cli-runner';
import { resolveTrustedCliCommand, type TrustedCliResult } from './cli-trust';
import { FallbackProvider, type StreamSource } from './fallback-provider';
import { GrokCliProvider } from './grok-cli-provider';
import { XaiApiProvider } from './xai-api-provider';
import type { AiChatEvent, AiChatRequest, AiProvider, ModelRef, ProviderAuthStatus } from './types';

/** Only this model is verified on both the xAI API and the local Grok CLI. */
const SHARED_TRANSPORT_MODEL_IDS = new Set(['grok-4.5']);
const CLI_AUTH_PROBE_CACHE_MS = 30_000;
const CLI_AUTH_PROBE_TIMEOUT_MS = 5_000;
const CLI_AUTH_PROBE_OUTPUT_CAP = 64 * 1024;

type CliAuthProbe = {
  installed: boolean;
  state: 'unknown' | 'succeeded' | 'auth_failed';
};

function parseGrokAuthStatus(output: string): boolean | null {
  if (/\byou are logged in with grok\.com\b/i.test(output)) return true;
  if (/\byou are not authenticated\b|\bnot logged in\b/i.test(output)) return false;
  return null;
}

type GrokTransportOverrides = {
  api?: XaiApiProvider;
  cli?: GrokCliProvider;
};

export class ComposedGrokProvider implements AiProvider {
  readonly id = 'grok' as const;
  readonly authKind = 'api_key' as const;
  private readonly api: XaiApiProvider;
  private readonly cli: GrokCliProvider;
  private readonly fallback: FallbackProvider;
  private cliAuthState: CliAuthProbe['state'] = 'unknown';
  private cliInstalled = false;
  private cliStatusCheckedAt = 0;
  private cliStatusProbe: Promise<CliAuthProbe> | null = null;
  private cliAuthGeneration = 0;
  private readonly hasInjectedCli: boolean;

  constructor(
    keys: ApiKeyStore,
    private readonly spawn: CliSpawn,
    private readonly resolveCommand?: () => Promise<TrustedCliResult>,
    transports: GrokTransportOverrides = {},
  ) {
    this.api = transports.api ?? new XaiApiProvider(keys);
    this.cli = transports.cli ?? new GrokCliProvider({ spawn, resolveCommand });
    this.hasInjectedCli = transports.cli !== undefined;
    const cliSource: StreamSource = { streamChat: (req, onEvent) => this.streamCli(req, onEvent) };
    this.fallback = new FallbackProvider(this.api, cliSource, {
      // The generic renderer taxonomy intentionally remains unchanged. These are
      // composer-local meanings: auth before output includes a key that vanished
      // after selection (missing-key) or API authentication startup failure;
      // network before output is transport-unavailable. Provider/rate/cancel errors
      // (including invalid-model and policy failures) never cross transports.
      shouldFallback: (event) => event.errorKind === 'auth' || event.errorKind === 'network',
    });
  }

  /** Login lifecycle results update the bounded status cache until the next re-probe. */
  recordCliAuthResult(state: 'succeeded' | 'unknown' | 'auth_failed'): void {
    this.cliAuthGeneration++;
    this.cacheCliAuthState(state, state !== 'unknown' || this.cliInstalled);
  }

  private async streamCli(req: AiChatRequest, onEvent: (event: AiChatEvent) => void): Promise<void> {
    await this.cli.streamChat(req, (event) => {
      if (event.kind === 'delta' || event.kind === 'done') this.cacheCliAuthState('succeeded', true);
      if (event.kind === 'error' && event.errorKind === 'auth') this.cacheCliAuthState('auth_failed', true);
      onEvent(event);
    });
  }

  async getAuthStatus(): Promise<ProviderAuthStatus> {
    const [apiStatus, cliProbe] = await Promise.all([this.api.getAuthStatus(), this.readCliAuthStatus()]);
    const cliStatus = cliProbe.installed
      ? cliProbe.state === 'auth_failed'
        ? { installed: true, authState: 'auth_failed' as const, errorCode: 'grok_cli_auth_unknown' as const }
        : cliProbe.state === 'succeeded'
          ? { installed: true, authState: 'succeeded' as const }
          : { installed: true, authState: 'unknown' as const, errorCode: 'grok_cli_auth_unknown' as const }
      : { installed: false, authState: 'unknown' as const, errorCode: 'grok_cli_setup_required' as const };

    if (apiStatus.connected) {
      return {
        ...apiStatus,
        label: 'Grok (xAI API · CLI fallback)',
        cliStatus,
      };
    }
    if (cliProbe.installed && cliProbe.state === 'succeeded') {
      return {
        provider: 'grok',
        authKind: 'api_key',
        connected: true,
        connectionSource: 'cli',
        label: 'Grok (CLI)',
        cliStatus,
      };
    }
    return {
      ...apiStatus,
      label: 'Grok (xAI API · CLI fallback)',
      ...(cliProbe.installed ? {} : { errorCode: 'grok_cli_setup_required' as const }),
      cliStatus,
    };
  }

  private cacheCliAuthState(state: CliAuthProbe['state'], installed: boolean): void {
    this.cliAuthState = state;
    this.cliInstalled = installed;
    this.cliStatusCheckedAt = Date.now();
  }

  private async readCliAuthStatus(): Promise<CliAuthProbe> {
    if (!this.hasInjectedCli) return this.refreshCliAuthStatus();
    const raw = await this.cli.getAuthStatus();
    return { installed: raw.installed === true, state: this.cliAuthState };
  }

  private async refreshCliAuthStatus(): Promise<CliAuthProbe> {
    if (this.cliStatusProbe) return this.cliStatusProbe;
    if (Date.now() - this.cliStatusCheckedAt < CLI_AUTH_PROBE_CACHE_MS) {
      return { installed: this.cliInstalled, state: this.cliAuthState };
    }
    const generation = this.cliAuthGeneration;
    const probe = this.probeCliAuthStatus().then((result) => {
      if (generation === this.cliAuthGeneration) {
        this.cacheCliAuthState(result.state, result.installed);
        return result;
      }
      return { installed: this.cliInstalled, state: this.cliAuthState };
    });
    this.cliStatusProbe = probe;
    void probe.finally(() => {
      if (this.cliStatusProbe === probe) this.cliStatusProbe = null;
    });
    return probe;
  }

  private async probeCliAuthStatus(): Promise<CliAuthProbe> {
    const trusted = await (this.resolveCommand?.() ?? resolveTrustedCliCommand('grok')).catch(
      (): TrustedCliResult => ({ error: 'CLI command resolution failed.' }),
    );
    if ('error' in trusted) return { installed: false, state: 'unknown' };

    const env = await buildMinimalEnv().catch(() => null);
    if (!env) return { installed: true, state: 'unknown' };
    return new Promise<CliAuthProbe>((resolve) => {
      let child: CliProcess | undefined;
      let output = '';
      let settled = false;
      const finish = (probe: CliAuthProbe) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(probe);
      };
      const timeout = setTimeout(() => {
        try { child?.kill('SIGTERM'); } catch { /* already gone */ }
        finish({ installed: true, state: 'unknown' });
        setTimeout(() => {
          try { child?.kill('SIGKILL'); } catch { /* already gone */ }
        }, 1_000);
      }, CLI_AUTH_PROBE_TIMEOUT_MS);

      try {
        child = this.spawn(trusted.command, ['models'], { env, cwd: env.HOME || process.cwd() });
        const collect = (chunk: Buffer | string) => {
          output = (output + (typeof chunk === 'string' ? chunk : chunk.toString('utf-8'))).slice(-CLI_AUTH_PROBE_OUTPUT_CAP);
        };
        child.stdout?.on('data', collect);
        child.stderr?.on('data', collect);
        child.on('error', () => finish({ installed: true, state: 'unknown' }));
        child.on('close', () => {
          const loggedIn = parseGrokAuthStatus(output);
          finish({ installed: true, state: loggedIn === true ? 'succeeded' : loggedIn === false ? 'auth_failed' : 'unknown' });
        });
        child.stdin?.on?.('error', () => {});
        child.stdin?.end();
      } catch {
        finish({ installed: true, state: 'unknown' });
      }
    });
  }

  async listModels(): Promise<ModelRef[]> {
    const [apiStatus, models] = await Promise.all([this.api.getAuthStatus(), this.api.listModels()]);
    return apiStatus.connected ? models : models.filter((model) => SHARED_TRANSPORT_MODEL_IDS.has(model.id));
  }

  /**
   * HTML-surface transport pick — single source of truth shared with streamChat's
   * surfaceMode==='html' branch (api when xAI key is connected, else CLI).
   * Used by the HTML export generator to label the pinned route honestly.
   */
  async htmlSurfaceTransport(): Promise<'api' | 'cli'> {
    const apiStatus = await this.api.getAuthStatus();
    return apiStatus.connected ? 'api' : 'cli';
  }

  async streamChat(req: AiChatRequest, onEvent: (event: AiChatEvent) => void): Promise<void> {
    const apiStatus = await this.api.getAuthStatus();
    if (req.surfaceMode === 'html') {
      // §5.3: the HTML export surface pins ONE transport — no API↔CLI fallback.
      if (apiStatus.connected) await this.api.streamChat(req, onEvent);
      else await this.streamCli(req, onEvent);
      return;
    }
    if (!apiStatus.connected) {
      await this.streamCli(req, onEvent);
      return;
    }
    if (!SHARED_TRANSPORT_MODEL_IDS.has(req.model.id)) {
      await this.api.streamChat(req, onEvent);
      return;
    }
    await this.fallback.streamChat(req, onEvent);
  }
}
