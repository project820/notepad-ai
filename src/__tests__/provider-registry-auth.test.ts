import { afterEach, describe, expect, it } from 'vitest';
import { ProviderRegistry, type ProviderMap } from '../main/ai/provider-registry';
import { applyModelDisplayPolicy } from '../main/ai/model-display-policy';
import { GrokCliProvider, type PromptFileWriter } from '../main/ai/grok-cli-provider';
import {
  __resetCliSpawnPathForTests,
  type CliProcess,
  type CliSpawn,
} from '../main/ai/cli-runner';
import type { AiChatEvent, AiChatRequest, AiProvider, AiProviderId, AuthKind, ModelRef, ProviderAuthStatus } from '../main/ai/types';
import type { LocalModelCache } from '../main/ai/local-model-cache';
import type { ApiKeyStore } from '../main/ai/api-key-store';

/** Minimal provider stub — only getAuthStatus matters for hasAnyAuth. */
function provider(id: AiProviderId, authKind: AuthKind, connected: boolean): AiProvider {
  return {
    id,
    authKind,
    async getAuthStatus(): Promise<ProviderAuthStatus> {
      return { provider: id, authKind, connected, label: id };
    },
    async listModels() {
      return [];
    },
    async *streamChat() {
      /* unused */
    },
  } as unknown as AiProvider;
}

/** Fake local-model cache returning a fixed snapshot. */
function cacheWith(models: ModelRef[]): LocalModelCache {
  return {
    snapshot: () => models,
    isStale: () => false,
    refreshInBackground: async () => {},
  } as unknown as LocalModelCache;
}

const noKeys = {
  getKeyStatus: async () => ({ connected: false, persisted: false }),
} as unknown as ApiKeyStore;
const grokApiKeys = {
  getKeyStatus: async () => ({ connected: true, persisted: false }),
} as unknown as ApiKeyStore;
const localModel: ModelRef = { provider: 'ollama', id: 'llama3', label: 'llama3' } as ModelRef;

describe('ProviderRegistry.hasAnyAuth — local is discovery, not auth', () => {
  it('is true when a cloud provider is connected', async () => {
    const map: ProviderMap = {
      chatgpt: provider('chatgpt', 'oauth', true),
      ollama: provider('ollama', 'local', true),
    };
    const reg = new ProviderRegistry(noKeys, map, cacheWith([]));
    expect(await reg.hasAnyAuth()).toBe(true);
  });

  it('is FALSE when only local providers are present but they have no discovered models (offline)', async () => {
    // Local providers statically report connected:true; without models they must
    // NOT satisfy hasAnyAuth, so the user still gets the sign-in nudge.
    const map: ProviderMap = {
      chatgpt: provider('chatgpt', 'oauth', false),
      ollama: provider('ollama', 'local', true),
      lmstudio: provider('lmstudio', 'local', true),
    };
    const reg = new ProviderRegistry(noKeys, map, cacheWith([]));
    expect(await reg.hasAnyAuth()).toBe(false);
  });

  it('is true when a local server is up WITH discovered models, even with no cloud auth', async () => {
    const map: ProviderMap = {
      chatgpt: provider('chatgpt', 'oauth', false),
      ollama: provider('ollama', 'local', true),
    };
    const reg = new ProviderRegistry(noKeys, map, cacheWith([localModel]));
    expect(await reg.hasAnyAuth()).toBe(true);
  });

  it('is false when nothing is connected and no local models exist', async () => {
    const map: ProviderMap = {
      chatgpt: provider('chatgpt', 'oauth', false),
      claude: provider('claude', 'api_key', false),
    };
    const reg = new ProviderRegistry(noKeys, map, cacheWith([]));
    expect(await reg.hasAnyAuth()).toBe(false);
  });
});
describe('ProviderRegistry model aggregation', () => {
  it('includes models listed by Grok rather than only ChatGPT live models', async () => {
    const grok = provider('grok', 'api_key', false);
    grok.listModels = async () => [{
      provider: 'grok',
      id: 'grok-4.5',
      label: 'Grok live',
      humanizeEngineId: 'openai',
      requiresAuth: true,
    }];
    const registry = new ProviderRegistry(noKeys, { grok }, cacheWith([]));

    await expect(registry.getAvailableModels()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'grok', id: 'grok-4.5' }),
    ]));
  });
  it('keeps a stale composer selection out of CLI-only picker inventory but preserves it for API inventory', async () => {
    const composer: ModelRef = {
      provider: 'grok',
      id: 'grok-composer-2.5-fast',
      label: 'Grok Composer 2.5 Fast',
      humanizeEngineId: 'openai',
      requiresAuth: true,
    };
    const shared: ModelRef = {
      provider: 'grok',
      id: 'grok-4.5',
      label: 'Grok 4.5',
      humanizeEngineId: 'openai',
      requiresAuth: true,
    };
    const cliOnly = provider('grok', 'api_key', true);
    cliOnly.listModels = async () => [shared];
    const api = provider('grok', 'api_key', true);
    api.listModels = async () => [shared, composer];
    const currentSelection = { provider: 'grok' as const, id: composer.id };

    const cliPicker = applyModelDisplayPolicy(
      await new ProviderRegistry(noKeys, { grok: cliOnly }, cacheWith([])).getAvailableModels(),
      { currentSelection },
    );
    const apiPicker = applyModelDisplayPolicy(
      await new ProviderRegistry(grokApiKeys, { grok: api }, cacheWith([])).getAvailableModels(),
      { currentSelection },
    );

    expect(cliPicker.map((entry) => entry.id)).toContain('grok-4.5');
    expect(cliPicker.map((entry) => entry.id)).not.toContain(composer.id);
    expect(apiPicker).toContainEqual(expect.objectContaining({ id: composer.id }));
    expect(apiPicker.find((entry) => entry.id === composer.id)).not.toHaveProperty('custom');
  });
  it('filters stale live composer rows without a key in chat and HTML inventories', async () => {
    const composer: ModelRef = {
      provider: 'grok',
      id: 'grok-composer-2.5-fast',
      label: 'Grok Composer 2.5 Fast',
      humanizeEngineId: 'openai',
      requiresAuth: true,
    };
    const shared: ModelRef = {
      provider: 'grok',
      id: 'grok-4.5',
      label: 'Grok 4.5',
      humanizeEngineId: 'openai',
      requiresAuth: true,
    };
    const grok = provider('grok', 'api_key', true);
    grok.listModels = async () => [shared, composer];

    const disconnected = new ProviderRegistry(noKeys, { grok }, cacheWith([]));
    const connected = new ProviderRegistry(grokApiKeys, { grok }, cacheWith([]));

    for (const inventory of [
      disconnected.getAvailableModels(),
      disconnected.getAvailableModelsForHtmlExport(),
    ]) {
      await expect(inventory).resolves.not.toContainEqual(expect.objectContaining({ id: composer.id }));
    }
    for (const inventory of [
      connected.getAvailableModels(),
      connected.getAvailableModelsForHtmlExport(),
    ]) {
      await expect(inventory).resolves.toContainEqual(expect.objectContaining({ id: composer.id }));
    }
  });
});
class FakeChild implements CliProcess {
  private out: Array<(chunk: string) => void> = [];
  private closeCallbacks: Array<(code: number | null) => void> = [];
  stdin = { write: () => {}, end: () => {} };
  stdout = { on: (_event: 'data', callback: (chunk: string) => void) => this.out.push(callback) };
  stderr = { on: (_event: 'data', _callback: (chunk: string) => void) => {} };
  on(event: 'error' | 'close', callback: (...args: never[]) => void) {
    if (event === 'close') this.closeCallbacks.push(callback as (code: number | null) => void);
  }
  kill() {}
  emitOut(chunk: string) { this.out.forEach((callback) => callback(chunk)); }
  close(code: number | null) { this.closeCallbacks.forEach((callback) => callback(code)); }
}

function realGrokProvider(probeExitCode: number, commandFailure?: string) {
  let streamCalls = 0;
  const spawn: CliSpawn = (_command, args) => {
    const child = new FakeChild();
    if (args[0] === '--version') {
      queueMicrotask(() => child.close(probeExitCode));
    } else {
      streamCalls++;
      queueMicrotask(() => child.emitOut(`{"type":"error","message":${JSON.stringify(commandFailure ?? 'unexpected stream')}}\n`));
    }
    return child;
  };
  const writePromptFile: PromptFileWriter = async () => ({
    path: '/tmp/fake-grok-prompt.txt',
    cleanup: async () => {},
  });
  return {
    provider: new GrokCliProvider({
      spawn,
      writePromptFile,
      resolveCommand: async () => ({ command: '/trusted/grok' }),
    }),
    streamCalls: () => streamCalls,
  };
}

function grokProvider(status: ProviderAuthStatus): AiProvider & { streamCalls: number } {
  const result: AiProvider & { streamCalls: number } = {
    id: 'grok',
    authKind: 'cli',
    streamCalls: 0,
    async getAuthStatus() {
      return status;
    },
    async listModels() {
      return [];
    },
    async streamChat() {
      result.streamCalls++;
    },
  };
  return result;
}

const grokRequest: AiChatRequest = {
  instructions: 'system',
  history: [],
  userText: 'hello',
  model: { provider: 'grok', id: 'grok' },
};

afterEach(() => __resetCliSpawnPathForTests());

describe('ProviderRegistry — Grok CLI readiness', () => {
  it('probes an installed CLI, attempts chat, and preserves its command auth failure', async () => {
    const grok = realGrokProvider(0, 'Grok CLI: sign in required');
    const events: AiChatEvent[] = [];

    await new ProviderRegistry(noKeys, { grok: grok.provider }, cacheWith([]))
      .streamProviderChat(grokRequest, (event) => events.push(event));

    expect(grok.streamCalls()).toBe(1);
    expect(events).toEqual([{
      kind: 'error',
      message: 'Grok CLI: sign in required',
      errorKind: 'provider',
    }]);
  });

  it('probes a missing CLI and blocks with setup guidance without invoking streamChat', async () => {
    const grok = realGrokProvider(127);
    const events: AiChatEvent[] = [];

    await new ProviderRegistry(noKeys, { grok: grok.provider }, cacheWith([]))
      .streamProviderChat(grokRequest, (event) => events.push(event));

    expect(grok.streamCalls()).toBe(0);
    expect(events).toEqual([{
      kind: 'error',
      message: 'Grok CLI is unavailable. Install it and run `grok login` in a terminal.',
      errorKind: 'auth',
    }]);
  });

  it('counts only an installed, unverified Grok CLI as usable auth', async () => {
    const installed = realGrokProvider(0);
    const missing = realGrokProvider(127);

    await expect(new ProviderRegistry(noKeys, { grok: installed.provider }, cacheWith([])).hasAnyAuth()).resolves.toBe(true);
    await expect(new ProviderRegistry(noKeys, { grok: missing.provider }, cacheWith([])).hasAnyAuth()).resolves.toBe(false);
  });

  it('blocks a contradictory unverified CLI status in both registry gates', async () => {
    const grok = grokProvider({
      provider: 'grok',
      authKind: 'cli',
      connected: false,
      authUnverified: true,
      installed: false,
      label: 'Grok (CLI)',
      errorCode: 'grok_cli_setup_required',
    });
    const registry = new ProviderRegistry(noKeys, { grok }, cacheWith([]));
    const events: AiChatEvent[] = [];

    await expect(registry.hasAnyAuth()).resolves.toBe(false);
    await registry.streamProviderChat(grokRequest, (event) => events.push(event));

    expect(grok.streamCalls).toBe(0);
    expect(events).toEqual([{
      kind: 'error',
      message: 'Grok CLI is unavailable. Install it and run `grok login` in a terminal.',
      errorKind: 'auth',
    }]);
  });
  it('emits composer-specific key remediation before the unavailable CLI gate', async () => {
    const grok = grokProvider({
      provider: 'grok',
      authKind: 'cli',
      connected: false,
      installed: false,
      label: 'Grok (CLI)',
      errorCode: 'grok_cli_setup_required',
    });
    const events: AiChatEvent[] = [];

    await new ProviderRegistry(noKeys, { grok }, cacheWith([])).streamProviderChat({
      ...grokRequest,
      model: { provider: 'grok', id: 'grok-composer-2.5-fast' },
    }, (event) => events.push(event));

    expect(grok.streamCalls).toBe(0);
    expect(events).toEqual([{
      kind: 'error',
      message: 'grok-composer-2.5-fast requires an xAI API key.',
      errorKind: 'auth',
      errorCode: 'grok_composer_requires_api_key',
    }]);
  });
});
