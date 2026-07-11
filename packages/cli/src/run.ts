/**
 * `racecar run <sandbox> "<prompt>"` — start an agent run through the sandbox's
 * shim and follow it to a recorded result.
 *
 * This is the Stage-3 rewire: where Stage 2 launched the agent directly in tmux,
 * the run now goes through the shim, which *owns* run state. `racecar run`
 * connects as an ACP client, creates a run, sends the prompt, and waits for the
 * turn to stop — while, because the run is shim-owned, a concurrent `racecar chat`
 * can join it and `racecar attach` sees its transcript mirrored into tmux. All
 * three describe the same session. The run's git status/diff summary (captured by
 * the shim at turn end) is read back into the record, preserving Stage 2's
 * recorded-results behavior under the new owner.
 *
 * Autonomous runs are non-interactive, so permission requests are auto-approved
 * for allow-once/always options — appropriate because the sandbox is an isolated,
 * disposable workspace created for exactly this run (the same rationale Stage 2's
 * `--dangerously-skip-permissions` rested on). Anything else is declined.
 */
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionSummary,
  SessionUpdate,
  SessionUpdateNotification,
  StopReason,
} from '@racecar/shim';
import { textBlocks } from '@racecar/shim';
import type { SandboxProvider } from '@racecar/core';
import { connectShim } from './shim-connect.js';

/** Terminal state of a shim-owned run, derived from its stop reason. */
export type ShimRunStatus = 'succeeded' | 'failed' | 'cancelled' | 'running';

/** A recorded shim run, the shape `racecar run`/`racecar runs` report. */
export interface ShimRunRecord {
  readonly runId: string;
  readonly sandboxId: string;
  readonly agent: string;
  readonly prompt: string;
  readonly status: ShimRunStatus;
  readonly stopReason?: StopReason;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly title?: string;
  readonly gitStatus?: string;
  readonly gitDiffStat?: string;
}

/** Options for {@link startRun}. */
export interface StartRunOptions {
  readonly workspaceDir: string;
  /** Informational agent label recorded on the run. */
  readonly agent?: string;
  /** Seconds to wait for the turn before giving up (the run keeps going). */
  readonly waitTimeoutSeconds?: number;
  /** Called for each streamed update, so a caller can surface live output. */
  readonly onUpdate?: (update: SessionUpdate) => void;
}

/** What {@link startRun} returns. */
export interface StartRunResult {
  readonly record: ShimRunRecord;
  /** True when the turn had not stopped by the timeout; the run continues. */
  readonly timedOut?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Ensure the sandbox is started, starting it if it was stopped or archived. */
async function ensureStarted(provider: SandboxProvider, sandboxId: string): Promise<void> {
  const sandbox = await provider.getSandbox(sandboxId);
  if (sandbox === null) throw new Error(`sandbox '${sandboxId}' not found`);
  if (sandbox.state === 'stopped' || sandbox.state === 'archived') {
    await provider.startSandbox(sandboxId);
  }
}

/** Map an ACP stop reason to a run's terminal status. */
export function statusFromStopReason(reason: StopReason): ShimRunStatus {
  switch (reason) {
    case 'refusal':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'succeeded';
  }
}

/** Auto-approve allow-once/always permissions in a disposable run; decline the rest. */
function autoApprove(request: RequestPermissionRequest): RequestPermissionResponse {
  const allow = request.options.find(
    (option) => option.kind === 'allow_once' || option.kind === 'allow_always',
  );
  return allow !== undefined
    ? { outcome: { outcome: 'selected', optionId: allow.optionId } }
    : { outcome: { outcome: 'cancelled' } };
}

/**
 * Start a run in `sandboxId` through the shim and wait for the turn to stop. The
 * run is created on the shim (so it is observable by chat/attach) and its result
 * recorded from the shim's own run summary.
 */
export async function startRun(
  provider: SandboxProvider,
  sandboxId: string,
  prompt: string,
  options: StartRunOptions,
): Promise<StartRunResult> {
  await ensureStarted(provider, sandboxId);

  const onUpdate = (notification: SessionUpdateNotification): void =>
    options.onUpdate?.(notification.update);
  const connection = await connectShim(provider, sandboxId, {
    handlers: { onUpdate, onPermission: autoApprove },
  });
  const { client, close } = connection;
  const agent = options.agent ?? 'shim';
  try {
    await client.initialize();
    const runId = await client.newSession({ cwd: options.workspaceDir });
    const startedAt = new Date().toISOString();

    const timeoutMs = (options.waitTimeoutSeconds ?? 3600) * 1000;
    const turn = client.prompt(runId, textBlocks(prompt));
    const timeout = sleep(timeoutMs).then(() => 'timeout' as const);
    const outcome = await Promise.race([turn, timeout]);

    if (outcome === 'timeout') {
      return {
        record: {
          runId,
          sandboxId,
          agent,
          prompt,
          status: 'running',
          startedAt,
        },
        timedOut: true,
      };
    }

    const endedAt = new Date().toISOString();
    const summary = await findSummary(client, runId);
    return {
      record: {
        runId,
        sandboxId,
        agent,
        prompt,
        status: statusFromStopReason(outcome.stopReason),
        stopReason: outcome.stopReason,
        startedAt,
        endedAt,
        ...(summary?.title !== undefined ? { title: summary.title } : {}),
        ...(summary?.gitStatus !== undefined ? { gitStatus: summary.gitStatus } : {}),
        ...(summary?.gitDiffStat !== undefined ? { gitDiffStat: summary.gitDiffStat } : {}),
      },
    };
  } finally {
    close();
    await connection.closed.catch(() => {});
  }
}

/** Find a run's summary in the shim's list, tolerating an absent entry. */
async function findSummary(
  client: Awaited<ReturnType<typeof connectShim>>['client'],
  runId: string,
): Promise<SessionSummary | undefined> {
  try {
    return (await client.listSessions()).find((summary) => summary.sessionId === runId);
  } catch {
    return undefined;
  }
}

/** Read the shim's recorded runs for a sandbox, newest last. */
export async function listRuns(
  provider: SandboxProvider,
  sandboxId: string,
): Promise<ShimRunRecord[]> {
  const sandbox = await provider.getSandbox(sandboxId);
  if (sandbox === null) throw new Error(`sandbox '${sandboxId}' not found`);
  if (sandbox.state !== 'started') return [];
  const connection = await connectShim(provider, sandboxId);
  try {
    await connection.client.initialize();
    const summaries = await connection.client.listSessions();
    return summaries.map((summary) => summaryToRecord(sandboxId, summary));
  } finally {
    connection.close();
    await connection.closed.catch(() => {});
  }
}

/** Adapt a shim session summary to the CLI's run-record shape. */
function summaryToRecord(sandboxId: string, summary: SessionSummary): ShimRunRecord {
  const status: ShimRunStatus =
    summary.status === 'running'
      ? 'running'
      : summary.lastStopReason !== undefined
        ? statusFromStopReason(summary.lastStopReason)
        : 'succeeded';
  return {
    runId: summary.sessionId,
    sandboxId,
    agent: 'shim',
    prompt: summary.title,
    title: summary.title,
    status,
    ...(summary.lastStopReason !== undefined ? { stopReason: summary.lastStopReason } : {}),
    startedAt: summary.createdAt,
    endedAt: summary.updatedAt,
    ...(summary.gitStatus !== undefined ? { gitStatus: summary.gitStatus } : {}),
    ...(summary.gitDiffStat !== undefined ? { gitDiffStat: summary.gitDiffStat } : {}),
  };
}
