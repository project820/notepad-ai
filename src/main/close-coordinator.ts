export type CloseIntent = 'close' | 'quit' | 'relaunch' | 'shutdown';
export type CloseDecision = 'allow' | 'discard' | 'cancel';

export type CloseTarget = {
  windowId: number;
  windowKey: string;
};

export type CloseAttemptContext = {
  forwardDeadline: number;
  compensationDeadline: number | null;
  failuresUsed: number;
  quiescedTargets: Set<number>;
};

export type CloseTransaction = {
  intent: CloseIntent;
  targets: readonly CloseTarget[];
  discards: readonly CloseTarget[];
  context: CloseAttemptContext;
};

export type CloseCommitResult = boolean | { retry: readonly CloseTarget[] };

export type CloseTransactionResult = {
  approved: boolean;
  intent: CloseIntent;
};
/**
 * Bounds renderer RPCs without allowing late replies to keep a transaction
 * alive. Callers own request-map cancellation; this helper owns only the race.
 */
export function awaitWithinDeadline<T>(operation: Promise<T>, deadline: number, fallback: T): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.resolve(fallback);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), remaining);
    void operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

export type QuiesceTransaction = {
  prepare: (targets: readonly CloseTarget[], context: CloseAttemptContext) => Promise<boolean>;
  commit: (targets: readonly CloseTarget[], context: CloseAttemptContext) => Promise<void>;
  rollback: (targets: readonly CloseTarget[], context: CloseAttemptContext) => Promise<void>;
};

export function createQuiesceTransaction({
  prepare,
  rollback,
  commit,
  awaitWithinDeadline,
}: {
  prepare: (target: CloseTarget, context: CloseAttemptContext) => Promise<boolean>;
  rollback: (target: CloseTarget, context: CloseAttemptContext) => Promise<void>;
  commit: (target: CloseTarget, context: CloseAttemptContext) => Promise<void>;
  awaitWithinDeadline: <T>(operation: Promise<T>, deadline: number, fallback: T) => Promise<T>;
}): QuiesceTransaction {
  return {
    async prepare(targets, context) {
      const prepared = await Promise.all(targets.map(async (target) => {
        if (context.quiescedTargets.has(target.windowId)) return true;
        const operation = prepare(target, context);
        const accepted = await awaitWithinDeadline(operation, context.forwardDeadline, false);
        if (accepted) {
          context.quiescedTargets.add(target.windowId);
          return true;
        }
        // The RPC may ACK after our deadline. It then owns a renderer fence, so
        // compensate with the same transaction target instead of orphaning it.
        void operation.then((latePrepared) => {
          if (!latePrepared) return;
          context.quiescedTargets.add(target.windowId);
          return rollback(target, context);
        }).catch(() => {});
        return false;
      }));
      return prepared.every(Boolean);
    },
    async commit(targets, context) {
      await Promise.all(targets.map((target) => commit(target, context)));
    },
    async rollback(targets, context) {
      await Promise.all(targets.map((target) => rollback(target, context)));
    },
  };
}

/**
 * Runs one renderer decision loop against the transaction-wide failure budget.
 * A failed authorization is an epoch failure; normal successful windows never
 * consume budget.
 */
export async function runDecideCloseLoop({
  queryState,
  resolveGuard,
  authorize,
  context,
}: {
  queryState: () => Promise<void>;
  resolveGuard: () => Promise<CloseDecision>;
  authorize: () => Promise<boolean>;
  context: CloseAttemptContext;
}): Promise<CloseDecision> {
  for (;;) {
    if (Date.now() >= context.forwardDeadline) return 'cancel';
    await queryState();
    const decision = await resolveGuard();
    if (decision === 'cancel') return 'cancel';
    if (await authorize()) return decision;
    context.failuresUsed += 1;
    if (context.failuresUsed >= 8) return 'cancel';
  }
}

/**
 * Serializes every teardown path. A single context owns retry accounting and
 * compensation, so one failed renderer cannot leave another renderer fenced.
 */
export class CloseCoordinator {
  private inFlight: Promise<CloseTransactionResult> | null = null;
  private inFlightIntent: CloseIntent | null = null;
  waitForIdle(): Promise<void> {
    return this.inFlight ? this.inFlight.then(() => {}) : Promise.resolve();
  }

  request(
    intent: CloseIntent,
    targets: readonly CloseTarget[],
    decide: (target: CloseTarget, context: CloseAttemptContext) => Promise<CloseDecision>,
    commit: (transaction: CloseTransaction) => Promise<void | CloseCommitResult>,
    quiesce?: QuiesceTransaction,
  ): Promise<CloseTransactionResult> {
    if (this.inFlight) {
      if (intent === 'close' && this.inFlightIntent !== 'close') return this.inFlight;
      if (intent === this.inFlightIntent && intent !== 'close') return this.inFlight;
      return Promise.resolve({ approved: false, intent });
    }

    const run = (async (): Promise<CloseTransactionResult> => {
      const context: CloseAttemptContext = {
        forwardDeadline: Date.now() + 5_000,
        compensationDeadline: null,
        failuresUsed: 0,
        quiescedTargets: new Set(),
      };
      const decisions = new Map<number, CloseDecision>();
      let pending = [...targets];
      let approved = false;
      // Empty shutdown targets must still approve: macOS powerMonitor has already
      // preventDefault()'d, so a denial would strand the app and block power-off.
      // Persist the empty shutdown commit (marker + empty windows) then return.
      if (pending.length === 0) {
        if (intent !== 'shutdown') return { approved: false, intent };
        try {
          const committed = await commit({ intent, targets: [], discards: [], context });
          if (committed !== false && !(typeof committed === 'object' && 'retry' in committed)) {
            approved = true;
            return { approved: true, intent };
          }
          return { approved: false, intent };
        } catch {
          return { approved: false, intent };
        }
      }
      try {
        while (pending.length > 0 && Date.now() < context.forwardDeadline) {
          const epoch = await Promise.all(pending.map(async (target) => ({
            target,
            decision: await decide(target, context),
          })));
          if (epoch.some(({ decision }) => decision === 'cancel')) return { approved: false, intent };
          for (const { target, decision } of epoch) decisions.set(target.windowId, decision);
          // Quiescing is a best-effort mutation pause. It cannot veto an
          // approved Save/Discard close; successful targets remain owned and
          // are compensated from finally on an unapproved exit.
          if (quiesce) await quiesce.prepare(targets, context).catch(() => false);
          const discards = targets.filter((target) => decisions.get(target.windowId) === 'discard');
          const committed = await commit({ intent, targets, discards, context });
          if (committed !== false && !(typeof committed === 'object' && 'retry' in committed)) {
            if (quiesce) await quiesce.commit(targets, context);
            approved = true;
            return { approved: true, intent };
          }
          context.failuresUsed += 1;
          if (context.failuresUsed >= 8) return { approved: false, intent };
          pending = typeof committed === 'object' && 'retry' in committed ? [...committed.retry] : [];
        }
        return { approved: false, intent };
      } catch {
        return { approved: false, intent };
      } finally {
        if (!approved && quiesce && context.quiescedTargets.size > 0) {
          context.compensationDeadline = Date.now() + 1_000;
          await quiesce.rollback(targets, context).catch(() => {});
        }
      }
    })();
    this.inFlightIntent = intent;
    this.inFlight = run.finally(() => {
      this.inFlight = null;
      this.inFlightIntent = null;
    });
    return this.inFlight;
  }
}
