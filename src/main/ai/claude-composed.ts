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
import type { AiChatEvent, AiChatRequest, AiProvider, ModelRef, ProviderAuthStatus } from './types';

export class ComposedClaudeProvider implements AiProvider {
  readonly id = 'claude' as const;
  readonly authKind = 'api_key' as const;
  private readonly api: ClaudeProvider;
  private readonly cli: ClaudeCliProvider;
  private readonly fallback: FallbackProvider;

  constructor(keys: ApiKeyStore, spawn: CliSpawn) {
    this.api = new ClaudeProvider(keys);
    this.cli = new ClaudeCliProvider({ spawn });
    this.fallback = new FallbackProvider(this.cli, this.api);
  }

  async getAuthStatus(): Promise<ProviderAuthStatus> {
    const apiStatus = await this.api.getAuthStatus();
    if (apiStatus.connected) {
      // API key present — but the CLI is still preferred when available.
      return { ...apiStatus, label: 'Claude (CLI-first · API key)' };
    }
    // No API key: still usable (cost-free) when the claude CLI is installed.
    if (await this.cli.isAvailable()) {
      return { provider: 'claude', authKind: 'api_key', connected: true, label: 'Claude (CLI)' };
    }
    // Neither path available — guide the (free) CLI login first, key as fallback.
    return {
      provider: 'claude',
      authKind: 'api_key',
      connected: false,
      label: 'Claude',
      error:
        'Run `claude login` in a terminal to use the free local CLI (then reopen the app), or paste an Anthropic API key below.',
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
    // HTML export (and any caller) that sets a max-output budget must hit the API
    // path: the CLI argv carries only --model and silently drops maxOutputTokens,
    // so a CLI-first route would leave the budget dead. Only divert when the API
    // key is actually connected; otherwise CLI-first stands (the free path).
    if (req.maxOutputTokens != null && (await this.api.getAuthStatus()).connected) {
      await this.api.streamChat(req, onEvent);
      return;
    }
    await this.fallback.streamChat(req, onEvent);
  }
}
