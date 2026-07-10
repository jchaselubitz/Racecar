/**
 * Status of a Run — a single agent invocation inside a sandbox. Runs are the
 * unit Stage 2 supervises; the domain type lands here in Stage 1 so the label
 * schema and provider surface can reference it.
 */
export type RunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/** Statuses in which a run has finished and will not change further. */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['succeeded', 'failed', 'cancelled'];

/**
 * A Run records one agent invocation inside a sandbox: which agent, the prompt
 * it was given, its status, timing, and exit code. One sandbox runs at most one
 * non-terminal run at a time (sequential-run enforcement arrives in Stage 2).
 */
export interface Run {
  /** Control-plane-unique run identifier. */
  readonly id: string;
  /** Sandbox the run executes in. */
  readonly sandboxId: string;
  /** Agent that performed the run (e.g. `claude-code`). */
  readonly agent: string;
  /** Prompt or instruction the agent was invoked with. */
  readonly prompt: string;
  /** Current status. */
  readonly status: RunStatus;
  /** ISO-8601 timestamp the run started, once it leaves `pending`. */
  readonly startedAt?: string;
  /** ISO-8601 timestamp the run reached a terminal status. */
  readonly endedAt?: string;
  /** Process exit code, once the run has ended. */
  readonly exitCode?: number;
}

/** Whether a run has reached a terminal status. */
export function isRunTerminal(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}
