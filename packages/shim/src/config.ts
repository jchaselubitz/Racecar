/**
 * Daemon configuration, resolved from the environment the sandbox boot injects.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolveAgentSelection, type AgentSelection } from './agents.js';
import {
  SHIM_AGENT_ARGS_ENV,
  SHIM_AGENT_COMMAND_ENV,
  SHIM_AGENT_ENV,
  SHIM_AGENT_KINDS,
  SHIM_DEFAULT_AGENT,
  SHIM_DEFAULT_PORT,
  SHIM_HOST_ENV,
  SHIM_PORT_ENV,
  SHIM_TOKEN_ENV,
  shimTokenFilePath,
  type ShimAgentKind,
} from './contract.js';

/** Fully-resolved shim configuration. */
export interface ShimConfig {
  readonly host: string;
  readonly port: number;
  readonly token: string;
  /** Which southbound agent to drive, with its resolved launch command. */
  readonly agent: AgentSelection;
}

/** Raised when required configuration (the token) is absent. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Resolve {@link ShimConfig} from `env`. The token is required and has no
 * default — a shim with no token would authenticate everyone, so boot fails loud
 * instead. Port and host fall back to the shared defaults.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ShimConfig {
  const token = resolveToken(env);
  if (token === undefined || token.length === 0) {
    throw new ConfigError(
      `no shim token found (neither ${shimTokenFilePath('$HOME')} nor ${SHIM_TOKEN_ENV}); the shim refuses to serve without a per-sandbox token`,
    );
  }
  const portRaw = env[SHIM_PORT_ENV];
  let port = SHIM_DEFAULT_PORT;
  if (portRaw !== undefined && portRaw.length > 0) {
    const parsed = Number(portRaw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      throw new ConfigError(`${SHIM_PORT_ENV} must be a valid TCP port, got '${portRaw}'`);
    }
    port = parsed;
  }
  const host = env[SHIM_HOST_ENV] ?? '0.0.0.0';
  return { host, port, token, agent: resolveAgent(env) };
}

/**
 * Resolve the live per-sandbox token, preferring the token file over the env
 * var. The file is the rotation-aware source of truth: `racecar shim
 * rotate-token` overwrites it (and restarts the daemon) while the sandbox's
 * original {@link SHIM_TOKEN_ENV} value stays baked in, so reading the file
 * first is what lets a rotated token win. The env var remains the fallback for
 * the first boot before the file has been written and for tests.
 */
function resolveToken(env: NodeJS.ProcessEnv): string | undefined {
  const home = env.HOME !== undefined && env.HOME.length > 0 ? env.HOME : homedir();
  try {
    const fromFile = readFileSync(shimTokenFilePath(home), 'utf8').trim();
    if (fromFile.length > 0) return fromFile;
  } catch {
    // No token file yet (first boot) or unreadable — fall back to the env var.
  }
  const fromEnv = env[SHIM_TOKEN_ENV];
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : undefined;
}

/**
 * Resolve the southbound {@link AgentSelection} from `env`. An unset or unknown
 * {@link SHIM_AGENT_ENV} falls back to {@link SHIM_DEFAULT_AGENT} rather than
 * failing, so the shim always starts; the command/args envs override the per-kind
 * defaults when present.
 */
function resolveAgent(env: NodeJS.ProcessEnv): AgentSelection {
  const raw = env[SHIM_AGENT_ENV];
  const kind: ShimAgentKind = isAgentKind(raw) ? raw : SHIM_DEFAULT_AGENT;
  const command = nonEmpty(env[SHIM_AGENT_COMMAND_ENV]);
  const args = parseArgs(env[SHIM_AGENT_ARGS_ENV]);
  return resolveAgentSelection(kind, { command, args });
}

function isAgentKind(value: string | undefined): value is ShimAgentKind {
  return value !== undefined && SHIM_AGENT_KINDS.some((kind) => kind === value);
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

/**
 * Parse the agent-args override: a JSON array of strings if it parses as one,
 * else a whitespace-split fallback. Returns undefined so the per-kind default
 * args stand when the var is absent.
 */
function parseArgs(value: string | undefined): readonly string[] | undefined {
  const raw = nonEmpty(value);
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((item): item is string => typeof item === 'string')) {
      return parsed;
    }
  } catch {
    // Not JSON; fall through to whitespace splitting.
  }
  return raw.split(/\s+/).filter((token) => token.length > 0);
}
