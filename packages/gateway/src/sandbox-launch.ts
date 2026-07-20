import { SHARED_PROJECT_MISSION } from '@racecar/core';
import type { Project } from '@racecar/core';
import type { RunnerClaim } from './overlord-runner-contract.js';

/**
 * How Racecar should place a claimed Overlord run into a sandbox.
 *
 * - `mission-branch` — create/reuse a mission-scoped sandbox and check out
 *   (creating if needed) the mission's dedicated branch.
 * - `branch` — reuse one project-scoped sandbox on an already-named branch.
 * - `default-branch` — reuse one project-scoped sandbox on the project's
 *   default branch. Functionally the same as `branch` with the default name.
 */
export type SandboxLaunchMode = 'mission-branch' | 'branch' | 'default-branch';

/**
 * Gateway-wide policy for how claimed missions are placed onto branches,
 * configured once per gateway rather than per claim.
 *
 * - `per-mission` — every mission gets its own dedicated branch/sandbox
 *   (`mission-branch`). This is the historical behavior and requires merging
 *   each mission branch back to the base branch.
 * - `shared` — all missions in the project run on a single shared branch/
 *   sandbox (`default-branch`, or `branch` when a shared branch name is set),
 *   removing the per-mission git-merge step.
 *
 * When set, this policy overrides Overlord's per-mission `mission.branch`
 * decision but still yields to an explicit launch mode named on the claim.
 */
export type GatewayBranchStrategy = 'per-mission' | 'shared';

/** Overlord's mission.branch object, reduced to the fields Racecar reads. */
export interface MissionBranchInfo {
  readonly name?: string;
  readonly baseBranch?: string;
  readonly overrideBranch?: string | null;
  readonly willPrepareBranch?: boolean;
  readonly worktreePreference?: string | null;
}

/** Fully resolved launch placement for a claim. */
export interface ResolvedSandboxLaunch {
  readonly mode: SandboxLaunchMode;
  /** Branch the sandbox working tree should be on. */
  readonly branch: string;
  /** Branch to create from when `mode` is `mission-branch` and `branch` is new. */
  readonly baseBranch: string;
  /** Mission label used to find/create the sandbox (`SHARED_PROJECT_MISSION` when shared). */
  readonly sandboxMission: string;
  /** Whether the sandbox is dedicated to one mission or shared across the project. */
  readonly scope: 'mission' | 'project';
}

const LAUNCH_MODES = new Set<string>(['mission-branch', 'branch', 'default-branch']);

/**
 * Resolve where a claim should run. Prefer an explicit launch mode on the claim
 * metadata, then Overlord's mission.branch decision, then a claim-supplied
 * branch name (mission-scoped, preserving prior gateway behavior), and finally
 * mission-scoped work on the project default branch.
 */
export function resolveSandboxLaunch(options: {
  claim: RunnerClaim;
  project: Project;
  missionBranch?: MissionBranchInfo;
  /** Gateway-wide branching policy; overrides Overlord's mission.branch. */
  strategy?: GatewayBranchStrategy;
  /** Branch name for the `shared` strategy; defaults to the base branch. */
  sharedBranch?: string;
}): ResolvedSandboxLaunch {
  const { claim, project, missionBranch, strategy } = options;
  const baseBranch = missionBranch?.baseBranch?.trim() || project.defaultBranch;
  const explicitMode = readLaunchMode(claim);
  const specified = claimBranchName(claim) ?? trimOrUndefined(missionBranch?.overrideBranch);

  if (explicitMode === 'default-branch') {
    return projectScoped({ mode: 'default-branch', branch: baseBranch, baseBranch });
  }
  if (explicitMode === 'branch') {
    return projectScoped({ mode: 'branch', branch: specified ?? baseBranch, baseBranch });
  }
  if (explicitMode === 'mission-branch') {
    return missionScoped({
      missionId: claim.missionId,
      branch: specified ?? trimOrUndefined(missionBranch?.name) ?? claim.missionId,
      baseBranch,
    });
  }

  // A gateway-wide branching policy is authoritative over Overlord's per-mission
  // decision. `shared` collapses every mission onto one project branch/sandbox
  // (removing per-mission merges); `per-mission` forces a dedicated branch.
  if (strategy === 'shared') {
    const sharedBranch = trimOrUndefined(options.sharedBranch);
    if (sharedBranch !== undefined) {
      return projectScoped({ mode: 'branch', branch: sharedBranch, baseBranch });
    }
    return projectScoped({ mode: 'default-branch', branch: baseBranch, baseBranch });
  }
  if (strategy === 'per-mission') {
    return missionScoped({
      missionId: claim.missionId,
      branch: trimOrUndefined(missionBranch?.name) ?? claim.missionId,
      baseBranch,
    });
  }

  if (missionBranch !== undefined) {
    const override = trimOrUndefined(missionBranch.overrideBranch);
    if (override !== undefined) {
      return projectScoped({ mode: 'branch', branch: override, baseBranch });
    }
    if (
      missionBranch.willPrepareBranch === true ||
      isPreparePreference(missionBranch.worktreePreference)
    ) {
      return missionScoped({
        missionId: claim.missionId,
        branch: trimOrUndefined(missionBranch.name) ?? claim.missionId,
        baseBranch,
      });
    }
    if (missionBranch.willPrepareBranch === false) {
      return projectScoped({ mode: 'default-branch', branch: baseBranch, baseBranch });
    }
  }

  // No Overlord branch decision: keep historical behavior — one sandbox per
  // mission, checked out on the claim branch or the project default.
  return missionScoped({
    missionId: claim.missionId,
    branch: specified ?? project.defaultBranch,
    baseBranch,
  });
}

/**
 * Load Overlord's mission.branch for a claim. Returns `undefined` when the
 * mission cannot be read so launch resolution can fall back to claim fields.
 */
export async function fetchMissionBranch(options: {
  backendUrl: string;
  token: string;
  missionId: string;
  deviceFingerprint?: string;
  fetchImpl?: typeof fetch;
}): Promise<MissionBranchInfo | undefined> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `${options.backendUrl.replace(/\/$/, '')}/api/missions/${encodeURIComponent(options.missionId)}`,
    {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${options.token}`,
        ...(options.deviceFingerprint !== undefined
          ? { 'x-overlord-device-fingerprint': options.deviceFingerprint }
          : {}),
      },
    },
  );
  if (!response.ok) return undefined;
  const payload: unknown = await response.json().catch(() => undefined);
  if (typeof payload !== 'object' || payload === null || !('branch' in payload)) return undefined;
  const branch = (payload as { branch?: unknown }).branch;
  if (typeof branch !== 'object' || branch === null) return undefined;
  const record = branch as Record<string, unknown>;
  return {
    ...(typeof record.name === 'string' ? { name: record.name } : {}),
    ...(typeof record.baseBranch === 'string' ? { baseBranch: record.baseBranch } : {}),
    ...(typeof record.overrideBranch === 'string' || record.overrideBranch === null
      ? { overrideBranch: record.overrideBranch as string | null }
      : {}),
    ...(typeof record.willPrepareBranch === 'boolean'
      ? { willPrepareBranch: record.willPrepareBranch }
      : {}),
    ...(typeof record.worktreePreference === 'string' || record.worktreePreference === null
      ? { worktreePreference: record.worktreePreference as string | null }
      : {}),
  };
}

function readLaunchMode(claim: RunnerClaim): SandboxLaunchMode | undefined {
  const raw =
    claim.metadata?.sandboxLaunch ??
    claim.metadata?.sandboxLaunchMode ??
    claim.metadata?.launchMode;
  return typeof raw === 'string' && LAUNCH_MODES.has(raw) ? (raw as SandboxLaunchMode) : undefined;
}

/** Branch named on the claim itself, before project-default fallback. */
export function claimBranchName(claim: RunnerClaim): string | undefined {
  if (claim.branch !== undefined && claim.branch.trim().length > 0) return claim.branch.trim();
  return typeof claim.metadata?.branch === 'string' && claim.metadata.branch.trim().length > 0
    ? claim.metadata.branch.trim()
    : undefined;
}

function isPreparePreference(value: string | null | undefined): boolean {
  return value === 'branch' || value === 'worktree';
}

function missionScoped(options: {
  missionId: string;
  branch: string;
  baseBranch: string;
}): ResolvedSandboxLaunch {
  return {
    mode: 'mission-branch',
    branch: options.branch,
    baseBranch: options.baseBranch,
    sandboxMission: options.missionId,
    scope: 'mission',
  };
}

function projectScoped(options: {
  mode: 'branch' | 'default-branch';
  branch: string;
  baseBranch: string;
}): ResolvedSandboxLaunch {
  return {
    mode: options.mode,
    branch: options.branch,
    baseBranch: options.baseBranch,
    sandboxMission: SHARED_PROJECT_MISSION,
    scope: 'project',
  };
}

function trimOrUndefined(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
