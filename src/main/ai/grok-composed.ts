/**
 * grok-composed.ts — registry-facing Grok provider.
 *
 * A saved xAI API key makes the OpenAI-compatible API the primary transport.
 * Without one, Grok uses the user's local CLI. API-to-CLI fallback is deliberately
 * narrow: only a shared model and a pre-output missing-key, transport-unavailable,
 * or auth-startup failure may switch transports.
 */

import type { ApiKeyStore } from './api-key-store';
import type { CliSpawn } from './cli-runner';
import type { TrustedCliResult } from './cli-trust';
import { FallbackProvider, type StreamSource } from './fallback-provider';
import { GrokCliProvider } from './grok-cli-provider';
import { XaiApiProvider } from './xai-api-provider';
import type { AiChatEvent, AiChatRequest, AiProvider, ModelRef, ProviderAuthStatus } from './types';

/** Only this model is verified on both the xAI API and the local Grok CLI. */
const SHARED_TRANSPORT_MODEL_IDS = new Set(['grok-4.5']);

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
  private cliAuthState: 'unknown' | 'succeeded' | 'auth_failed' = 'unknown';

  constructor(
    keys: ApiKeyStore,
    spawn: CliSpawn,
    resolveCommand?: () => Promise<TrustedCliResult>,
    transports: GrokTransportOverrides = {},
  ) {
    this.api = transports.api ?? new XaiApiProvider(keys);
    this.cli = transports.cli ?? new GrokCliProvider({ spawn, resolveCommand });
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
  /** Login lifecycle evidence is process-local; it is deliberately not persisted. */
  recordCliAuthResult(state: 'succeeded' | 'unknown'): void {
    this.cliAuthState = state;
  }

  private async streamCli(req: AiChatRequest, onEvent: (event: AiChatEvent) => void): Promise<void> {
    await this.cli.streamChat(req, (event) => {
      if (event.kind === 'delta' || event.kind === 'done') this.cliAuthState = 'succeeded';
      if (event.kind === 'error' && event.errorKind === 'auth') this.cliAuthState = 'auth_failed';
      onEvent(event);
    });
  }

  async getAuthStatus(): Promise<ProviderAuthStatus> {
    const [apiStatus, cliRawStatus] = await Promise.all([this.api.getAuthStatus(), this.cli.getAuthStatus()]);
    const installed = cliRawStatus.installed === true;
    const cliStatus = installed
      ? this.cliAuthState === 'auth_failed'
        ? { installed: true, authState: 'auth_failed' as const, errorCode: 'grok_cli_auth_unknown' as const }
        : this.cliAuthState === 'succeeded'
          ? { installed: true, authState: 'succeeded' as const }
          : { installed: true, authState: 'unknown' as const, errorCode: 'grok_cli_auth_unknown' as const }
      : { installed: false, authState: 'unknown' as const, errorCode: 'grok_cli_setup_required' as const };

    return {
      ...apiStatus,
      label: 'Grok (xAI API · CLI fallback)',
      // Top-level connection is intentionally API-key-only. The independent CLI
      // status still makes the registry's attemptability predicate permit CLI use.
      ...(apiStatus.connected || installed ? {} : { errorCode: 'grok_cli_setup_required' as const }),
      cliStatus,
    };
  }

  async listModels(): Promise<ModelRef[]> {
    return this.api.listModels();
  }

  async streamChat(req: AiChatRequest, onEvent: (event: AiChatEvent) => void): Promise<void> {
    const apiStatus = await this.api.getAuthStatus();
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
