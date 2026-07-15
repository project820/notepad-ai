/**
 * claude-composed.ts — the registry-facing Claude provider for v0.7: CLI-first
 * (claude -p, cost-free subscription) with automatic Anthropic API fallback when
 * the CLI is unavailable or fails before any output. Image/multimodal requests
 * always go straight to the API path (the CLI is text-only in v0.7). This is the
 * thin composition wrapper the plan calls for; the standalone ClaudeProvider
 * remains the pure API provider (used here as the fallback). (G006)
 */

import type { ApiKeyStore } from './api-key-store';
import { ClaudeProvider } from './claude-provider';
import { ClaudeCliProvider } from './claude-cli-provider';
import { FallbackProvider } from './fallback-provider';
import { buildMinimalEnv, type CliProcess, type CliSpawn } from './cli-runner';
import { resolveTrustedCliCommand, type TrustedCliResult } from './cli-trust';
import type { AiChatEvent, AiChatRequest, AiProvider, ModelRef, ProviderAuthStatus } from './types';
const CLI_AUTH_PROBE_CACHE_MS = 30_000;
const CLI_AUTH_PROBE_TIMEOUT_MS = 5_000;
const CLI_AUTH_PROBE_OUTPUT_CAP = 64 * 1024;

type CliAuthProbe = {
  installed: boolean;
  state: 'unknown' | 'succeeded' | 'auth_failed';
};

function parseClaudeAuthStatus(output: string): boolean | null {
  try {
    const parsed: unknown = JSON.parse(output.trim());
    const loggedIn = (parsed as { loggedIn?: unknown } | null)?.loggedIn;
    return typeof loggedIn === 'boolean' ? loggedIn : null;
  } catch {
    return null;
  }
}
export class ComposedClaudeProvider implements AiProvider {
  readonly id = 'claude' as const;
  readonly authKind = 'api_key' as const;
  private readonly api: ClaudeProvider;
  private readonly cli: ClaudeCliProvider;
  private readonly fallback: FallbackProvider;
  private claudeAuthState: CliAuthProbe['state'] = 'unknown';
  private cliInstalled = false;
  private cliStatusCheckedAt = 0;
  private cliStatusProbe: Promise<CliAuthProbe> | null = null;
  private cliAuthGeneration = 0;

  constructor(
    keys: ApiKeyStore,
    private readonly spawn: CliSpawn,
    private readonly resolveCommand?: () => Promise<TrustedCliResult>,
  ) {
    this.api = new ClaudeProvider(keys);
    this.cli = new ClaudeCliProvider({ spawn, resolveCommand });
    this.fallback = new FallbackProvider(this.cli, this.api, {
      onPrimaryError: (event) => {
        if (event.errorKind === 'auth') this.cacheCliAuthState('auth_failed', true);
      },
      onPrimaryCommit: () => {
        this.cacheCliAuthState('succeeded', true);
      },
    });
  }

  /** Login lifecycle results update the bounded status cache until the next re-probe. */
  recordCliAuthResult(state: 'succeeded' | 'unknown' | 'auth_failed'): void {
    this.cliAuthGeneration++;
    this.cacheCliAuthState(state, state !== 'unknown' || this.cliInstalled);
  }

  async getAuthStatus(): Promise<ProviderAuthStatus> {
    const [apiStatus, cliProbe] = await Promise.all([
      this.api.getAuthStatus(),
      this.refreshCliAuthStatus(),
    ]);
    const cliStatus = cliProbe.installed
      ? cliProbe.state === 'auth_failed'
        ? { installed: true, authState: 'auth_failed' as const, errorCode: 'claude_cli_login_required' as const }
        : cliProbe.state === 'unknown'
          ? { installed: true, authState: 'unknown' as const, errorCode: 'claude_cli_auth_unknown' as const }
          : { installed: true, authState: 'succeeded' as const }
      : { installed: false, authState: 'unknown' as const, errorCode: 'claude_cli_setup_required' as const };

    if (apiStatus.connected) {
      return {
        ...apiStatus,
        connectionSource: 'api_key',
        label: 'Claude (CLI-first · API key)',
        cliStatus,
      };
    }
    if (cliProbe.installed && cliProbe.state === 'succeeded') {
      return {
        provider: 'claude',
        authKind: 'api_key',
        connected: true,
        connectionSource: 'cli',
        label: 'Claude (CLI)',
        cliStatus,
      };
    }
    return {
      provider: 'claude',
      authKind: 'api_key',
      connected: false,
      label: 'Claude',
      ...(cliProbe.installed ? {} : { errorCode: 'claude_cli_setup_required' as const }),
      cliStatus,
    };
  }

  private cacheCliAuthState(state: CliAuthProbe['state'], installed: boolean): void {
    this.claudeAuthState = state;
    this.cliInstalled = installed;
    this.cliStatusCheckedAt = Date.now();
  }

  private async refreshCliAuthStatus(): Promise<CliAuthProbe> {
    if (this.cliStatusProbe) return this.cliStatusProbe;
    if (Date.now() - this.cliStatusCheckedAt < CLI_AUTH_PROBE_CACHE_MS) {
      return { installed: this.cliInstalled, state: this.claudeAuthState };
    }
    const generation = this.cliAuthGeneration;
    const probe = this.probeCliAuthStatus().then((result) => {
      if (generation === this.cliAuthGeneration) {
        this.cacheCliAuthState(result.state, result.installed);
        return result;
      }
      return { installed: this.cliInstalled, state: this.claudeAuthState };
    });
    this.cliStatusProbe = probe;
    void probe.finally(() => {
      if (this.cliStatusProbe === probe) this.cliStatusProbe = null;
    });
    return probe;
  }

  private async probeCliAuthStatus(): Promise<CliAuthProbe> {
    const trusted = await (this.resolveCommand?.() ?? resolveTrustedCliCommand('claude')).catch(
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
        child = this.spawn(trusted.command, ['auth', 'status', '--json'], { env, cwd: env.HOME || process.cwd() });
        const collect = (chunk: Buffer | string) => {
          output = (output + (typeof chunk === 'string' ? chunk : chunk.toString('utf-8'))).slice(-CLI_AUTH_PROBE_OUTPUT_CAP);
        };
        child.stdout?.on('data', collect);
        child.stderr?.on('data', collect);
        child.on('error', () => finish({ installed: true, state: 'unknown' }));
        child.on('close', () => {
          const loggedIn = parseClaudeAuthStatus(output);
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
    return this.api.listModels();
  }

  async streamChat(req: AiChatRequest, onEvent: (e: AiChatEvent) => void): Promise<void> {
    // §5.3: the HTML export surface is CLI-only — pin it BEFORE the image→API
    // divert so an html request can never be pushed onto the paid API. The HTML
    // transport never carries images, but check the pin first to stay fail-closed.
    if (req.surfaceMode === 'html') {
      await this.cli.streamChat(req, onEvent);
      return;
    }
    // v0.7: the CLI is text-only — image turns go directly to the Anthropic API.
    if (req.images && req.images.length > 0) {
      await this.api.streamChat(req, onEvent);
      return;
    }
    // Everything else (incl. HTML export with a max-output budget) stays CLI-first:
    // `claude -p` runs on the user's SUBSCRIPTION (no per-token billing), and it
    // handles model-id remapping itself. We deliberately do NOT divert to the paid
    // Anthropic API just to pass a maxOutputTokens budget — a subscriber must not be
    // silently pushed onto per-request billing. The CLI's own default output cap
    // applies; the API path remains ONLY the automatic fallback when the CLI fails.
    await this.fallback.streamChat(req, onEvent);
  }
}
