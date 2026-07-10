/**
 * The shim's wire contract: the constants the control plane and any client must
 * agree on to reach the shim. Kept in a dependency-free module so the control
 * plane (`@racecar/core`/`@racecar/cli`) can import these names without pulling
 * in the WebSocket server, and so the daemon bundle stays small.
 *
 * The shim is the single source of truth for its own env/port/auth names: it is
 * the process that reads them, so everything else references these values rather
 * than re-declaring string literals that could drift.
 */

/**
 * Default TCP port the shim listens on inside the sandbox. A fixed port keeps
 * the preview-URL mapping (`getPreviewUrl(id, SHIM_DEFAULT_PORT)`) predictable.
 * Overridable via {@link SHIM_PORT_ENV} for local development and tests.
 */
export const SHIM_DEFAULT_PORT = 3100;

/** Env var overriding {@link SHIM_DEFAULT_PORT}. */
export const SHIM_PORT_ENV = 'RACECAR_SHIM_PORT';

/**
 * Env var carrying the per-sandbox shim token. Injected at sandbox creation and
 * read by the daemon at boot; every client connection must present this value.
 * This is a Racecar-owned token, independent of Daytona's preview-URL token, so
 * the shim gates access itself rather than trusting the proxy alone — and so the
 * token can be rotated without touching the provider.
 */
export const SHIM_TOKEN_ENV = 'RACECAR_SHIM_TOKEN';

/** Env var selecting the interface the daemon binds (defaults to all: 0.0.0.0). */
export const SHIM_HOST_ENV = 'RACECAR_SHIM_HOST';

/**
 * Query-param name a browser client uses to present the shim token, since the
 * WebSocket API cannot set request headers. Mirrors Daytona's own
 * `DAYTONA_SANDBOX_AUTH_KEY` query-param path for the preview proxy.
 */
export const SHIM_TOKEN_QUERY_PARAM = 'racecar_token';

/** Request-header name a programmatic client uses to present the shim token. */
export const SHIM_TOKEN_HEADER = 'x-racecar-shim-token';

/**
 * `Sec-WebSocket-Protocol` value prefix a browser client uses to present the
 * token when it can set neither a header nor a query param cleanly:
 * `new WebSocket(url, ['racecar-shim-token.' + token])`. The server echoes the
 * selected subprotocol back so the handshake completes.
 */
export const SHIM_SUBPROTOCOL_PREFIX = 'racecar-shim-token.';

/**
 * The detached tmux session the daemon runs in inside the sandbox. Distinct from
 * the agent-run session (`racecar`) so the long-lived shim and an interactive
 * `racecar attach` never share a pane.
 */
export const SHIM_TMUX_SESSION = 'racecar-shim';

/**
 * Env var selecting which southbound agent the shim drives: one of
 * {@link SHIM_AGENT_KINDS}. Injected at sandbox boot alongside the token. Absent
 * or unknown falls back to {@link SHIM_DEFAULT_AGENT} (the built-in echo stub), so
 * a shim on a sandbox with no agent installed still starts and serves.
 */
export const SHIM_AGENT_ENV = 'RACECAR_SHIM_AGENT';

/** Env var overriding the executable for the selected agent (else its default). */
export const SHIM_AGENT_COMMAND_ENV = 'RACECAR_SHIM_AGENT_COMMAND';

/**
 * Env var overriding the selected agent's arguments: a JSON array (`["a","b"]`)
 * or, as a fallback, a whitespace-separated string. Overrides the default args.
 */
export const SHIM_AGENT_ARGS_ENV = 'RACECAR_SHIM_AGENT_ARGS';

/** The southbound agent kinds the shim can drive. */
export const SHIM_AGENT_KINDS = ['echo', 'claude-code', 'codex', 'stream-json'] as const;

/** A southbound agent kind ({@link SHIM_AGENT_KINDS} member). */
export type ShimAgentKind = (typeof SHIM_AGENT_KINDS)[number];

/** Default when {@link SHIM_AGENT_ENV} is unset: the in-process echo stub. */
export const SHIM_DEFAULT_AGENT: ShimAgentKind = 'echo';

/**
 * Default launch command per agent kind. The real binaries live *inside the
 * sandbox* (installed by the snapshot recipe / credential stage), not in this
 * repo, so these are the documented defaults an operator can override per sandbox
 * via {@link SHIM_AGENT_COMMAND_ENV} / {@link SHIM_AGENT_ARGS_ENV}:
 *
 *  - `claude-code` — the Claude Code ACP adapter (`claude-code-acp`), speaking ACP
 *    over stdio; pre-authenticated by the injected `CLAUDE_CODE_OAUTH_TOKEN`.
 *  - `codex` — `@agentclientprotocol/codex-acp`, Codex's ACP adapter.
 *  - `stream-json` — Claude Code in stream-json mode (tier-2 bridge reference).
 *
 * `echo` has no command (it runs in-process), hence its empty spec.
 */
export const SHIM_AGENT_DEFAULT_COMMANDS: Record<
  ShimAgentKind,
  { readonly command: string; readonly args: readonly string[] }
> = {
  echo: { command: '', args: [] },
  'claude-code': { command: 'claude-code-acp', args: [] },
  codex: { command: 'codex-acp', args: [] },
  'stream-json': {
    command: 'claude',
    args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
  },
};
