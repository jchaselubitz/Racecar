import { type LifecyclePolicy, resolveLifecyclePolicy } from './lifecycle.js';

/** A repository baked into every snapshot for a project. */
export interface ProjectResource {
  /** Stable Overlord resource key. */
  readonly key: string;
  /** Remote cloned while the snapshot is built. */
  readonly repoUrl: string;
  /** Ref baked into the snapshot; mission work may later check out another branch. */
  readonly branch: string;
  /** Absolute, snapshot-stable path inside every sandbox. */
  readonly workspaceDir: string;
  /** The resource opened for ordinary project work. */
  readonly primary: boolean;
}

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
  /** All Overlord-addressable repositories present at fixed paths in a snapshot. */
  readonly resources: readonly ProjectResource[];
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
  readonly resources?: readonly Omit<ProjectResource, 'workspaceDir' | 'primary'>[];
  readonly lifecycle?: Partial<LifecyclePolicy>;
  readonly autoRebuildSnapshot?: boolean;
  readonly egressAllowlist?: readonly string[];
  readonly createdAt?: string;
}

/** Default location the mission repository is checked out to inside a sandbox. */
export const DEFAULT_WORKSPACE_DIR = '/home/daytona/workspace';

/** Return the conventional immutable-in-image location for a resource. */
export function resourceWorkspaceDir(root: string, key: string, primary: boolean): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(key)) {
    throw new Error(`invalid resource key '${key}'`);
  }
  return primary ? root : `${root}/resources/${key}`;
}

/**
 * Build a fully-resolved {@link Project} from user input, applying defaults for
 * the default branch, workspace directory, lifecycle policy, and timestamp.
 */
export function defineProject(input: DefineProjectInput): Project {
  const workspaceDir = input.workspaceDir ?? DEFAULT_WORKSPACE_DIR;
  // Re-resolving an already-defined project (e.g. loadProject) must be
  // idempotent: its `resources` already carry the synthesized `primary` entry,
  // so treat `primary` as always owner-defined and never prepend a duplicate.
  const extraResources = (input.resources ?? []).filter((resource) => resource.key !== 'primary');
  const resources: readonly ProjectResource[] = [
    {
      key: 'primary',
      repoUrl: input.repoUrl,
      branch: input.defaultBranch ?? 'main',
      workspaceDir: resourceWorkspaceDir(workspaceDir, 'primary', true),
      primary: true,
    },
    ...extraResources.map((resource) => ({
      key: resource.key,
      repoUrl: resource.repoUrl,
      branch: resource.branch,
      workspaceDir: resourceWorkspaceDir(workspaceDir, resource.key, false),
      primary: false,
    })),
  ];
  return {
    name: input.name,
    repoUrl: input.repoUrl,
    snapshot: input.snapshot,
    defaultBranch: input.defaultBranch ?? 'main',
    workspaceDir,
    resources,
    lifecycle: resolveLifecyclePolicy(input.lifecycle),
    autoRebuildSnapshot: input.autoRebuildSnapshot ?? false,
    egressAllowlist: input.egressAllowlist ?? [],
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}
