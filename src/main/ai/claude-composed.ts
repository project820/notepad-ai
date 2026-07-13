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
import type { CliSpawn } from './cli-runner';
import type { TrustedCliResult } from './cli-trust';
import type { AiChatEvent, AiChatRequest, AiProvider, ModelRef, ProviderAuthStatus } from './types';

export class ComposedClaudeProvider implements AiProvider {
  readonly id = 'claude' as const;
  readonly authKind = 'api_key' as const;
  private readonly api: ClaudeProvider;
  private readonly cli: ClaudeCliProvider;
  private readonly fallback: FallbackProvider;
  private claudeAuthState: 'unknown' | 'succeeded' | 'auth_failed' = 'unknown';

  constructor(keys: ApiKeyStore, spawn: CliSpawn, resolveCommand?: () => Promise<TrustedCliResult>) {
    this.api = new ClaudeProvider(keys);
    this.cli = new ClaudeCliProvider({ spawn, resolveCommand });
    this.fallback = new FallbackProvider(this.cli, this.api, {
      onPrimaryError: (event) => {
        if (event.errorKind === 'auth') this.claudeAuthState = 'auth_failed';
      },
      onPrimaryCommit: () => {
        this.claudeAuthState = 'succeeded';
      },
    });
  }

  async getAuthStatus(): Promise<ProviderAuthStatus> {
    const [apiStatus, installed] = await Promise.all([
      this.api.getAuthStatus(),
      this.cli.isAvailable(),
    ]);
    const cliStatus = installed
      ? this.claudeAuthState === 'auth_failed'
        ? { installed: true, authState: 'auth_failed' as const, errorCode: 'claude_cli_login_required' as const }
        : this.claudeAuthState === 'unknown'
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
    if (installed && this.claudeAuthState === 'succeeded') {
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
      ...(installed ? {} : { errorCode: 'claude_cli_setup_required' as const }),
      cliStatus,
    };
  }

  async listModels(): Promise<ModelRef[]> {
    return this.api.listModels();
  }

  async streamChat(req: AiChatRequest, onEvent: (e: AiChatEvent) => void): Promise<void> {
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
