/**
 * Planning the in-sandbox scrub that backs `racecar auth revoke`.
 *
 * Revoking a credential first removes it from the local store, so no *future*
 * sandbox is injected with it. But a credential already delivered to a live
 * sandbox needs scrubbing there too, and how much can be scrubbed depends on how
 * that kind was delivered (see the credential injection module):
 *
 *  - a **git** credential is materialized as a `0600` `~/.git-credentials` file;
 *    deleting that file (and unsetting the helper) revokes it for any new git
 *    operation.
 *  - a **claude** credential is only ever an env var the agent process reads at
 *    launch; there is no file to delete, and a running process's environment
 *    cannot be retracted from outside — so the only true revocation for a live
 *    agent is to stop the sandbox (ending that process).
 *
 * Both kinds are injected as env vars, so the value persists in the sandbox's
 * baked-in environment regardless of any file scrub; a process that already read
 * it keeps it. That residual exposure is what {@link livesInProcessEnv} records,
 * and why revoke warns (and can stop sandboxes) rather than claiming a clean
 * wipe. These functions are pure so the command strings stay testable.
 */

/** The scrub plan for one credential kind in a live sandbox. */
export interface CredentialScrub {
  /**
   * Shell command removing the credential's on-disk artifacts, or `undefined`
   * when the kind materializes no file (nothing on disk to remove).
   */
  readonly command?: string;
  /**
   * Whether the credential also lives as an env var in already-running
   * processes, which no command can retract — only stopping the sandbox does.
   */
  readonly livesInProcessEnv: boolean;
}

/**
 * The scrub plan for a stored credential kind. Unknown kinds get a
 * conservative empty plan (no file command) so revoke never runs a command it
 * cannot reason about.
 */
export function credentialScrub(kind: string): CredentialScrub {
  switch (kind) {
    case 'git':
      // Remove the materialized credentials file and disable the store helper so
      // a subsequent git operation has no cached credential to fall back on.
      return {
        command: [
          'rm -f "$HOME/.git-credentials"',
          'git config --global --unset credential.helper 2>/dev/null || true',
        ].join('\n'),
        livesInProcessEnv: true,
      };
    case 'claude':
      // OAuth token is only ever an env var; no file to remove.
      return { livesInProcessEnv: true };
    default:
      return { livesInProcessEnv: false };
  }
}
