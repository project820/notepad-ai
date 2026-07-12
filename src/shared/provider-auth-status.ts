/** Renderer/main-safe predicate for a provider that can accept an AI request. */
export type AttemptableProviderAuthStatus = {
  connected: boolean;
  authKind: string;
  installed?: boolean;
  authUnverified?: boolean;
  cliStatus?: {
    installed: boolean;
    authState: 'unknown' | 'succeeded' | 'auth_failed';
  };
};

export function isProviderAuthAttemptable(status: AttemptableProviderAuthStatus): boolean {
  return status.connected
    || (status.authKind === 'cli' && status.installed === true && status.authUnverified === true)
    || (status.cliStatus?.installed === true
      && (status.cliStatus.authState === 'unknown' || status.cliStatus.authState === 'succeeded'));
}
