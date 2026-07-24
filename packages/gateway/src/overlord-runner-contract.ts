/**
 * Vendored subset of Overlord's plain runner REST surface (`/api/runner/*`).
 *
 * The gateway consumes only a minimal slice of the runner API directly over
 * HTTP; every mission-lifecycle interaction goes through the `ovld protocol`
 * subprocess instead (see {@link ./protocol-bridge.ts}). This file is the
 * vendored contract referenced by the repository conformance manifest
 * (`conformance-manifest.yaml` → `restConsumer.vendoredContractPath`): keep the
 * shapes below in sync with the upstream Overlord runner endpoints, and update
 * the manifest's `endpoints`/`exportedTypes` whenever this file changes.
 *
 * This replaces the former `overlord-contract.ts`, which vendored the retired
 * `/api/virtual-targets/v1/*` DTOs and their `OverlordClient` (removed in commit
 * 81f0f4a). The gateway no longer speaks that bespoke virtual-target protocol —
 * it is an ordinary long-lived runner behind the plain runner surface.
 */

/**
 * The subset of a plain runner claim / queue item the gateway depends on to
 * select a Racecar workspace and drive the request. Overlord returns more
 * fields than this; only the ones the gateway reads are vendored here.
 *
 * Sandbox placement can be set explicitly on `metadata`:
 * - `sandboxLaunch` / `sandboxLaunchMode` / `launchMode`:
 *   `'mission-branch' | 'branch' | 'default-branch'`
 * - `branch`: branch name when mode is `branch` (also accepted as top-level
 *   `claim.branch`)
 *
 * When those are absent the gateway reads Overlord's `mission.branch`
 * (`willPrepareBranch`, `overrideBranch`, `baseBranch`, `name`) to choose
 * between a mission-scoped sandbox and a shared project sandbox.
 */
export interface RunnerClaim {
  readonly id: string;
  readonly missionId: string;
  readonly projectId?: string;
  readonly workingDirectory?: string;
  readonly requestedAgent?: string;
  readonly branch?: string;
  readonly prompt?: string;
  readonly metadata?: Record<string, unknown>;
}

/** Response body of `POST /api/runner/claim`. */
export interface RunnerClaimResponse {
  /** Absent/`null` when the queue had nothing to claim. */
  readonly request?: RunnerClaim | null;
  /** Additive since contract v23 (`true` on Postgres long-poll). */
  readonly longPoll?: boolean;
}

/**
 * Response body of `GET /api/runner/status`: a `queue` of the target's
 * not-yet-claimed execution requests plus a count of those already active.
 * Each queue item carries the same fields as a claim.
 */
export interface RunnerQueueStatus {
  readonly queue: readonly RunnerClaim[];
  readonly activeCount: number;
}

/** Request body of `POST /api/runner/requests/:id/failed`. */
export interface RunnerFailureBody {
  readonly error: string;
}
