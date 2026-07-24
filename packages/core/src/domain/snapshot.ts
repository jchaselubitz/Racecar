/**
 * Lifecycle state of a snapshot as tracked by the control plane. This is a
 * normalized view — provider-specific states collapse into these four.
 */
export type SnapshotState = 'building' | 'active' | 'error' | 'unknown';

/**
 * A Snapshot is a prebuilt container image a project's sandboxes cold-start
 * from. It records the base image and, crucially, the hash of the lockfile
 * that was baked into it so the control plane can warn when a sandbox's
 * lockfile has drifted from what the snapshot was built against.
 */
export interface Snapshot {
  /** Provider-unique snapshot name. */
  readonly name: string;
  /** Project this snapshot was built for. */
  readonly project: string;
  /** Base image the snapshot was built from (e.g. `node:24-bookworm-slim`). */
  readonly baseImage: string;
  /**
   * Hash of the dependency lockfile baked into the snapshot. Used to detect
   * staleness relative to the mission checkout's current lockfile. Absent when
   * the snapshot was not built from a lockfile.
   */
  readonly lockfileHash?: string;
  /** Provider image name backing the snapshot, once known. */
  readonly imageName?: string;
  /** Immutable resource-key to workspace-path layout baked into this image. */
  readonly resourcePaths?: Readonly<Record<string, string>>;
  /** Normalized lifecycle state. */
  readonly state: SnapshotState;
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;
}

/**
 * A snapshot is stale when it was built from a lockfile and that lockfile hash
 * no longer matches the mission checkout's current lockfile hash. A snapshot
 * with no recorded lockfile hash is never considered stale (nothing to compare).
 */
export function isSnapshotStale(snapshot: Snapshot, currentLockfileHash: string): boolean {
  return snapshot.lockfileHash !== undefined && snapshot.lockfileHash !== currentLockfileHash;
}

/**
 * What the staleness-automation sweep should do about a snapshot:
 *
 *  - `fresh` — the snapshot matches the current lockfile (or has no baked hash);
 *    nothing to do.
 *  - `rebuild` — the snapshot is stale and the project opts into automatic
 *    rebuilds, so the control plane should kick off an (async) rebuild.
 *  - `warn` — the snapshot is stale but auto-rebuild is off, so surface it and
 *    leave the rebuild to an explicit `racecar snapshot build`.
 *  - `building` — a rebuild is already in flight; do not start another.
 */
export type SnapshotRebuildDecision = 'fresh' | 'rebuild' | 'warn' | 'building';

/**
 * Decide how to handle a snapshot given the checkout's current lockfile hash.
 * Pure, so the automation policy is testable without touching a provider. A
 * `currentLockfileHash` of undefined (no lockfile in the checkout) is treated as
 * fresh — there is nothing to rebuild against.
 */
export function decideSnapshotRebuild(
  snapshot: Snapshot,
  currentLockfileHash: string | undefined,
  options: { readonly autoRebuild: boolean } = { autoRebuild: false },
): SnapshotRebuildDecision {
  if (currentLockfileHash === undefined || !isSnapshotStale(snapshot, currentLockfileHash)) {
    return 'fresh';
  }
  if (snapshot.state === 'building') {
    return 'building';
  }
  return options.autoRebuild ? 'rebuild' : 'warn';
}
