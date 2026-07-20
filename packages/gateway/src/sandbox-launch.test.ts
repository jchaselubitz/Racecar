import { defineProject } from '@racecar/core';
import { describe, expect, it } from 'vitest';
import type { RunnerClaim } from './overlord-runner-contract.js';
import { resolveSandboxLaunch } from './sandbox-launch.js';

const project = defineProject({
  name: 'demo',
  repoUrl: 'https://example.com/demo.git',
  snapshot: 'snap',
  defaultBranch: 'main',
});

function claim(overrides: Partial<RunnerClaim> = {}): RunnerClaim {
  return { id: 'r1', missionId: 'm1', ...overrides };
}

describe('resolveSandboxLaunch', () => {
  it('defaults to a mission-scoped sandbox on the project default branch', () => {
    const launch = resolveSandboxLaunch({ claim: claim(), project });
    expect(launch).toEqual({
      mode: 'mission-branch',
      branch: 'main',
      baseBranch: 'main',
      sandboxMission: 'm1',
      scope: 'mission',
    });
  });

  it('honors an explicit default-branch launch mode as a shared project sandbox', () => {
    const launch = resolveSandboxLaunch({
      claim: claim({ metadata: { sandboxLaunch: 'default-branch' } }),
      project,
    });
    expect(launch.mode).toBe('default-branch');
    expect(launch.scope).toBe('project');
    expect(launch.branch).toBe('main');
    expect(launch.sandboxMission).toBe('project');
  });

  it('honors an explicit branch launch mode on a named branch', () => {
    const launch = resolveSandboxLaunch({
      claim: claim({
        branch: 'release/1.2',
        metadata: { sandboxLaunchMode: 'branch' },
      }),
      project,
    });
    expect(launch).toMatchObject({
      mode: 'branch',
      branch: 'release/1.2',
      scope: 'project',
      sandboxMission: 'project',
    });
  });

  it('creates a mission branch when Overlord willPrepareBranch is true', () => {
    const launch = resolveSandboxLaunch({
      claim: claim(),
      project,
      missionBranch: {
        name: 'ovld/coo-1-feature',
        baseBranch: 'main',
        willPrepareBranch: true,
      },
    });
    expect(launch).toEqual({
      mode: 'mission-branch',
      branch: 'ovld/coo-1-feature',
      baseBranch: 'main',
      sandboxMission: 'm1',
      scope: 'mission',
    });
  });

  it('shares a project sandbox when Overlord willPrepareBranch is false', () => {
    const launch = resolveSandboxLaunch({
      claim: claim(),
      project,
      missionBranch: {
        name: 'ignored-when-not-preparing',
        baseBranch: 'develop',
        willPrepareBranch: false,
      },
    });
    expect(launch).toEqual({
      mode: 'default-branch',
      branch: 'develop',
      baseBranch: 'develop',
      sandboxMission: 'project',
      scope: 'project',
    });
  });

  it('uses an Overlord overrideBranch as a shared specified branch', () => {
    const launch = resolveSandboxLaunch({
      claim: claim(),
      project,
      missionBranch: {
        name: 'mission-name',
        baseBranch: 'main',
        overrideBranch: 'hotfix',
        willPrepareBranch: false,
      },
    });
    expect(launch).toMatchObject({
      mode: 'branch',
      branch: 'hotfix',
      scope: 'project',
    });
  });

  it('lets explicit metadata override Overlord mission.branch', () => {
    const launch = resolveSandboxLaunch({
      claim: claim({ metadata: { launchMode: 'mission-branch' } }),
      project,
      missionBranch: { willPrepareBranch: false, baseBranch: 'main', name: 'x' },
    });
    expect(launch.scope).toBe('mission');
    expect(launch.mode).toBe('mission-branch');
  });

  it('shares a single project sandbox when the gateway strategy is shared', () => {
    const launch = resolveSandboxLaunch({
      claim: claim(),
      project,
      strategy: 'shared',
    });
    expect(launch).toEqual({
      mode: 'default-branch',
      branch: 'main',
      baseBranch: 'main',
      sandboxMission: 'project',
      scope: 'project',
    });
  });

  it('uses a named shared branch when the gateway configures one', () => {
    const launch = resolveSandboxLaunch({
      claim: claim(),
      project,
      strategy: 'shared',
      sharedBranch: 'gateway-work',
    });
    expect(launch).toMatchObject({
      mode: 'branch',
      branch: 'gateway-work',
      scope: 'project',
      sandboxMission: 'project',
    });
  });

  it('overrides Overlord mission.branch when the gateway strategy is shared', () => {
    const launch = resolveSandboxLaunch({
      claim: claim(),
      project,
      strategy: 'shared',
      missionBranch: { willPrepareBranch: true, baseBranch: 'main', name: 'ovld/coo-9' },
    });
    expect(launch.scope).toBe('project');
    expect(launch.mode).toBe('default-branch');
  });

  it('forces a dedicated mission branch when the gateway strategy is per-mission', () => {
    const launch = resolveSandboxLaunch({
      claim: claim(),
      project,
      strategy: 'per-mission',
      missionBranch: { willPrepareBranch: false, baseBranch: 'main', name: 'ovld/coo-9' },
    });
    expect(launch).toEqual({
      mode: 'mission-branch',
      branch: 'ovld/coo-9',
      baseBranch: 'main',
      sandboxMission: 'm1',
      scope: 'mission',
    });
  });

  it('lets an explicit claim launch mode override the gateway strategy', () => {
    const launch = resolveSandboxLaunch({
      claim: claim({ metadata: { sandboxLaunch: 'mission-branch' } }),
      project,
      strategy: 'shared',
    });
    expect(launch.scope).toBe('mission');
    expect(launch.mode).toBe('mission-branch');
  });
});
