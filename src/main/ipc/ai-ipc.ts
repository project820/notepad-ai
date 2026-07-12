import type { ChatTurn } from '../codex-client';
import { handleTrusted } from '../ipc-guard';
import { htmlExportMaxTokens, isHtmlExportInstructions } from '../ai/output-budget';
import { isAiProviderId, validateImageAttachments, validateChatTextPayload, type AiProviderId, type ReasoningEffort } from '../ai/types';
import type { ProviderRegistry } from '../ai/provider-registry';

type AiIpcDeps = {
  getRegistry: () => ProviderRegistry;
};

const activeChats = new Map<string, AbortController>();

function chatKey(webContentsId: number, id: string): string {
  return `${webContentsId}:${id}`;
}

export function abortChatsForWebContents(webContentsId: number): void {
  const prefix = `${webContentsId}:`;
  for (const [key, controller] of activeChats) {
    if (key.startsWith(prefix)) {
      controller.abort();
      activeChats.delete(key);
    }
  }
}

export function registerAiIpc({ getRegistry }: AiIpcDeps): void {
  handleTrusted('ai:chat', async (
    event,
    payload: {
      id: string;
      instructions: string;
      history: ChatTurn[];
      userText: string;
      model?: string | { provider: AiProviderId; id: string };
      surfaceMode?: string;
      images?: unknown;
      reasoningEffort?: ReasoningEffort;
    },
  ) => {
    const shapeCheck = validateChatTextPayload(payload);
    if (!shapeCheck.ok) {
      const id = typeof payload?.id === 'string' ? payload.id : 'unknown';
      event.sender.send(`ai:chat:${id}`, { kind: 'error', message: shapeCheck.error, errorKind: 'provider' });
      return;
    }
    const controller = new AbortController();
    const sender = event.sender;
    const key = chatKey(sender.id, payload.id);
    activeChats.get(key)?.abort();
    activeChats.set(key, controller);
    const model =
      typeof payload.model === 'string'
        ? { provider: 'chatgpt' as AiProviderId, id: payload.model }
        : payload.model && isAiProviderId(payload.model.provider)
          ? payload.model
          : { provider: 'chatgpt' as AiProviderId, id: 'gpt-5.4-mini' };
    const imgCheck = validateImageAttachments(payload.images);
    if (!imgCheck.ok) {
      sender.send(`ai:chat:${payload.id}`, { kind: 'error', message: imgCheck.error, errorKind: 'provider' });
      activeChats.delete(key);
      return;
    }
    try {
      await getRegistry().streamProviderChat(
        {
          instructions: payload.instructions,
          history: payload.history,
          userText: payload.userText,
          model,
          surfaceMode:
            payload.surfaceMode === 'write' ||
            payload.surfaceMode === 'advise' ||
            payload.surfaceMode === 'html' ||
            payload.surfaceMode === 'block'
              ? payload.surfaceMode
              : undefined,
          images: imgCheck.images.length ? imgCheck.images : undefined,
          reasoningEffort: payload.reasoningEffort,
          signal: controller.signal,
          maxOutputTokens: isHtmlExportInstructions(payload.instructions)
            ? htmlExportMaxTokens(model.provider, model.id)
            : undefined,
        },
        (e) => sender.send(`ai:chat:${payload.id}`, e),
      );
    } finally {
      if (activeChats.get(key) === controller) activeChats.delete(key);
    }
  });

  handleTrusted('ai:cancel', async (event, id: string) => {
    const key = chatKey(event.sender.id, id);
    activeChats.get(key)?.abort();
    activeChats.delete(key);
  });
  handleTrusted('ai:models', async (_e, force?: boolean) => getRegistry().getAvailableModels(force === true));
  handleTrusted('ai:reasoning-capabilities', async () => getRegistry().getReasoningCapabilities());
  handleTrusted('local-ai:get-config', async () => getRegistry().getLocalConfig());
  handleTrusted('local-ai:set-config', async (_e, partial: { ollama?: string; lmstudio?: string }) =>
    getRegistry().setLocalConfig(partial ?? {}));
}
