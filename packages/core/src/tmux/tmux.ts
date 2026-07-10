/**
 * The tmux multiplex plane.
 *
 * Every Racecar sandbox hosts one long-lived, named tmux session. Agent runs
 * execute inside it and `racecar attach` connects a local PTY to it. A detached
 * tmux session survives full client disconnect (proven in Stage 0), so a run
 * keeps going while no one is watching and a reattach in ~0.1s picks it back up.
 *
 * This module owns the pieces that must stay consistent across the control
 * plane: the session name, the tmux bootstrap baked into snapshots, the small
 * shell snippets the control plane sends into a sandbox, and the idle-vs-agent
 * classification `racecar ps` uses. Keeping them here — rather than scattered as
 * string literals in the CLI — makes the naming and the classification testable
 * and impossible to drift apart.
 */

/** The single named tmux session every Racecar sandbox hosts. */
export const TMUX_SESSION = 'racecar';

/**
 * Setup commands baked into a snapshot so tmux is present at runtime. The
 * `node:22-bookworm-slim` base image ships without it (see the Stage 0
 * findings), so the snapshot recipe installs it once at build time rather than
 * paying an apt round-trip on every sandbox create.
 */
export const TMUX_SETUP_COMMANDS: readonly string[] = [
  'apt-get update',
  'DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tmux',
  'rm -rf /var/lib/apt/lists/*',
];

/** Single-quote a value for safe interpolation into a POSIX shell command. */
function sq(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Shell command that creates the detached session if it does not already exist.
 * Idempotent, so it is safe to run at every sandbox create. The session is
 * started detached (`new-session -d`) — a long-lived process must never be a
 * child of a synchronous exec, or the exec hangs until it exits.
 */
export function ensureSessionScript(startDir?: string, session: string = TMUX_SESSION): string {
  const target = sq(session);
  const dir = startDir !== undefined ? ` -c ${sq(startDir)}` : '';
  return `tmux has-session -t ${target} 2>/dev/null || tmux new-session -d -s ${target}${dir}`;
}

/**
 * Command run inside an attach PTY: attach to the session, creating it first if
 * it is absent (`new-session -A`). Prefixed with `exec` so it replaces the
 * PTY's shell — when the client detaches, the PTY's root process exits cleanly
 * instead of dropping back to a stray shell.
 */
export function attachSessionScript(startDir?: string, session: string = TMUX_SESSION): string {
  const target = sq(session);
  const dir = startDir !== undefined ? ` -c ${sq(startDir)}` : '';
  return `exec tmux new-session -A -s ${target}${dir}`;
}

/**
 * Command that prints the foreground command of each pane in the session, one
 * per line, and prints nothing (exit 0) when the session does not exist. Its
 * output feeds {@link parsePaneActivity}.
 */
export function paneCommandsScript(session: string = TMUX_SESSION): string {
  return `tmux list-panes -t ${sq(session)} -F '#{pane_current_command}' 2>/dev/null || true`;
}

/**
 * Foreground pane commands that count as *idle* — a plain login shell or tmux
 * itself, i.e. no agent is running. Anything else in a pane is treated as an
 * active agent. Kept deliberately small: the goal is to distinguish "a shell is
 * sitting at a prompt" from "something is running", not to enumerate agents.
 */
export const IDLE_PANE_COMMANDS: ReadonlySet<string> = new Set([
  'bash',
  'sh',
  'zsh',
  'dash',
  'ash',
  'fish',
  '-bash',
  '-sh',
  '-zsh',
  'tmux',
]);

/** The decoded state of a sandbox's tmux session, from {@link parsePaneActivity}. */
export interface TmuxSessionActivity {
  /** Whether the named tmux session exists at all. */
  readonly sessionExists: boolean;
  /** Foreground command of each pane in the session. */
  readonly paneCommands: readonly string[];
  /** Whether any pane is running a non-shell (agent) command. */
  readonly agentActive: boolean;
}

/**
 * Parse the output of {@link paneCommandsScript} into a
 * {@link TmuxSessionActivity}. Empty output means the session does not exist
 * (or tmux is not yet installed); a session always has at least one pane, so a
 * non-empty listing implies the session exists.
 */
export function parsePaneActivity(output: string): TmuxSessionActivity {
  const paneCommands = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const sessionExists = paneCommands.length > 0;
  const agentActive = paneCommands.some((command) => !IDLE_PANE_COMMANDS.has(command));
  return { sessionExists, paneCommands, agentActive };
}

/** Single-word summary of a sandbox's agent state for `racecar ps`. */
export type AgentStatus = 'active' | 'idle' | 'no-session' | '-' | '?';

/** Reduce a {@link TmuxSessionActivity} to the label `racecar ps` renders. */
export function agentStatusFromActivity(activity: TmuxSessionActivity): AgentStatus {
  if (!activity.sessionExists) return 'no-session';
  return activity.agentActive ? 'active' : 'idle';
}
