import { cancelLogin, getStatus, logout, startLogin } from '../codex-auth';
import type { LoginUpdate } from '../../shared/auth-protocol';
import { handleTrusted } from '../ipc-guard';
import { isAiProviderId, type AiProviderId } from '../ai/types';
import type { ProviderRegistry } from '../ai/provider-registry';

export function registerAuthIpc({ getRegistry }: { getRegistry: () => ProviderRegistry }): void {
  handleTrusted('auth:status', async () => getStatus());
  handleTrusted('auth:login', async (event) => {
    const sender = event.sender;
    return new Promise<void>((resolve) => {
      void startLogin((update: LoginUpdate) => {
        if (!sender.isDestroyed()) sender.send('auth:login-update', update);
        if (update.kind === 'success' || update.kind === 'error') resolve();
      });
    });
  });
  handleTrusted('auth:cancel-login', async () => { cancelLogin(); });
  handleTrusted('auth:logout', async () => { await logout(); });
  handleTrusted('auth:providers-status', async () => getRegistry().getAuthStatuses());
  handleTrusted('auth:has-any', async () => getRegistry().hasAnyAuth());
  handleTrusted('auth:set-api-key', async (_e, args: { provider: AiProviderId; key: string }) => {
    if (!isAiProviderId(args?.provider)) throw new Error('Unknown provider');
    return getRegistry().setApiKey(args.provider, args.key);
  });
  handleTrusted('auth:delete-provider-key', async (_e, provider: AiProviderId) => {
    if (!isAiProviderId(provider)) throw new Error('Unknown provider');
    await getRegistry().deleteApiKey(provider);
  });
}
