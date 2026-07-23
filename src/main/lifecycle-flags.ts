export type CreateWindowOptions = {
  restore?: unknown;
  openFilePath?: string;
  isLaunchWindow?: boolean;
};

export function shouldUseMockKeychain(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.NOTEPAD_AI_USERDATA) && env.NOTEPAD_AI_INTEGRATION_TEST === '1';
}
export type QuitApprovalReason = 'quit' | 'relaunch' | 'shutdown';

export type QuitApprovalController = {
  beginSystemShutdown(): Promise<boolean>;
  requestQuitApproval(): Promise<boolean>;
};

export function createQuitApprovalController({
  waitForCloseTransaction,
  approveAllForQuit,
  clearCloseApprovals,
}: {
  waitForCloseTransaction(): Promise<void>;
  approveAllForQuit(reason: QuitApprovalReason): Promise<boolean>;
  clearCloseApprovals(): void | Promise<void>;
}): QuitApprovalController {
  let shutdownLatched = false;
  let pending: Promise<boolean> | null = null;

  const clearAndDeny = async () => {
    await Promise.resolve(clearCloseApprovals()).catch(() => {});
    return false;
  };

  const start = (): Promise<boolean> => {
    if (pending) return pending;

    pending = (async () => {
      try {
        for (;;) {
          await waitForCloseTransaction();
          const reason: QuitApprovalReason = shutdownLatched ? 'shutdown' : 'quit';
          const approved = await approveAllForQuit(reason);
          if (shutdownLatched && reason !== 'shutdown') continue;
          if (reason === 'shutdown' && !approved) shutdownLatched = false;
          return approved;
        }
      } catch {
        shutdownLatched = false;
        return clearAndDeny();
      }
    })().finally(() => {
      pending = null;
    });
    return pending;
  };

  return {
    beginSystemShutdown() {
      shutdownLatched = true;
      return start();
    },
    requestQuitApproval() {
      return start();
    },
  };
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
