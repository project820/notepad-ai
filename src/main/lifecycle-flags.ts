export type CreateWindowOptions = {
  restore?: unknown;
  openFilePath?: string;
  isLaunchWindow?: boolean;
};

export function shouldUseMockKeychain(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.NOTEPAD_AI_USERDATA) && env.NOTEPAD_AI_INTEGRATION_TEST === '1';
}

export function shouldPublishLaunchWindow(opts: CreateWindowOptions): boolean {
  return opts.isLaunchWindow === true && !opts.restore && !opts.openFilePath;
}
export function queueOrOpenFile(
  ready: boolean,
  filePath: string,
  pending: string[],
  openFile: (path: string) => void,
): void {
  if (!ready) {
    // Path-unique: the same document can legitimately arrive through BOTH
    // macOS `open-file` and a `second-instance` argv before readiness; the
    // concurrent flush must never open it twice (double-window race).
    if (!pending.includes(filePath)) pending.push(filePath);
    return;
  }
  openFile(filePath);
}
