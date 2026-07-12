/**
 * The integration coordinator: the only component that advances a default
 * branch, and it does so one candidate at a time under compare-and-swap.
 *
 * {@link processNextEntry} drives a single queued candidate through
 * `rebasing -> testing -> merged`, delegating the actual Git mechanics to an
 * injected {@link IntegrationGitOps}. Keeping the Git side behind an interface
 * makes the decision logic — which state to move to on a conflict, a failed
 * check, or a raced default branch — exhaustively testable with a fake, exactly
 * as {@link planReconciliation}/{@link executeReconciliation} separate policy
 * from provider I/O.
 *
 * The compare-and-swap guard is the core safety property: the coordinator
 * records the default-branch head it rebased onto, and advances the branch only
 * if that head is still current at write time. If another writer (a human push,
 * a concurrent merge) moved it, the candidate is returned to `rebasing` to be
 * re-applied against the new head rather than merged blindly.
 */
import type { GitIntegrationConfig } from './config.js';
import { selectNextEntry, transitionEntry, type QueueEntry } from './queue.js';

/** A conflict-free application of a candidate onto a base commit. */
export interface PreparedCandidate {
  readonly ok: true;
  /** Commit produced by applying the candidate onto the base. */
  readonly rebasedSha: string;
}

/** A candidate that could not be applied cleanly. */
export interface CandidateConflict {
  readonly ok: false;
  /** Redacted, human-readable conflict detail. */
  readonly conflict: string;
}

/** Result of running the configured checks against a prepared candidate. */
export interface CheckRunResult {
  readonly ok: boolean;
  /** Redacted, bounded check output. */
  readonly output?: string;
}

/** A successful atomic advance of the default branch. */
export interface AdvanceOk {
  readonly ok: true;
  /** Commit now reachable from the default branch representing the candidate. */
  readonly mergedSha: string;
}

/** A refused advance because the default branch moved out from under us. */
export interface AdvanceRaced {
  readonly ok: false;
  /** The default-branch head observed at write time (≠ the expected head). */
  readonly actualSha: string;
}

/**
 * The Git operations the coordinator needs. An implementation performs them in
 * a disposable integration checkout against the durable remote; the coordinator
 * itself stays pure. Every method is scoped to one resource's repository.
 */
export interface IntegrationGitOps {
  /** Read the current remote default-branch head. */
  readDefaultBranchSha(): Promise<string>;
  /** Apply `entry.headSha` onto `ontoSha` per the merge strategy. */
  prepareCandidate(
    entry: QueueEntry,
    ontoSha: string,
    config: GitIntegrationConfig,
  ): Promise<PreparedCandidate | CandidateConflict>;
  /** Run the configured checks against the prepared candidate commit. */
  runChecks(rebasedSha: string, checks: readonly string[]): Promise<CheckRunResult>;
  /**
   * Atomically advance the default branch to represent the candidate, but only
   * if its head still equals `expectedSha` (compare-and-swap).
   */
  advanceDefaultBranch(
    expectedSha: string,
    rebasedSha: string,
    config: GitIntegrationConfig,
  ): Promise<AdvanceOk | AdvanceRaced>;
}

/** How a single coordinator step ended. */
export type ProcessOutcome =
  | 'idle' // nothing was queued
  | 'merged' // candidate landed on the default branch
  | 'conflict' // candidate could not be applied; returned to its sandbox
  | 'checks_failed' // candidate applied but required checks failed
  | 'cas_retry'; // default branch advanced mid-flight; candidate re-queued to rebase

/** The result of one {@link processNextEntry} step. */
export interface ProcessResult {
  readonly outcome: ProcessOutcome;
  /** The queue after the step. */
  readonly entries: QueueEntry[];
  /** The entry that was processed, when one was (absent for `idle`). */
  readonly entry?: QueueEntry;
  /** The default-branch head observed at the start of the step. */
  readonly expectedSha?: string;
  /** The new default-branch head when a merge landed. */
  readonly mergedSha?: string;
  /** The default-branch head observed at write time when a CAS retry occurred. */
  readonly observedSha?: string;
}

/** Injectable clock for deterministic observation timestamps. */
export interface CoordinatorDeps {
  readonly now?: () => Date;
}

/**
 * Process at most one queued candidate for a resource under compare-and-swap.
 *
 * The step is: pick the highest-priority queued entry; re-read the default
 * branch; rebase the candidate onto it (→ `conflict` on failure); run the
 * checks (→ `checks_failed` on failure); then advance the default branch iff it
 * still matches the head we rebased onto (→ `cas_retry` on a race, `merged` on
 * success). Returns the mutated queue and a described outcome; a caller loops
 * over this primitive to drain the queue.
 */
export async function processNextEntry(
  entries: readonly QueueEntry[],
  config: GitIntegrationConfig,
  ops: IntegrationGitOps,
  deps: CoordinatorDeps = {},
  resourceKey?: string,
): Promise<ProcessResult> {
  const now = deps.now ?? (() => new Date());
  const candidate = selectNextEntry(entries, resourceKey);
  if (candidate === undefined) return { outcome: 'idle', entries: [...entries] };

  // Re-read the default branch and begin: this head is what we compare-and-swap
  // against at write time, so any advance in between is detected.
  const expectedSha = await ops.readDefaultBranchSha();
  let state = transitionEntry(entries, candidate.entryId, 'rebasing', {
    startedAt: now().toISOString(),
    checks: { state: 'pending' },
  });

  const prepared = await ops.prepareCandidate(candidate, expectedSha, config);
  if (!prepared.ok) {
    const done = transitionEntry(state.entries, candidate.entryId, 'conflict', {
      conflict: prepared.conflict,
    });
    return { outcome: 'conflict', entries: done.entries, entry: done.entry, expectedSha };
  }

  state = transitionEntry(state.entries, candidate.entryId, 'testing', {
    rebasedSha: prepared.rebasedSha,
    checks: { state: 'pending' },
  });

  const checks = await ops.runChecks(prepared.rebasedSha, config.integration.checks);
  if (!checks.ok) {
    const done = transitionEntry(state.entries, candidate.entryId, 'checks_failed', {
      checks: {
        state: 'failed',
        ...(checks.output !== undefined ? { output: checks.output } : {}),
      },
    });
    return { outcome: 'checks_failed', entries: done.entries, entry: done.entry, expectedSha };
  }

  const advance = await ops.advanceDefaultBranch(expectedSha, prepared.rebasedSha, config);
  if (!advance.ok) {
    // The default branch moved under us. Return the candidate to `rebasing` so a
    // later step re-applies it onto the new head; never merge against a stale base.
    const requeued = transitionEntry(state.entries, candidate.entryId, 'rebasing', {
      checks: { state: 'pending' },
    });
    return {
      outcome: 'cas_retry',
      entries: requeued.entries,
      entry: requeued.entry,
      expectedSha,
      observedSha: advance.actualSha,
    };
  }

  const merged = transitionEntry(state.entries, candidate.entryId, 'merged', {
    mergedSha: advance.mergedSha,
    checks: {
      state: 'passed',
      ...(checks.output !== undefined ? { output: checks.output } : {}),
    },
  });
  return {
    outcome: 'merged',
    entries: merged.entries,
    entry: merged.entry,
    expectedSha,
    mergedSha: advance.mergedSha,
  };
}
