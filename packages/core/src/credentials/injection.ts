/**
 * Turning stored credentials into what a sandbox needs at creation.
 *
 * Two delivery mechanisms, chosen so a secret literal never appears in a shell
 * command Racecar sends (and therefore never in an exec log):
 *
 *  - **Environment variables** carry the secret. The provider sets them on the
 *    sandbox out of band; they are not part of any command string.
 *  - **Setup commands** materialize `0600` files by reading those env vars
 *    (`printf '%s' "$VAR" > file`). The commands reference variable *names*
 *    only, so they are safe to log.
 *
 * This module also holds the typed constructors for the two v1 credential
 * kinds, keeping the knowledge of which fields are secret in one place.
 */
import type { CredentialMap, StoredCredential } from './store.js';

/** Env var Claude Code reads for its OAuth token (confirmed in Stage 0). */
export const CLAUDE_OAUTH_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';

/** Env var used to hand git credentials to the in-sandbox materializer. */
export const GIT_CREDENTIALS_ENV = 'RACECAR_GIT_CREDENTIALS';

/** Default git host and username used by `racecar auth git`. */
export const DEFAULT_GIT_HOST = 'github.com';
export const DEFAULT_GIT_USERNAME = 'x-access-token';

/**
 * Env vars `racecar setup` reads to seed a GitHub credential non-interactively:
 * `GH_AUTH_TOKEN` carries the personal access token, `GH_USERNAME` the login
 * (falling back to {@link DEFAULT_GIT_USERNAME} when unset).
 */
export const GH_AUTH_TOKEN_ENV = 'GH_AUTH_TOKEN';
export const GH_USERNAME_ENV = 'GH_USERNAME';

/** Input for a Claude credential. */
export interface ClaudeCredentialInput {
  readonly oauthToken: string;
}

/** Build the stored form of a Claude OAuth credential. */
export function claudeCredential(
  input: ClaudeCredentialInput,
  now: () => Date = () => new Date(),
): StoredCredential {
  return {
    kind: 'claude',
    createdAt: now().toISOString(),
    secrets: { oauthToken: input.oauthToken },
  };
}

/** Input for a git credential. */
export interface GitCredentialInput {
  readonly token: string;
  readonly host?: string;
  readonly username?: string;
}

/** Build the stored form of a git credential (token secret, host/user meta). */
export function gitCredential(
  input: GitCredentialInput,
  now: () => Date = () => new Date(),
): StoredCredential {
  return {
    kind: 'git',
    createdAt: now().toISOString(),
    secrets: { token: input.token },
    meta: {
      host: input.host ?? DEFAULT_GIT_HOST,
      username: input.username ?? DEFAULT_GIT_USERNAME,
    },
  };
}

/** The single `git credential store` line for a git credential. */
function gitCredentialLine(credential: StoredCredential): string {
  const host = credential.meta?.host ?? DEFAULT_GIT_HOST;
  const username = credential.meta?.username ?? DEFAULT_GIT_USERNAME;
  const token = credential.secrets['token'] ?? '';
  return `https://${encodeURIComponent(username)}:${encodeURIComponent(token)}@${host}`;
}

/**
 * What a set of credentials contributes to a sandbox at creation:
 * env vars carrying the secrets, and setup commands that reference those env
 * vars to write `0600` files. Setup commands run before the repo checkout so
 * git credentials are in place for a private clone.
 */
export interface CredentialInjection {
  readonly env: Record<string, string>;
  readonly setupCommands: readonly string[];
}

/**
 * Build the {@link CredentialInjection} for a credential map. Claude tokens
 * become an env var Claude Code reads directly; git credentials become an env
 * var plus commands that write `~/.git-credentials` and enable the store
 * helper. Multiple git credentials are concatenated into one credentials file.
 */
export function buildCredentialInjection(map: CredentialMap): CredentialInjection {
  const env: Record<string, string> = {};
  const setupCommands: string[] = [];
  const gitLines: string[] = [];

  for (const credential of Object.values(map)) {
    if (credential.kind === 'claude') {
      const token = credential.secrets['oauthToken'];
      if (token !== undefined) env[CLAUDE_OAUTH_ENV] = token;
    } else if (credential.kind === 'git') {
      gitLines.push(gitCredentialLine(credential));
    }
  }

  if (gitLines.length > 0) {
    env[GIT_CREDENTIALS_ENV] = gitLines.join('\n');
    setupCommands.push(
      'umask 077',
      `printf '%s\\n' "$${GIT_CREDENTIALS_ENV}" > "$HOME/.git-credentials"`,
      'chmod 600 "$HOME/.git-credentials"',
      'git config --global credential.helper store',
    );
  }

  return { env, setupCommands };
}
