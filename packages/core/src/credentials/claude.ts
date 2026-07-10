/**
 * Parsing the output of `claude setup-token`.
 *
 * `racecar auth claude` wraps `claude setup-token`, which runs an interactive
 * OAuth flow and prints the resulting long-lived token. The token has a stable
 * `sk-ant-…` shape, so we extract it from the captured output rather than
 * depending on exactly which stream or line it lands on.
 */

/** Matches a Claude token as emitted by `claude setup-token`. */
const CLAUDE_TOKEN_PATTERN = /sk-ant-[A-Za-z0-9_-]{16,}/g;

/**
 * Extract the Claude OAuth token from captured `claude setup-token` output.
 * Returns the last match (the final token line, past any echoed instructions)
 * or `undefined` when no token-shaped string is present.
 */
export function extractClaudeToken(output: string): string | undefined {
  const matches = output.match(CLAUDE_TOKEN_PATTERN);
  if (matches === null || matches.length === 0) return undefined;
  return matches[matches.length - 1];
}
