import { claimBranch, type RunnerClaim, type ShimLaunchAdapter } from './launch-adapter.js';
import type { RunnerQueueStatus } from './overlord-runner-contract.js';

// `RunnerQueueStatus` is vendored in ./overlord-runner-contract.ts (the
// manifest's declared vendored contract); re-export it so existing importers
// keep their `./sandbox-waker.js` path. The endpoint also accepts an optional
// `?projectId=` filter, but the unfiltered read already returns every queued
// request this target serves, so the gateway does not need to enumerate (and
// does not store) Overlord project ids to use it.
export type { RunnerQueueStatus } from './overlord-runner-contract.js';

export interface SandboxWakerOptions {
  readonly adapter: ShimLaunchAdapter;
  /** Non-destructive read of `GET /api/runner/status`. */
  readonly fetchStatus: () => Promise<RunnerQueueStatus>;
  readonly log?: (message: string) => void;
}

/**
 * Always-on loop, separate from the claim loop, that pre-warms sandboxes for
 * missions with queued Overlord work.
 *
 * A stopped or archived sandbox cannot poll for itself, and the destructive
 * `POST /api/runner/claim` must not be the first thing to trigger a slow
 * archived-sandbox restore: the single claim loop would block on that restore
 * and starve every other project's ready work. This loop instead reads the
 * non-destructive status queue and resumes the right sandboxes ahead of the
 * claim, so claims land on already-warm sandboxes. Waking is idempotent — a
 * sandbox already started, or a mission with no sandbox yet, is left for the
 * claim path — so this loop and the claim loop compose safely.
 */
export class SandboxWaker {
  readonly #adapter: ShimLaunchAdapter;
  readonly #fetchStatus: () => Promise<RunnerQueueStatus>;
  readonly #log: (message: string) => void;

  constructor(options: SandboxWakerOptions) {
    this.#adapter = options.adapter;
    this.#fetchStatus = options.fetchStatus;
    this.#log = options.log ?? (() => {});
  }

  /** One pass: resume a sandbox for every distinct mission/branch with queued work. */
  async tick(): Promise<void> {
    const status = await this.#fetchStatus();
    const pending = new Map<string, RunnerClaim>();
    for (const item of status.queue) {
      if (typeof item.missionId === 'string' && item.missionId.length > 0) {
        pending.set(wakeKey(item), item);
      }
    }
    for (const item of pending.values()) {
      try {
        const started = await this.#adapter.wake(item);
        if (started.length > 0) {
          this.#log(
            `resumed ${started.length} sandbox(es) for mission ${item.missionId}: ${started.join(', ')}`,
          );
        }
      } catch (error) {
        this.#log(
          `wake failed for mission ${item.missionId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}

/** Collapse queued requests to the single sandbox each would wake. */
function wakeKey(item: RunnerClaim): string {
  const mode =
    typeof item.metadata?.sandboxLaunch === 'string'
      ? item.metadata.sandboxLaunch
      : typeof item.metadata?.sandboxLaunchMode === 'string'
        ? item.metadata.sandboxLaunchMode
        : typeof item.metadata?.launchMode === 'string'
          ? item.metadata.launchMode
          : '';
  return `${item.missionId}\u0000${claimBranch(item) ?? ''}\u0000${mode}`;
}
