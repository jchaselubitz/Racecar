/**
 * The reconciliation loop.
 *
 * Racecar keeps no external database — a sandbox's labels are its record — so
 * "what should exist" is derived, not stored. Reconciliation is the periodic
 * sweep that closes the gap between what the provider is actually running and
 * what the lifecycle policy says should still be there. It is the mechanism
 * behind the stage's exit criterion: a week of unattended use with no manual
 * sandbox cleanup.
 *
 * Three gaps get closed:
 *
 *  - **Orphans.** A sandbox the provider reports in `error` (or a leftover
 *    `destroyed` record) is going nowhere. Capture its logs, then delete it.
 *  - **Retention.** An archived sandbox past the project's retention window is
 *    cost with no value. Delete it. (The provider archives; the control plane
 *    owns the final delete.)
 *  - **Stuck runs.** A started sandbox whose run has been going longer than the
 *    run budget is wedged — an agent that will never return. Capture its logs,
 *    then stop the sandbox to free it (and its spend).
 *
 * The planner ({@link planReconciliation}) is pure: it takes observations and a
 * policy and returns the actions to take, so the decision logic is exhaustively
 * testable with no provider. The executor ({@link executeReconciliation})
 * carries them out, capturing a bounded redacted log artifact before any delete
 * or halt.
 */
import type { Redactor } from '../credentials/redaction.js';
import type { SandboxProvider } from '../provider/provider.js';
import type { Sandbox } from '../domain/sandbox.js';
import {
  buildLogArtifact,
  captureLogsScript,
  DEFAULT_LOG_ARTIFACT_MAX_BYTES,
  type LogArtifact,
} from './artifacts.js';

/** How long a run may execute before reconciliation treats it as stuck (3h). */
export const DEFAULT_MAX_RUN_MINUTES = 180;

/** The knobs reconciliation decisions turn on. */
export interface ReconcilePolicy {
  /** Days an archived sandbox is kept before the control plane deletes it. */
  readonly retentionDays: number;
  /** Minutes a run may run before it is considered stuck. */
  readonly maxRunMinutes: number;
}

/** Default reconciliation policy: a week of retention, a 3-hour run budget. */
export const DEFAULT_RECONCILE_POLICY: ReconcilePolicy = {
  retentionDays: 7,
  maxRunMinutes: DEFAULT_MAX_RUN_MINUTES,
};

/**
 * A point-in-time reading of one sandbox that the planner decides on. The
 * caller gathers these (the sandbox from a label listing; the running-run age
 * from an in-sandbox run inspection), keeping the planner free of I/O.
 */
export interface ReconcileObservation {
  readonly sandbox: Sandbox;
  /**
   * Age in minutes of the longest currently-running run in the sandbox, or
   * undefined when nothing is running (or the sandbox could not be inspected).
   */
  readonly runningRunMinutes?: number;
  /** Id of that longest-running run, for the action's reason string. */
  readonly runningRunId?: string;
}

/** The kinds of remediation the planner emits. */
export type ReconcileActionKind = 'orphan-delete' | 'retention-delete' | 'halt-stuck-run';

/** One remediation to perform against one sandbox. */
export interface ReconcileAction {
  readonly kind: ReconcileActionKind;
  readonly sandboxId: string;
  /** Human-readable justification, safe to log (no secrets). */
  readonly reason: string;
  /** Whether the executor should capture a log artifact before acting. */
  readonly captureLogs: boolean;
}

function minutesSince(iso: string | undefined, now: Date): number | undefined {
  if (iso === undefined) return undefined;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return undefined;
  return (now.getTime() - then) / 60_000;
}

/**
 * Decide what to do about a set of observed sandboxes. Pure: same observations,
 * policy, and clock always yield the same actions, in a stable order.
 */
export function planReconciliation(
  observations: readonly ReconcileObservation[],
  policy: ReconcilePolicy = DEFAULT_RECONCILE_POLICY,
  now: () => Date = () => new Date(),
): ReconcileAction[] {
  const at = now();
  const retentionMinutes = policy.retentionDays * 24 * 60;
  const actions: ReconcileAction[] = [];
  for (const { sandbox, runningRunMinutes, runningRunId } of observations) {
    if (sandbox.state === 'error' || sandbox.state === 'destroyed') {
      actions.push({
        kind: 'orphan-delete',
        sandboxId: sandbox.id,
        reason: `sandbox is in '${sandbox.state}' state and cannot recover`,
        captureLogs: true,
      });
      continue;
    }
    if (sandbox.state === 'archived') {
      const idleMinutes = minutesSince(sandbox.lastActivityAt ?? sandbox.createdAt, at);
      if (idleMinutes !== undefined && idleMinutes >= retentionMinutes) {
        const days = (idleMinutes / (24 * 60)).toFixed(1);
        actions.push({
          kind: 'retention-delete',
          sandboxId: sandbox.id,
          reason: `archived ${days}d ago, past the ${policy.retentionDays}d retention window`,
          // Archived sandboxes are not running; there is nothing to exec a
          // capture against, so skip it rather than fail on every retention pass.
          captureLogs: false,
        });
      }
      continue;
    }
    if (
      sandbox.state === 'started' &&
      runningRunMinutes !== undefined &&
      runningRunMinutes > policy.maxRunMinutes
    ) {
      const runLabel = runningRunId !== undefined ? ` '${runningRunId}'` : '';
      actions.push({
        kind: 'halt-stuck-run',
        sandboxId: sandbox.id,
        reason: `run${runLabel} has been running ${Math.round(runningRunMinutes)}m, past the ${policy.maxRunMinutes}m budget`,
        captureLogs: true,
      });
    }
  }
  return actions;
}

/** Status of a single executed {@link ReconcileAction}. */
export type ReconcileOutcome = 'done' | 'error';

/** The result of carrying out one action. */
export interface ReconcileResult {
  readonly action: ReconcileAction;
  readonly outcome: ReconcileOutcome;
  /** Error message when `outcome` is `error`. */
  readonly error?: string;
  /** The captured artifact, when one was taken. */
  readonly artifact?: LogArtifact;
}

/** Dependencies the executor needs to carry out a plan. */
export interface ExecuteReconcileDeps {
  readonly provider: SandboxProvider;
  /** Redactor applied to captured logs. Omitted means no redaction. */
  readonly redactor?: Redactor;
  /** Persist a captured artifact (e.g. write it to disk). Best-effort. */
  readonly persistArtifact?: (artifact: LogArtifact) => Promise<void> | void;
  /** Byte ceiling on a captured artifact. */
  readonly logMaxBytes?: number;
  /** Timeout (seconds) for the in-sandbox log capture exec. Default 30. */
  readonly captureTimeoutSeconds?: number;
  /**
   * Wrap each provider operation, e.g. to bound it with a control-plane timeout.
   * Defaults to running the operation directly.
   */
  readonly withOp?: <T>(op: () => Promise<T>, label: string) => Promise<T>;
  /** Clock, injected for deterministic artifact timestamps. */
  readonly now?: () => Date;
}

/**
 * Capture a bounded, redacted log artifact from a sandbox. Best-effort: a
 * sandbox that cannot be exec'd (already gone, not running) yields undefined
 * rather than aborting the cleanup it was meant to precede.
 */
async function captureArtifact(
  sandboxId: string,
  deps: ExecuteReconcileDeps,
  run: <T>(op: () => Promise<T>, label: string) => Promise<T>,
): Promise<LogArtifact | undefined> {
  const maxBytes = deps.logMaxBytes ?? DEFAULT_LOG_ARTIFACT_MAX_BYTES;
  try {
    const result = await run(
      () =>
        deps.provider.exec(sandboxId, {
          command: captureLogsScript(maxBytes),
          timeoutSeconds: deps.captureTimeoutSeconds ?? 30,
        }),
      `capture-logs ${sandboxId}`,
    );
    const artifact = buildLogArtifact(sandboxId, result.output, {
      ...(deps.redactor !== undefined ? { redactor: deps.redactor } : {}),
      maxBytes,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    });
    if (artifact.content.length > 0) {
      await deps.persistArtifact?.(artifact);
      return artifact;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Carry out a reconciliation plan. Each action captures a log artifact first
 * (when the action calls for it), then performs its provider mutation. Actions
 * are independent: one failure is recorded and the sweep continues, so a single
 * stuck delete never blocks the rest of the cleanup.
 */
export async function executeReconciliation(
  actions: readonly ReconcileAction[],
  deps: ExecuteReconcileDeps,
): Promise<ReconcileResult[]> {
  const run = deps.withOp ?? (<T>(op: () => Promise<T>) => op());
  const results: ReconcileResult[] = [];
  for (const action of actions) {
    const artifact = action.captureLogs
      ? await captureArtifact(action.sandboxId, deps, run)
      : undefined;
    try {
      switch (action.kind) {
        case 'orphan-delete':
        case 'retention-delete':
          await run(
            () => deps.provider.deleteSandbox(action.sandboxId),
            `delete ${action.sandboxId}`,
          );
          break;
        case 'halt-stuck-run':
          await run(() => deps.provider.stopSandbox(action.sandboxId), `stop ${action.sandboxId}`);
          break;
      }
      results.push({ action, outcome: 'done', ...(artifact !== undefined ? { artifact } : {}) });
    } catch (error) {
      results.push({
        action,
        outcome: 'error',
        error: error instanceof Error ? error.message : String(error),
        ...(artifact !== undefined ? { artifact } : {}),
      });
    }
  }
  return results;
}
