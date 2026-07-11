import { type LifecyclePolicy, resolveLifecyclePolicy } from './lifecycle.js';

/**
 * A Project is the unit of configuration a user defines once and then spins
 * sandboxes from. It names the repository, the snapshot its sandboxes boot
 * from, where the working tree lives inside the sandbox, and the lifecycle
 * policy those sandboxes inherit.
 */
export interface Project {
  /** Stable, slug-like identifier, unique within a Racecar installation. */
  readonly name: string;
  /** Git remote cloned fresh into each sandbox at creation. */
  readonly repoUrl: string;
  /** Branch checked out when a mission does not specify one. */
  readonly defaultBranch: string;
  /** Name of the snapshot sandboxes for this project are created from. */
  readonly snapshot: string;
  /** Absolute path the repository is checked out to inside the sandbox. */
  readonly workspaceDir: string;
  /** Lifecycle policy inherited by this project's sandboxes. */
  readonly lifecycle: LifecyclePolicy;
  /**
   * When true, a sandbox created against a stale snapshot kicks off an async
   * snapshot rebuild so the *next* sandbox boots fresh, without blocking the
   * current mission. When false (the default), staleness only warns.
   */
  readonly autoRebuildSnapshot: boolean;
  /** Extra outbound domains allowed for this project's sandboxes. */
  readonly egressAllowlist: readonly string[];
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;
}

/** Fields a caller supplies to define a project; the rest are defaulted. */
export interface DefineProjectInput {
  readonly name: string;
  readonly repoUrl: string;
  readonly snapshot: string;
  readonly defaultBranch?: string;
  readonly workspaceDir?: string;
  readonly lifecycle?: Partial<LifecyclePolicy>;
  readonly autoRebuildSnapshot?: boolean;
  readonly egressAllowlist?: readonly string[];
  readonly createdAt?: string;
}

/** Default location the mission repository is checked out to inside a sandbox. */
export const DEFAULT_WORKSPACE_DIR = '/home/daytona/workspace';

/**
 * Build a fully-resolved {@link Project} from user input, applying defaults for
 * the default branch, workspace directory, lifecycle policy, and timestamp.
 */
export function defineProject(input: DefineProjectInput): Project {
  return {
    name: input.name,
    repoUrl: input.repoUrl,
    snapshot: input.snapshot,
    defaultBranch: input.defaultBranch ?? 'main',
    workspaceDir: input.workspaceDir ?? DEFAULT_WORKSPACE_DIR,
    lifecycle: resolveLifecyclePolicy(input.lifecycle),
    autoRebuildSnapshot: input.autoRebuildSnapshot ?? false,
    egressAllowlist: input.egressAllowlist ?? [],
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}
