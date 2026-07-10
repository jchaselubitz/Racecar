/**
 * Agent specs: how each supported agent is invoked non-interactively inside a
 * sandbox's tmux session. Claude Code is the tier-1 agent for Stage 2; the
 * `AgentSpec` seam keeps a second agent a matter of adding a row here, not
 * touching the run orchestration.
 *
 * An agent command reads its prompt from a shell variable (`$RACECAR_RUN_PROMPT`)
 * that the run wrapper populates from a `0644` prompt file — so the prompt never
 * appears in a command line, a process listing, or an exec log, and no quoting
 * of arbitrary prompt text is ever required.
 */

/** Identifier of a supported agent. Open-ended; `claude-code` is tier 1. */
export type AgentId = 'claude-code';

/** The shell variable the run wrapper exports with the run's prompt. */
export const PROMPT_VAR = 'RACECAR_RUN_PROMPT';

/** A supported agent and how to invoke it for one non-interactive run. */
export interface AgentSpec {
  /** Canonical agent id, recorded on the run. */
  readonly id: AgentId;
  /**
   * The shell command that runs the agent once, reading the prompt from
   * `$RACECAR_RUN_PROMPT`. Its stdout/stderr are captured by the wrapper; its
   * exit code becomes the run's exit code.
   */
  readonly command: string;
}

/**
 * Claude Code, headless. `--print` runs a single non-interactive turn and exits;
 * `--dangerously-skip-permissions` is appropriate here because the sandbox is an
 * isolated, disposable workspace created for exactly this autonomous run, and a
 * permission prompt would otherwise block a detached run with no one attached.
 * The OAuth token is injected as a sandbox env var at creation (Stage 2
 * objective 1), so Claude Code authenticates with no login prompt.
 */
const CLAUDE_CODE: AgentSpec = {
  id: 'claude-code',
  command: `claude --print --dangerously-skip-permissions "$${PROMPT_VAR}"`,
};

const AGENTS: Readonly<Record<AgentId, AgentSpec>> = {
  'claude-code': CLAUDE_CODE,
};

/** The default agent when `racecar run` is invoked without `--agent`. */
export const DEFAULT_AGENT: AgentId = 'claude-code';

/** Agent ids Racecar knows how to run. */
export function knownAgents(): readonly AgentId[] {
  return Object.keys(AGENTS) as AgentId[];
}

/** Resolve an agent id to its spec, or throw if it is not supported. */
export function resolveAgent(id: string): AgentSpec {
  const spec = AGENTS[id as AgentId];
  if (spec === undefined) {
    throw new Error(`unknown agent '${id}'; known agents: ${knownAgents().join(', ')}`);
  }
  return spec;
}
