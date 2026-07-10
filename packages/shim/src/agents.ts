/**
 * Selecting and constructing the southbound agent from configuration.
 *
 * The daemon resolves a {@link ShimAgentKind} from its environment and turns it
 * into an {@link AgentFactory} the server invokes per connection. This is the one
 * place that knows how each kind is built: the echo stub in-process, tier-1
 * (`claude-code`, `codex`) as an ACP subprocess ({@link ProcessAcpAgent}), tier-2
 * (`stream-json`) as a bridged subprocess ({@link StreamJsonAgent}). Subprocess
 * spawning is injected ({@link spawnAgentProcess} by default) so the daemon path
 * is testable without real agent binaries.
 */
import { ProcessAcpAgent } from './acp-client.js';
import { EchoAgent, type AgentFactory } from './agent.js';
import {
  SHIM_AGENT_DEFAULT_COMMANDS,
  type ShimAgentKind,
} from './contract.js';
import { spawnAgentProcess, type AgentProcess, type SpawnSpec } from './stdio.js';
import { StreamJsonAgent } from './stream-json.js';

/** A fully-resolved agent selection: kind plus the command that realizes it. */
export interface AgentSelection {
  readonly kind: ShimAgentKind;
  /** Executable for a subprocess kind; empty for the in-process `echo`. */
  readonly command: string;
  /** Arguments for a subprocess kind. */
  readonly args: readonly string[];
}

/** A function that spawns a subprocess from a {@link SpawnSpec}. */
export type SpawnProcess = (spec: SpawnSpec) => AgentProcess;

/**
 * Resolve the concrete command for a selection, applying per-kind defaults when
 * the operator did not override them. `echo` needs no command.
 */
export function resolveAgentSelection(
  kind: ShimAgentKind,
  overrides: { command?: string | undefined; args?: readonly string[] | undefined } = {},
): AgentSelection {
  const defaults = SHIM_AGENT_DEFAULT_COMMANDS[kind];
  return {
    kind,
    command: overrides.command ?? defaults.command,
    args: overrides.args ?? defaults.args,
  };
}

/**
 * Build the per-connection {@link AgentFactory} for a selection. `spawn` is
 * injectable so tests drive the tier-1/tier-2 adapters with a scripted process.
 * The subprocess kinds inherit the daemon's environment (which carries the
 * agent's credentials, injected at sandbox creation).
 */
export function buildAgentFactory(
  selection: AgentSelection,
  spawn: SpawnProcess = spawnAgentProcess,
  env: NodeJS.ProcessEnv = process.env,
): AgentFactory {
  const spec: SpawnSpec = { command: selection.command, args: selection.args, env };
  switch (selection.kind) {
    case 'echo':
      return () => new EchoAgent();
    case 'claude-code':
    case 'codex':
      return () => new ProcessAcpAgent(spawn(spec));
    case 'stream-json':
      return () => new StreamJsonAgent(() => spawn(spec));
  }
}
