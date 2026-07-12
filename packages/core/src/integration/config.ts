/**
 * Git integration policy: the project-committed behavior that governs how a
 * mission's branch is named, checkpointed, synchronized, and merged.
 *
 * The policy lives with the project (proposed `.racecar/config.yaml`) so it is
 * versioned and available to every Racecar client. This module is the pure
 * resolver: it takes an already-parsed configuration object (YAML or JSON is a
 * caller concern) and returns a fully-defaulted {@link GitIntegrationConfig},
 * throwing a precise error on an invalid field. No I/O, so the policy is
 * exhaustively testable and identical whether it came from a file, a control
 * plane, or a test.
 *
 * The schema deliberately does not assume Overlord is present: `missionBranch`
 * templates over generic Racecar mission fields, with `mission.displayId`
 * populated only when a caller supplies one.
 */

/** How a candidate is applied to the default branch when it merges. */
export type MergeStrategy = 'squash' | 'rebase';

/** How idle sandboxes follow an advancing default branch. */
export type SyncStrategy = 'rebase' | 'merge';

/** The integration model. Only a serial queue is defined today. */
export type IntegrationMode = 'queue';

/** Checkpoint-push cadence for a mission branch. */
export interface CheckpointPolicy {
  /** Push a checkpoint commit when an objective is delivered. */
  readonly pushOnObjectiveDelivery: boolean;
  /** Push a checkpoint at least this often during a long objective. 0 disables. */
  readonly intervalMinutes: number;
}

/** How a mission branch is kept current with the default branch. */
export interface SynchronizationPolicy {
  /** Automatically fast-forward idle, clean sandboxes when the default branch advances. */
  readonly updateIdleSandboxes: boolean;
  /** Synchronize active/dirty sandboxes at the next safe objective boundary. */
  readonly updateAtObjectiveBoundary: boolean;
  /** Whether synchronization rebases the mission branch or merges into it. */
  readonly strategy: SyncStrategy;
}

/** How delivered candidates become part of the default branch. */
export interface IntegrationPolicy {
  /** Integration model. */
  readonly mode: IntegrationMode;
  /** How a candidate lands on the default branch. */
  readonly mergeStrategy: MergeStrategy;
  /** Require an explicit human/caller approval before a delivery is enqueued. */
  readonly requireApproval: boolean;
  /** How many candidates the coordinator may integrate at once. Final write is serial. */
  readonly concurrency: number;
  /** Shell commands run as required checks against the post-rebase candidate. */
  readonly checks: readonly string[];
}

/** What happens to a mission sandbox once its branch merges. */
export interface CleanupPolicy {
  /** Stop the sandbox after its branch merges. */
  readonly stopAfterMerge: boolean;
  /** Archive/delete a stopped merged sandbox after this many hours. 0 disables. */
  readonly archiveAfterHours: number;
}

/** Fully-resolved git integration policy for a project. */
export interface GitIntegrationConfig {
  /** Branch every mission branch is created from and merged back into. */
  readonly defaultBranch: string;
  /** Template for a mission branch name, e.g. `ovld/{mission.displayId}-{slug}`. */
  readonly missionBranch: string;
  readonly checkpoints: CheckpointPolicy;
  readonly synchronization: SynchronizationPolicy;
  readonly integration: IntegrationPolicy;
  readonly cleanup: CleanupPolicy;
}

/** The out-of-the-box policy applied when a project ships no `git:` config. */
export const DEFAULT_GIT_INTEGRATION_CONFIG: GitIntegrationConfig = {
  defaultBranch: 'main',
  missionBranch: 'ovld/{mission.displayId}-{slug}',
  checkpoints: { pushOnObjectiveDelivery: true, intervalMinutes: 20 },
  synchronization: {
    updateIdleSandboxes: true,
    updateAtObjectiveBoundary: true,
    strategy: 'rebase',
  },
  integration: {
    mode: 'queue',
    mergeStrategy: 'squash',
    requireApproval: false,
    concurrency: 1,
    checks: [],
  },
  cleanup: { stopAfterMerge: true, archiveAfterHours: 24 },
};

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`git config: '${path}' must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, path: string, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`git config: '${path}' must be a non-empty string`);
  }
  return value;
}

function asBool(value: unknown, path: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`git config: '${path}' must be a boolean`);
  return value;
}

function asNonNegativeNumber(value: unknown, path: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`git config: '${path}' must be a number >= 0`);
  }
  return value;
}

function asEnum<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
  fallback: T,
): T {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`git config: '${path}' must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function asStringArray(value: unknown, path: string, fallback: readonly string[]): string[] {
  if (value === undefined) return [...fallback];
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || item.length === 0)
  ) {
    throw new Error(`git config: '${path}' must be an array of non-empty strings`);
  }
  return [...(value as string[])];
}

/**
 * Resolve a raw configuration object into a fully-defaulted
 * {@link GitIntegrationConfig}. Accepts either the whole config document (with a
 * top-level `git:` key, as in `.racecar/config.yaml`) or the `git` section
 * directly, so a caller may pass the parsed file without unwrapping it first.
 *
 * `undefined`/`null` input yields {@link DEFAULT_GIT_INTEGRATION_CONFIG}.
 */
export function resolveGitIntegrationConfig(input: unknown): GitIntegrationConfig {
  if (input === undefined || input === null) return DEFAULT_GIT_INTEGRATION_CONFIG;
  const root = asObject(input, 'config');
  // Accept either the full document ({ version, git: {...} }) or the git section.
  const git = 'git' in root ? asObject(root.git, 'git') : root;

  const checkpoints = asObject(git.checkpoints ?? {}, 'git.checkpoints');
  const synchronization = asObject(git.synchronization ?? {}, 'git.synchronization');
  const integration = asObject(git.integration ?? {}, 'git.integration');
  const cleanup = asObject(git.cleanup ?? {}, 'git.cleanup');
  const defaults = DEFAULT_GIT_INTEGRATION_CONFIG;

  const concurrency = asNonNegativeNumber(
    integration.concurrency,
    'git.integration.concurrency',
    defaults.integration.concurrency,
  );
  if (concurrency < 1) {
    throw new Error("git config: 'git.integration.concurrency' must be >= 1");
  }

  return {
    defaultBranch: asString(git.defaultBranch, 'git.defaultBranch', defaults.defaultBranch),
    missionBranch: asString(git.missionBranch, 'git.missionBranch', defaults.missionBranch),
    checkpoints: {
      pushOnObjectiveDelivery: asBool(
        checkpoints.pushOnObjectiveDelivery,
        'git.checkpoints.pushOnObjectiveDelivery',
        defaults.checkpoints.pushOnObjectiveDelivery,
      ),
      intervalMinutes: asNonNegativeNumber(
        checkpoints.intervalMinutes,
        'git.checkpoints.intervalMinutes',
        defaults.checkpoints.intervalMinutes,
      ),
    },
    synchronization: {
      updateIdleSandboxes: asBool(
        synchronization.updateIdleSandboxes,
        'git.synchronization.updateIdleSandboxes',
        defaults.synchronization.updateIdleSandboxes,
      ),
      updateAtObjectiveBoundary: asBool(
        synchronization.updateAtObjectiveBoundary,
        'git.synchronization.updateAtObjectiveBoundary',
        defaults.synchronization.updateAtObjectiveBoundary,
      ),
      strategy: asEnum(
        synchronization.strategy,
        'git.synchronization.strategy',
        ['rebase', 'merge'] as const,
        defaults.synchronization.strategy,
      ),
    },
    integration: {
      mode: asEnum(
        integration.mode,
        'git.integration.mode',
        ['queue'] as const,
        defaults.integration.mode,
      ),
      mergeStrategy: asEnum(
        integration.mergeStrategy,
        'git.integration.mergeStrategy',
        ['squash', 'rebase'] as const,
        defaults.integration.mergeStrategy,
      ),
      requireApproval: asBool(
        integration.requireApproval,
        'git.integration.requireApproval',
        defaults.integration.requireApproval,
      ),
      concurrency,
      checks: asStringArray(
        integration.checks,
        'git.integration.checks',
        defaults.integration.checks,
      ),
    },
    cleanup: {
      stopAfterMerge: asBool(
        cleanup.stopAfterMerge,
        'git.cleanup.stopAfterMerge',
        defaults.cleanup.stopAfterMerge,
      ),
      archiveAfterHours: asNonNegativeNumber(
        cleanup.archiveAfterHours,
        'git.cleanup.archiveAfterHours',
        defaults.cleanup.archiveAfterHours,
      ),
    },
  };
}

/** Lowercase-and-hyphenate an arbitrary label into a branch-safe slug. */
export function branchSlug(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** Fields a {@link renderMissionBranch} template may reference. */
export interface MissionBranchFields {
  /** Human-facing mission id, e.g. `coo:252`. Falls back to `missionId` when absent. */
  readonly missionDisplayId?: string;
  /** Stable mission id. */
  readonly missionId: string;
  /** Short human label for the branch, slugified into `{slug}`. */
  readonly slug: string;
}

/**
 * Render a mission-branch name from a template. Supported tokens:
 * `{mission.displayId}`, `{mission.id}`, and `{slug}`. `{mission.displayId}`
 * falls back to `{mission.id}` when no display id is supplied. All substituted
 * values are slugified so the result is always a valid ref path segment.
 */
export function renderMissionBranch(template: string, fields: MissionBranchFields): string {
  const displayId = fields.missionDisplayId ?? fields.missionId;
  return template
    .replaceAll('{mission.displayId}', branchSlug(displayId))
    .replaceAll('{mission.id}', branchSlug(fields.missionId))
    .replaceAll('{slug}', branchSlug(fields.slug));
}
