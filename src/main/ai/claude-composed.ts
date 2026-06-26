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
    if (apiStatus.connected) return apiStatus; // API key present
    // No API key: still usable (cost-free) when the claude CLI is installed.
    if (await this.cli.isAvailable()) {
      return {
        provider: 'claude',
        authKind: 'api_key',
        connected: true,
        label: 'Claude (CLI)',
      };
    }
    return { ...apiStatus, connected: false };
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
    await this.fallback.streamChat(req, onEvent);
  }
}
