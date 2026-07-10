/**
 * Lifecycle policy — the knobs that govern how long a sandbox lives and how
 * many may exist at once. These map onto provider auto-stop/auto-archive/
 * auto-delete intervals plus control-plane-only concerns (retention and the
 * per-project concurrency cap) that no provider enforces for us.
 */
export interface LifecyclePolicy {
  /**
   * Minutes of inactivity before the provider auto-stops the sandbox.
   * `0` disables auto-stop.
   */
  readonly autoStopMinutes: number;
  /**
   * Minutes a sandbox may stay continuously stopped before the provider
   * auto-archives it. `0` selects the provider's maximum interval.
   */
  readonly autoArchiveMinutes: number;
  /**
   * Minutes a sandbox may stay continuously stopped before the provider
   * auto-deletes it. A negative value disables auto-delete.
   */
  readonly autoDeleteMinutes: number;
  /**
   * Control-plane retention: how long archived sandboxes and their records are
   * kept before Racecar deletes them. Enforced by Racecar, not the provider.
   */
  readonly retentionDays: number;
  /**
   * Maximum number of concurrently non-archived sandboxes allowed per project.
   * Enforced by Racecar at creation time.
   */
  readonly maxConcurrentSandboxes: number;
}

/**
 * Sensible defaults for a mission sandbox: stop quickly when idle, archive
 * after a day stopped, never auto-delete (retention handles cleanup), keep a
 * week of history, and cap a project at five live sandboxes.
 */
export const DEFAULT_LIFECYCLE_POLICY: LifecyclePolicy = {
  autoStopMinutes: 15,
  autoArchiveMinutes: 60 * 24,
  autoDeleteMinutes: -1,
  retentionDays: 7,
  maxConcurrentSandboxes: 5,
};

/** Fill any unset fields of a partial policy from {@link DEFAULT_LIFECYCLE_POLICY}. */
export function resolveLifecyclePolicy(partial?: Partial<LifecyclePolicy>): LifecyclePolicy {
  return { ...DEFAULT_LIFECYCLE_POLICY, ...partial };
}
