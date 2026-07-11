export type CloseIntent = 'close' | 'quit' | 'relaunch';
export type CloseDecision = 'allow' | 'discard' | 'cancel';

export type CloseTarget = {
  windowId: number;
  windowKey: string;
};

export type CloseTransaction = {
  intent: CloseIntent;
  targets: readonly CloseTarget[];
  discards: readonly CloseTarget[];
};

export type CloseTransactionResult = {
  approved: boolean;
  intent: CloseIntent;
};

/**
 * Serializes every teardown path. Decisions are collected without side effects;
 * the supplied commit runs exactly once only after every target has approved.
 */
export class CloseCoordinator {
  private inFlight: Promise<CloseTransactionResult> | null = null;
  private inFlightIntent: CloseIntent | null = null;

  request(
    intent: CloseIntent,
    targets: readonly CloseTarget[],
    decide: (target: CloseTarget) => Promise<CloseDecision>,
    commit: (transaction: CloseTransaction) => Promise<void>,
  ): Promise<CloseTransactionResult> {
    if (this.inFlight) {
      // A window close joins a process-wide quit/relaunch transaction, but an
      // unrelated close must not inherit another window's approval.
      if (intent === 'close' && this.inFlightIntent !== 'close') return this.inFlight;
      if (intent === this.inFlightIntent && intent !== 'close') return this.inFlight;
      return Promise.resolve({ approved: false, intent });
    }

    const run = (async (): Promise<CloseTransactionResult> => {
      const discards: CloseTarget[] = [];
      for (const target of targets) {
        const decision = await decide(target);
        if (decision === 'cancel') return { approved: false, intent };
        if (decision === 'discard') discards.push(target);
      }
      await commit({ intent, targets, discards });
      return { approved: true, intent };
    })();
    this.inFlightIntent = intent;
    this.inFlight = run.finally(() => {
      this.inFlight = null;
      this.inFlightIntent = null;
    });
    return this.inFlight;
  }
}
