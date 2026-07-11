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

export type CloseCommitResult = boolean | { retry: readonly CloseTarget[] };

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
    commit: (transaction: CloseTransaction) => Promise<void | CloseCommitResult>,
  ): Promise<CloseTransactionResult> {
    if (this.inFlight) {
      // A window close joins a process-wide quit/relaunch transaction, but an
      // unrelated close must not inherit another window's approval.
      if (intent === 'close' && this.inFlightIntent !== 'close') return this.inFlight;
      if (intent === this.inFlightIntent && intent !== 'close') return this.inFlight;
      return Promise.resolve({ approved: false, intent });
    }

    const run = (async (): Promise<CloseTransactionResult> => {
      const decisions = new Map<number, CloseDecision>();
      let pending = [...targets];
      for (let attempts = 0; pending.length > 0; attempts += 1) {
        if (attempts >= 8) return { approved: false, intent };
        for (const target of pending) {
          const decision = await decide(target);
          if (decision === 'cancel') return { approved: false, intent };
          decisions.set(target.windowId, decision);
        }
        const discards = targets.filter((target) => decisions.get(target.windowId) === 'discard');
        const committed = await commit({ intent, targets, discards });
        if (committed !== false && !(typeof committed === 'object' && 'retry' in committed)) {
          return { approved: true, intent };
        }
        pending = typeof committed === 'object' && 'retry' in committed ? [...committed.retry] : [];
        if (pending.length === 0) return { approved: false, intent };
      }
      return { approved: false, intent };
    })();
    this.inFlightIntent = intent;
    this.inFlight = run.finally(() => {
      this.inFlight = null;
      this.inFlightIntent = null;
    });
    return this.inFlight;
  }
}
