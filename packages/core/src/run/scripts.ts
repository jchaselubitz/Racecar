/**
 * The shell scaffolding that turns one `racecar run` into a supervised Run
 * inside a sandbox's tmux session.
 *
 * Design constraints this module enforces:
 *
 *  - **No literal ever enters a command line.** The prompt, the wrapper script,
 *    and the run metadata are shipped as base64 and decoded into files inside
 *    the sandbox, so arbitrary prompt text needs no quoting and never appears in
 *    a process listing or exec log.
 *  - **The run outlives its launcher.** The agent runs in the named tmux
 *    session (via `send-keys`), detached from the `racecar run` process, so it
 *    keeps going when the laptop sleeps and a later `racecar attach` picks it up.
 *  - **One run at a time.** Sequencing is an atomic `mkdir` lock the wrapper
 *    releases on exit, so a second `racecar run` fails fast rather than racing.
 *  - **Results are recorded where they happen.** The wrapper writes status, exit
 *    code, and a git status/diff summary to per-run files at run end; the record
 *    read-back reconstructs a {@link RunRecord} from them with no shell-side JSON.
 */
import { ensureSessionScript, TMUX_SESSION } from '../tmux/tmux.js';
import type { RunStatus } from '../domain/run.js';
import { PROMPT_VAR, type AgentSpec } from './agents.js';

/** Base directory (as a shell expression) that holds every run's state files. */
const RUN_DIR = '"$HOME/.racecar/runs"';
/** The atomic lock directory guarding one-run-at-a-time. */
const LOCK_DIR = '"$HOME/.racecar/run.lock.d"';

/** Single-quote a value for safe interpolation into a POSIX shell command. */
function sq(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Base64 a UTF-8 string for transport into a `base64 -d` in the sandbox. */
function b64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

/**
 * Generate a run id that sorts chronologically and is safe in a filename and a
 * shell word (`run-<base36 time>-<random>`).
 */
export function generateRunId(now: () => Date = () => new Date(), random = Math.random): string {
  const stamp = now().getTime().toString(36);
  const suffix = Math.floor(random() * 36 ** 6)
    .toString(36)
    .padStart(6, '0');
  return `run-${stamp}-${suffix}`;
}

/** The static, launch-time facts recorded for a run (its `*.meta.json`). */
export interface RunMeta {
  readonly id: string;
  readonly sandboxId: string;
  readonly agent: string;
  readonly prompt: string;
  readonly startedAt: string;
}

/**
 * The full recorded state of a run, reconstructed from its per-run files by
 * {@link parseRunRecords}. Extends the launch-time {@link RunMeta} with the
 * outcome the wrapper captured at run end.
 */
export interface RunRecord extends RunMeta {
  readonly status: RunStatus;
  readonly endedAt?: string;
  readonly exitCode?: number;
  /** `git status --porcelain` captured at run end (empty when the tree is clean). */
  readonly gitStatus?: string;
  /** `git diff --stat` against the run's baseline commit, captured at run end. */
  readonly gitDiffStat?: string;
}

/**
 * Script that atomically claims the one-run lock for `runId`. Prints `ACQUIRED`
 * on success or `BUSY:<active-run-id>` when a run already holds it. `force`
 * clears a stale lock first (use only when a prior wrapper died without its
 * cleanup trap firing, e.g. after a hard sandbox kill).
 */
export function acquireLockScript(runId: string, force = false): string {
  const clear = force ? `rm -rf ${LOCK_DIR}\n` : '';
  return [
    'set -u',
    `mkdir -p ${RUN_DIR}`,
    clear + `if mkdir ${LOCK_DIR} 2>/dev/null; then`,
    `  printf '%s' ${sq(runId)} > ${LOCK_DIR}/run-id`,
    `  printf 'ACQUIRED\\n'`,
    'else',
    `  printf 'BUSY:%s\\n' "$(cat ${LOCK_DIR}/run-id 2>/dev/null)"`,
    'fi',
  ].join('\n');
}

/** Outcome of {@link acquireLockScript}, parsed by {@link parseLockResult}. */
export type LockResult =
  { readonly acquired: true } | { readonly acquired: false; readonly activeRunId: string };

/** Parse the stdout of {@link acquireLockScript}. */
export function parseLockResult(output: string): LockResult {
  const line = output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .pop();
  if (line === 'ACQUIRED') return { acquired: true };
  if (line !== undefined && line.startsWith('BUSY:')) {
    return { acquired: false, activeRunId: line.slice('BUSY:'.length) };
  }
  // An unrecognized result is treated as busy with an unknown holder rather than
  // silently launching a concurrent run.
  return { acquired: false, activeRunId: '' };
}

/**
 * The wrapper that runs inside tmux. It records the baseline commit and a
 * `running` status, runs the agent with its stdout/stderr teed to a log,
 * captures the exit code and a git status/diff summary, writes the terminal
 * status, and releases the lock on exit (including on interrupt).
 */
export function runWrapperScript(agent: AgentSpec): string {
  return [
    '#!/usr/bin/env bash',
    'set -u',
    'REC="$HOME/.racecar/runs/$RACECAR_RUN_ID"',
    'LOCK="$HOME/.racecar/run.lock.d"',
    'cleanup() { rm -rf "$LOCK"; }',
    'trap cleanup EXIT INT TERM',
    'cd "$RACECAR_RUN_WORKDIR" 2>/dev/null || true',
    `RACECAR_RUN_PROMPT="$(cat "$REC.prompt" 2>/dev/null)"`,
    `export ${PROMPT_VAR}`,
    'git rev-parse HEAD > "$REC.basehead" 2>/dev/null || : > "$REC.basehead"',
    'printf \'running\' > "$REC.status"',
    // Run the agent; never let a failure abort before the outcome is recorded.
    `${agent.command} > "$REC.log" 2>&1`,
    'EXIT=$?',
    `printf '%s' "$EXIT" > "$REC.exit"`,
    'date -u +%Y-%m-%dT%H:%M:%SZ > "$REC.ended"',
    'BASE_HEAD="$(cat "$REC.basehead" 2>/dev/null)"',
    'git status --porcelain > "$REC.gitstatus" 2>/dev/null || : > "$REC.gitstatus"',
    'if [ -n "$BASE_HEAD" ]; then',
    '  git diff --stat "$BASE_HEAD" > "$REC.gitdiff" 2>/dev/null || : > "$REC.gitdiff"',
    'else',
    '  git diff --stat > "$REC.gitdiff" 2>/dev/null || : > "$REC.gitdiff"',
    'fi',
    'if [ "$EXIT" = "0" ]; then',
    '  printf \'succeeded\' > "$REC.status"',
    'else',
    '  printf \'failed\' > "$REC.status"',
    'fi',
  ].join('\n');
}

/** Everything needed to materialize and launch a run in the sandbox. */
export interface LaunchRunParams {
  readonly meta: RunMeta;
  readonly agent: AgentSpec;
  readonly workspaceDir: string;
  readonly session?: string;
}

/**
 * Single script that writes the run's files (prompt, wrapper, metadata, initial
 * status), ensures the tmux session exists, and launches the wrapper inside it
 * with `send-keys` so it runs detached. Every payload is base64-decoded into a
 * file, so no prompt or metadata literal appears in the command string.
 */
export function launchRunScript(params: LaunchRunParams): string {
  const { meta, agent, workspaceDir } = params;
  const session = params.session ?? TMUX_SESSION;
  const id = meta.id;
  const wrapper = runWrapperScript(agent);
  const metaJson = JSON.stringify(meta);
  // The wrapper needs the run id and workdir; export them into the pane so the
  // send-keys command line stays free of the (already-safe) values and the
  // wrapper reads a single, consistent source.
  const launch =
    `RACECAR_RUN_ID=${sq(id)} RACECAR_RUN_WORKDIR=${sq(workspaceDir)} ` +
    `bash ${RUN_DIR}/${sq(id)}.sh`;
  return [
    'set -eu',
    `mkdir -p ${RUN_DIR}`,
    `printf '%s' ${sq(b64(meta.prompt))} | base64 -d > ${RUN_DIR}/${sq(id)}.prompt`,
    `printf '%s' ${sq(b64(wrapper))} | base64 -d > ${RUN_DIR}/${sq(id)}.sh`,
    `printf '%s' ${sq(b64(metaJson))} | base64 -d > ${RUN_DIR}/${sq(id)}.meta.json`,
    `printf '%s' ${sq(meta.startedAt)} > ${RUN_DIR}/${sq(id)}.started`,
    `printf 'running' > ${RUN_DIR}/${sq(id)}.status`,
    ensureSessionScript(workspaceDir, session),
    `tmux send-keys -t ${sq(session)} ${sq(launch)} Enter`,
  ].join('\n');
}

/** Script that prints the current status token of a run (empty if unknown). */
export function runStatusScript(runId: string): string {
  return `cat "$HOME/.racecar/runs/"${sq(runId)}".status" 2>/dev/null || true`;
}

/**
 * Script that emits every run's state files in a parseable, newline-safe form
 * (base64 for the multi-line fields). Feeds {@link parseRunRecords}. Restricting
 * to specific `ids` reads just those runs; omitting them reads all.
 */
export function readRunsScript(ids?: readonly string[]): string {
  const list =
    ids === undefined
      ? `for meta in "$B"/*.meta.json; do [ -e "$meta" ] || continue; id="$(basename "$meta" .meta.json)"; printf '%s\\n' "$id"; done`
      : ids.map((id) => `printf '%s\\n' ${sq(id)}`).join('\n');
  return [
    'B="$HOME/.racecar/runs"',
    `[ -d "$B" ] || exit 0`,
    `ids="$(${list})"`,
    'for id in $ids; do',
    "  printf '==RUN==\\n'",
    `  printf 'id:%s\\n' "$id"`,
    `  printf 'meta:%s\\n' "$(base64 -w0 "$B/$id.meta.json" 2>/dev/null)"`,
    `  printf 'started:%s\\n' "$(cat "$B/$id.started" 2>/dev/null)"`,
    `  printf 'status:%s\\n' "$(cat "$B/$id.status" 2>/dev/null)"`,
    `  printf 'exit:%s\\n' "$(cat "$B/$id.exit" 2>/dev/null)"`,
    `  printf 'ended:%s\\n' "$(cat "$B/$id.ended" 2>/dev/null)"`,
    `  printf 'gitstatus:%s\\n' "$(base64 -w0 "$B/$id.gitstatus" 2>/dev/null)"`,
    `  printf 'gitdiff:%s\\n' "$(base64 -w0 "$B/$id.gitdiff" 2>/dev/null)"`,
    'done',
  ].join('\n');
}

function decodeB64(value: string): string {
  if (value.length === 0) return '';
  return Buffer.from(value, 'base64').toString('utf8');
}

const RUN_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);

/** Reconstruct {@link RunRecord}s from the output of {@link readRunsScript}. */
export function parseRunRecords(output: string): RunRecord[] {
  const records: RunRecord[] = [];
  for (const block of output.split('==RUN==')) {
    const fields = new Map<string, string>();
    for (const line of block.split('\n')) {
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      fields.set(line.slice(0, idx), line.slice(idx + 1));
    }
    const metaRaw = fields.get('meta');
    if (metaRaw === undefined || metaRaw.length === 0) continue;
    let meta: RunMeta;
    try {
      meta = JSON.parse(decodeB64(metaRaw)) as RunMeta;
    } catch {
      continue;
    }
    const statusToken = (fields.get('status') ?? '').trim();
    const status: RunStatus = RUN_STATUSES.has(statusToken)
      ? (statusToken as RunStatus)
      : 'running';
    const endedAt = (fields.get('ended') ?? '').trim();
    const exitToken = (fields.get('exit') ?? '').trim();
    const exitCode = exitToken.length > 0 ? Number(exitToken) : undefined;
    const gitStatus = decodeB64(fields.get('gitstatus') ?? '');
    const gitDiffStat = decodeB64(fields.get('gitdiff') ?? '');
    records.push({
      ...meta,
      startedAt: meta.startedAt || (fields.get('started') ?? '').trim(),
      status,
      ...(endedAt.length > 0 ? { endedAt } : {}),
      ...(exitCode !== undefined && Number.isFinite(exitCode) ? { exitCode } : {}),
      ...(gitStatus.length > 0 ? { gitStatus } : {}),
      ...(gitDiffStat.length > 0 ? { gitDiffStat } : {}),
    });
  }
  records.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
  return records;
}
