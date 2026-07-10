/**
 * `racecar run <sandbox> "<prompt>"` — start an agent invocation as a supervised
 * Run inside the sandbox's tmux session, and (with `--wait`) follow it to a
 * recorded result.
 *
 * The run is launched detached inside tmux, so it survives the `racecar run`
 * process exiting and a slept laptop; a later `racecar attach` watches the same
 * session. Sequencing is enforced by an atomic lock the run wrapper releases on
 * exit — a second `racecar run` against a busy sandbox fails fast. The wrapper
 * records timestamps, exit status, and a git status/diff summary at run end,
 * which {@link listRuns} reads back.
 */
import {
  acquireLockScript,
  generateRunId,
  launchRunScript,
  parseLockResult,
  parseRunRecords,
  readRunsScript,
  resolveAgent,
  runStatusScript,
  isRunTerminal,
  type RunMeta,
  type RunRecord,
  type SandboxProvider,
} from '@racecar/core';

/** Thrown when a run cannot start because another run already holds the lock. */
export class RunBusyError extends Error {
  readonly activeRunId: string;
  constructor(sandboxId: string, activeRunId: string) {
    super(
      `sandbox '${sandboxId}' already has an active run` +
        (activeRunId.length > 0 ? ` (${activeRunId})` : '') +
        `; wait for it to finish or pass --force to reclaim a stale lock`,
    );
    this.name = 'RunBusyError';
    this.activeRunId = activeRunId;
  }
}

/** Options for {@link startRun}. */
export interface StartRunOptions {
  readonly agent?: string;
  readonly workspaceDir: string;
  readonly force?: boolean;
  readonly session?: string;
  /** Poll to a terminal status before returning. */
  readonly wait?: boolean;
  /** Seconds to wait for a run to finish under `wait` before giving up. */
  readonly waitTimeoutSeconds?: number;
  /** Poll interval while waiting, in milliseconds. */
  readonly pollMs?: number;
  /** Called each poll while waiting, so a caller can surface progress. */
  readonly onPoll?: (status: string) => void;
}

/** What {@link startRun} returns: the launched run plus its final record if waited. */
export interface StartRunResult {
  readonly meta: RunMeta;
  /** The terminal record, present only when `wait` was set and the run finished. */
  readonly record?: RunRecord;
  /** True when `wait` was set but the run had not finished by the timeout. */
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

/**
 * Start a run in `sandboxId`. Claims the one-run lock (failing with
 * {@link RunBusyError} if a run is active), launches the agent detached inside
 * tmux, and — when `wait` is set — polls the recorded status to a terminal
 * state and returns the final record.
 */
export async function startRun(
  provider: SandboxProvider,
  sandboxId: string,
  prompt: string,
  options: StartRunOptions,
): Promise<StartRunResult> {
  const agent = resolveAgent(options.agent ?? 'claude-code');
  await ensureStarted(provider, sandboxId);

  const runId = generateRunId();
  // Claim the one-run lock atomically under this run's id before launching.
  const lock = await provider.exec(sandboxId, {
    command: acquireLockScript(runId, options.force ?? false),
    timeoutSeconds: 30,
  });
  const lockResult = parseLockResult(lock.output);
  if (!lockResult.acquired) {
    throw new RunBusyError(sandboxId, lockResult.activeRunId);
  }

  const meta: RunMeta = {
    id: runId,
    sandboxId,
    agent: agent.id,
    prompt,
    startedAt: new Date().toISOString(),
  };
  const launch = await provider.exec(sandboxId, {
    command: launchRunScript({
      meta,
      agent,
      workspaceDir: options.workspaceDir,
      ...(options.session !== undefined ? { session: options.session } : {}),
    }),
    timeoutSeconds: 60,
  });
  if (launch.exitCode !== 0) {
    // Release the lock we claimed so the sandbox is not wedged by a failed launch.
    await provider
      .exec(sandboxId, { command: 'rm -rf "$HOME/.racecar/run.lock.d"' })
      .catch(() => {});
    throw new Error(`failed to launch run in '${sandboxId}':\n${launch.output}`);
  }

  if (options.wait !== true) return { meta };

  const record = await waitForRun(provider, sandboxId, runId, options);
  if (record === undefined) return { meta, timedOut: true };
  return { meta, record };
}

/** Poll a run's status to terminal, heartbeating to keep the sandbox alive. */
async function waitForRun(
  provider: SandboxProvider,
  sandboxId: string,
  runId: string,
  options: StartRunOptions,
): Promise<RunRecord | undefined> {
  const pollMs = options.pollMs ?? 3000;
  const deadline = Date.now() + (options.waitTimeoutSeconds ?? 3600) * 1000;
  for (;;) {
    await sleep(pollMs);
    // Reading the status also refreshes the sandbox activity timer (exec counts
    // as activity), so a long run does not auto-stop while we watch it.
    const status = await provider
      .exec(sandboxId, { command: runStatusScript(runId), timeoutSeconds: 15 })
      .then((r) => r.output.trim())
      .catch(() => '');
    options.onPoll?.(status);
    if (status.length > 0 && isRunTerminal(status as RunRecord['status'])) {
      return (await listRuns(provider, sandboxId, [runId]))[0];
    }
    if (Date.now() >= deadline) return undefined;
  }
}

/**
 * Read recorded runs from a sandbox, newest last. Pass `ids` to read specific
 * runs; omit to read all. A stopped sandbox (nothing to exec) yields no records.
 */
export async function listRuns(
  provider: SandboxProvider,
  sandboxId: string,
  ids?: readonly string[],
): Promise<RunRecord[]> {
  const sandbox = await provider.getSandbox(sandboxId);
  if (sandbox === null) throw new Error(`sandbox '${sandboxId}' not found`);
  if (sandbox.state !== 'started') return [];
  const result = await provider.exec(sandboxId, {
    command: readRunsScript(ids),
    timeoutSeconds: 30,
  });
  return parseRunRecords(result.output);
}
