import type { SubscriptionProvider } from '../../shared/auth-protocol';
import { getSubscriptionLoginService } from '../ai/subscription-login';
import { handleTrusted } from '../ipc-guard';
import type { ProviderRegistry } from '../ai/provider-registry';

function isSubscriptionProvider(value: unknown): value is SubscriptionProvider {
  return value === 'claude' || value === 'grok';
}

export function registerProviderAuthIpc({ getRegistry }: { getRegistry: () => ProviderRegistry }): void {
  const login = getSubscriptionLoginService();
  const record = (provider: SubscriptionProvider, state: 'succeeded' | 'unknown') => getRegistry().recordCliAuthResult(provider, state);
  handleTrusted('auth:provider-login', async (event, provider: unknown) => {
    if (!isSubscriptionProvider(provider)) throw new Error('Unknown subscription provider');
    await login.start(provider, event.sender, record);
  });
  handleTrusted('auth:provider-submit-code', async (_event, args: { provider?: unknown; code?: unknown }) => {
    if (!isSubscriptionProvider(args?.provider) || typeof args.code !== 'string') throw new Error('Invalid login code');
    login.submitCode(args.provider, args.code);
  });
  handleTrusted('auth:provider-cancel-login', async (_event, provider: unknown) => {
    if (!isSubscriptionProvider(provider)) throw new Error('Unknown subscription provider');
    login.cancel(provider);
  });
  handleTrusted('auth:provider-logout', async (_event, provider: unknown) => {
    if (!isSubscriptionProvider(provider)) throw new Error('Unknown subscription provider');
    await login.logout(provider, record);
  });
}
