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
  /** Base image the snapshot was built from (e.g. `node:22-bookworm-slim`). */
  readonly baseImage: string;
  /**
   * Hash of the dependency lockfile baked into the snapshot. Used to detect
   * staleness relative to the mission checkout's current lockfile. Absent when
   * the snapshot was not built from a lockfile.
   */
  readonly lockfileHash?: string;
  /** Provider image name backing the snapshot, once known. */
  readonly imageName?: string;
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
