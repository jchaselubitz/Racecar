import { describe, expect, it } from 'vitest';
import {
  actionsForState,
  approveEntry,
  assertTransition,
  branchSlug,
  canTransition,
  createQueueEntry,
  DEFAULT_GIT_INTEGRATION_CONFIG,
  defaultBranchAdvancedEvent,
  enqueue,
  eventForState,
  isOpenState,
  isTerminalState,
  openEntries,
  processNextEntry,
  renderMissionBranch,
  resolveGitIntegrationConfig,
  retryEntry,
  selectNextEntry,
  supersedeEntry,
  toIntegrationResource,
  transitionEntry,
  type CandidateConflict,
  type CreateEntryInput,
  type GitIntegrationConfig,
  type IntegrationGitOps,
  type PreparedCandidate,
  type QueueDeps,
  type QueueEntry,
} from './index.js';

// A monotonic, deterministic id + clock so entry order and timestamps are stable.
function deterministicDeps(startMs = 1_000): QueueDeps {
  let tick = 0;
  let seq = 0;
  return {
    now: () => new Date(startMs + tick++ * 1_000),
    newEntryId: () => `intq_${(seq++).toString().padStart(4, '0')}`,
  };
}

const BASE_INPUT: CreateEntryInput = {
  resourceKey: 'app',
  missionId: 'coo:252',
  objectiveId: 'obj-1',
  branch: 'ovld/coo-252-git',
  baseSha: 'base0',
  headSha: 'head1',
  queueBaseSha: 'main0',
};

describe('resolveGitIntegrationConfig', () => {
  it('returns the default policy for empty input', () => {
    expect(resolveGitIntegrationConfig(undefined)).toEqual(DEFAULT_GIT_INTEGRATION_CONFIG);
    expect(resolveGitIntegrationConfig(null)).toEqual(DEFAULT_GIT_INTEGRATION_CONFIG);
  });

  it('accepts either the whole document or the git section', () => {
    const doc = resolveGitIntegrationConfig({ version: 1, git: { defaultBranch: 'trunk' } });
    const section = resolveGitIntegrationConfig({ defaultBranch: 'trunk' });
    expect(doc.defaultBranch).toBe('trunk');
    expect(section.defaultBranch).toBe('trunk');
  });

  it('merges nested overrides onto defaults', () => {
    const config = resolveGitIntegrationConfig({
      git: {
        integration: { mergeStrategy: 'rebase', checks: ['yarn test'] },
        checkpoints: { intervalMinutes: 5 },
      },
    });
    expect(config.integration.mergeStrategy).toBe('rebase');
    expect(config.integration.checks).toEqual(['yarn test']);
    // Untouched fields keep their defaults.
    expect(config.integration.requireApproval).toBe(false);
    expect(config.checkpoints.intervalMinutes).toBe(5);
    expect(config.checkpoints.pushOnObjectiveDelivery).toBe(true);
  });

  it('rejects invalid field types and values', () => {
    expect(() => resolveGitIntegrationConfig({ git: { defaultBranch: 5 } })).toThrow(
      /defaultBranch/,
    );
    expect(() =>
      resolveGitIntegrationConfig({ git: { integration: { mergeStrategy: 'octopus' } } }),
    ).toThrow(/mergeStrategy/);
    expect(() => resolveGitIntegrationConfig({ git: { integration: { concurrency: 0 } } })).toThrow(
      /concurrency/,
    );
    expect(() =>
      resolveGitIntegrationConfig({ git: { integration: { checks: ['ok', 3] } } }),
    ).toThrow(/checks/);
  });
});

describe('renderMissionBranch', () => {
  it('substitutes and slugifies tokens', () => {
    expect(
      renderMissionBranch('ovld/{mission.displayId}-{slug}', {
        missionDisplayId: 'coo:252',
        missionId: 'uuid-1',
        slug: 'Git & Merges',
      }),
    ).toBe('ovld/coo-252-git-merges');
  });

  it('falls back to the mission id when no display id is given', () => {
    expect(
      renderMissionBranch('ovld/{mission.displayId}', { missionId: 'uuid-1', slug: 's' }),
    ).toBe('ovld/uuid-1');
  });

  it('slugifies arbitrary labels safely', () => {
    expect(branchSlug('  Feature/ABC 123!! ')).toBe('feature-abc-123');
  });
});

describe('integration state machine', () => {
  it('permits the happy path and forbids skips', () => {
    expect(canTransition('working', 'delivered')).toBe(true);
    expect(canTransition('queued', 'rebasing')).toBe(true);
    expect(canTransition('rebasing', 'testing')).toBe(true);
    expect(canTransition('testing', 'merged')).toBe(true);
    expect(canTransition('queued', 'merged')).toBe(false);
    expect(canTransition('working', 'merged')).toBe(false);
  });

  it('allows a compare-and-swap retry from testing back to rebasing', () => {
    expect(canTransition('testing', 'rebasing')).toBe(true);
  });

  it('lets every open state be superseded but no terminal state', () => {
    for (const state of [
      'working',
      'delivered',
      'queued',
      'rebasing',
      'testing',
      'conflict',
    ] as const) {
      expect(canTransition(state, 'superseded')).toBe(true);
      expect(isOpenState(state)).toBe(true);
    }
    expect(isTerminalState('merged')).toBe(true);
    expect(isTerminalState('superseded')).toBe(true);
    expect(canTransition('merged', 'superseded')).toBe(false);
  });

  it('assertTransition throws on an illegal move', () => {
    expect(() => assertTransition('queued', 'merged')).toThrow(/illegal integration transition/);
  });
});

describe('queue entries', () => {
  it('creates a queued entry, or awaiting_approval when policy requires it', () => {
    const queued = createQueueEntry(BASE_INPUT, deterministicDeps());
    expect(queued.state).toBe('queued');
    const gated = createQueueEntry({ ...BASE_INPUT, requireApproval: true }, deterministicDeps());
    expect(gated.state).toBe('awaiting_approval');
  });

  it('supersedes an earlier open entry for the same mission on re-delivery', () => {
    const deps = deterministicDeps();
    const first = enqueue([], BASE_INPUT, deps);
    const second = enqueue(first.entries, { ...BASE_INPUT, headSha: 'head2' }, deps);
    expect(second.entries).toHaveLength(2);
    const oldEntry = second.entries.find((e) => e.entryId === first.entry.entryId);
    expect(oldEntry?.state).toBe('superseded');
    expect(oldEntry?.finishedAt).toBeDefined();
    expect(second.entry.state).toBe('queued');
    // A different mission is untouched.
    const other = enqueue(second.entries, { ...BASE_INPUT, missionId: 'coo:999' }, deps);
    expect(other.entries.filter((e) => e.state === 'queued')).toHaveLength(2);
  });

  it('does not mutate identity fields on transition', () => {
    const deps = deterministicDeps();
    const { entries, entry } = enqueue([], BASE_INPUT, deps);
    const moved = transitionEntry(entries, entry.entryId, 'rebasing', { startedAt: 'X' }, deps);
    expect(moved.entry.state).toBe('rebasing');
    expect(moved.entry.headSha).toBe('head1');
    expect(moved.entry.baseSha).toBe('base0');
    expect(moved.entry.queueBaseSha).toBe('main0');
    // Original array element is unchanged (pure).
    expect(entry.state).toBe('queued');
  });

  it('approves an awaiting_approval entry into queued', () => {
    const deps = deterministicDeps();
    const created = enqueue([], { ...BASE_INPUT, requireApproval: true }, deps);
    const approved = approveEntry(created.entries, created.entry.entryId, deps);
    expect(approved.entry.state).toBe('queued');
    expect(() => approveEntry(approved.entries, approved.entry.entryId)).toThrow(
      /not awaiting_approval/,
    );
  });

  it('supersede refuses a terminal entry', () => {
    const deps = deterministicDeps();
    const created = enqueue([], BASE_INPUT, deps);
    const gone = supersedeEntry(created.entries, created.entry.entryId, deps);
    expect(gone.entry.state).toBe('superseded');
    expect(() => supersedeEntry(gone.entries, created.entry.entryId)).toThrow(/already superseded/);
  });

  it('retry creates a new entry, supersedes the failed one, and records the link', () => {
    const deps = deterministicDeps();
    const created = enqueue([], BASE_INPUT, deps);
    const failed = transitionEntry(created.entries, created.entry.entryId, 'rebasing', {}, deps);
    const conflicted = transitionEntry(
      failed.entries,
      created.entry.entryId,
      'conflict',
      {
        conflict: 'merge conflict in src/a.ts',
      },
      deps,
    );
    const retried = retryEntry(conflicted.entries, created.entry.entryId, 'head2', {}, deps);
    expect(retried.entry.headSha).toBe('head2');
    expect(retried.entry.state).toBe('queued');
    expect(retried.entry.supersedesEntryId).toBe(created.entry.entryId);
    const old = retried.entries.find((e) => e.entryId === created.entry.entryId);
    expect(old?.state).toBe('superseded');
  });

  it('retry refuses an entry that has not failed', () => {
    const deps = deterministicDeps();
    const created = enqueue([], BASE_INPUT, deps);
    expect(() => retryEntry(created.entries, created.entry.entryId, 'head2')).toThrow(
      /only conflict\/checks_failed retry/,
    );
  });

  it('selects the next entry by priority then FIFO', () => {
    const deps = deterministicDeps();
    let entries: QueueEntry[] = [];
    entries = enqueue(entries, { ...BASE_INPUT, missionId: 'm1' }, deps).entries;
    entries = enqueue(entries, { ...BASE_INPUT, missionId: 'm2' }, deps).entries;
    entries = enqueue(entries, { ...BASE_INPUT, missionId: 'm3', priority: 'high' }, deps).entries;
    expect(selectNextEntry(entries)?.missionId).toBe('m3');
    // With the high-priority one gone, FIFO picks the earliest.
    const withoutHigh = entries.filter((e) => e.missionId !== 'm3');
    expect(selectNextEntry(withoutHigh)?.missionId).toBe('m1');
    expect(openEntries(entries)).toHaveLength(3);
  });
});

// A scripted fake for the coordinator's Git operations. Each method returns a
// resolved promise (no I/O), so the coordinator's decisions are what is tested.
function fakeOps(
  overrides: Partial<IntegrationGitOps> & { head?: string } = {},
): IntegrationGitOps {
  return {
    readDefaultBranchSha:
      overrides.readDefaultBranchSha ?? (() => Promise.resolve(overrides.head ?? 'main0')),
    prepareCandidate:
      overrides.prepareCandidate ??
      ((entry): Promise<PreparedCandidate> =>
        Promise.resolve({ ok: true, rebasedSha: `rebased-${entry.headSha}` })),
    runChecks: overrides.runChecks ?? (() => Promise.resolve({ ok: true, output: 'ok' })),
    advanceDefaultBranch:
      overrides.advanceDefaultBranch ??
      ((_expected, rebasedSha) => Promise.resolve({ ok: true, mergedSha: `merged-${rebasedSha}` })),
  };
}

const CONFIG: GitIntegrationConfig = {
  ...DEFAULT_GIT_INTEGRATION_CONFIG,
  integration: { ...DEFAULT_GIT_INTEGRATION_CONFIG.integration, checks: ['yarn test'] },
};

describe('processNextEntry (coordinator)', () => {
  it('is idle when nothing is queued', async () => {
    const result = await processNextEntry([], CONFIG, fakeOps());
    expect(result.outcome).toBe('idle');
    expect(result.entry).toBeUndefined();
  });

  it('drives a candidate to merged under compare-and-swap', async () => {
    const deps = deterministicDeps();
    const { entries } = enqueue([], BASE_INPUT, deps);
    const result = await processNextEntry(entries, CONFIG, fakeOps({ head: 'main5' }), {
      now: () => new Date(0),
    });
    expect(result.outcome).toBe('merged');
    expect(result.expectedSha).toBe('main5');
    expect(result.entry?.state).toBe('merged');
    expect(result.entry?.rebasedSha).toBe('rebased-head1');
    expect(result.entry?.mergedSha).toBe('merged-rebased-head1');
    expect(result.entry?.checks?.state).toBe('passed');
  });

  it('routes a conflicting candidate to conflict', async () => {
    const deps = deterministicDeps();
    const { entries } = enqueue([], BASE_INPUT, deps);
    const ops = fakeOps({
      prepareCandidate: (): Promise<CandidateConflict> =>
        Promise.resolve({ ok: false, conflict: 'conflict in a.ts' }),
    });
    const result = await processNextEntry(entries, CONFIG, ops);
    expect(result.outcome).toBe('conflict');
    expect(result.entry?.state).toBe('conflict');
    expect(result.entry?.conflict).toBe('conflict in a.ts');
  });

  it('routes a check failure to checks_failed with output', async () => {
    const deps = deterministicDeps();
    const { entries } = enqueue([], BASE_INPUT, deps);
    const ops = fakeOps({
      runChecks: () => Promise.resolve({ ok: false, output: '1 test failed' }),
    });
    const result = await processNextEntry(entries, CONFIG, ops);
    expect(result.outcome).toBe('checks_failed');
    expect(result.entry?.state).toBe('checks_failed');
    expect(result.entry?.checks).toEqual({ state: 'failed', output: '1 test failed' });
  });

  it('returns a raced candidate to rebasing instead of merging on a stale base', async () => {
    const deps = deterministicDeps();
    const { entries } = enqueue([], BASE_INPUT, deps);
    const ops = fakeOps({
      advanceDefaultBranch: () => Promise.resolve({ ok: false, actualSha: 'main9' }),
    });
    const result = await processNextEntry(entries, CONFIG, ops);
    expect(result.outcome).toBe('cas_retry');
    expect(result.entry?.state).toBe('rebasing');
    expect(result.observedSha).toBe('main9');
    // The candidate is still eligible for a later step, not merged or dropped.
    expect(result.entry?.mergedSha).toBeUndefined();
  });
});

describe('events and resource projection', () => {
  it('maps states to their announcing event', () => {
    expect(eventForState('merged')).toBe('integration_merged');
    expect(eventForState('conflict')).toBe('conflict_detected');
    expect(eventForState('working')).toBeUndefined();
  });

  it('offers state-appropriate actions', () => {
    expect(actionsForState('awaiting_approval')).toEqual(['approve', 'dequeue']);
    expect(actionsForState('conflict')).toEqual(['retry', 'dequeue']);
    expect(actionsForState('merged')).toEqual([]);
  });

  it('builds a default_branch_advanced event', () => {
    const event = defaultBranchAdvancedEvent({
      resourceKey: 'app',
      defaultBranch: 'main',
      previousSha: 'a',
      newSha: 'b',
      source: 'racecar-integration',
      mergedEntryId: 'intq_1',
      now: () => new Date('2026-07-12T00:00:00.000Z'),
    });
    expect(event).toMatchObject({
      type: 'default_branch_advanced',
      newSha: 'b',
      source: 'racecar-integration',
      mergedEntryId: 'intq_1',
      occurredAt: '2026-07-12T00:00:00.000Z',
    });
  });

  it('projects an entry into the compact Overlord resource', () => {
    const deps = deterministicDeps();
    const { entry } = enqueue([], BASE_INPUT, deps);
    const resource = toIntegrationResource(entry, {
      defaultBranch: 'main',
      defaultBranchSha: 'main0',
      behindBy: 2,
    });
    expect(resource).toMatchObject({
      type: 'integration',
      provider: 'racecar',
      resourceKey: 'app',
      deliveredSha: 'head1',
      integrationState: 'queued',
      defaultBranch: 'main',
      behindBy: 2,
      actions: ['dequeue'],
    });
  });
});
