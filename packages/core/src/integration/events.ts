/**
 * The narrow surface Racecar publishes to Overlord: lifecycle events and a
 * compact per-resource integration resource.
 *
 * Overlord does not reproduce the state machine — it renders status, commit
 * links, warnings, and the actions Racecar offers, then delegates those actions
 * back to Racecar. This module is the pure translation from an internal
 * {@link QueueEntry} to that outward shape, plus the event vocabulary and the
 * `default_branch_advanced` notification sandboxes act on.
 */
import type { IntegrationState } from './state.js';
import type { QueueEntry } from './queue.js';

/** State-change events Racecar emits for Overlord to render as activity. */
export type IntegrationEventType =
  | 'branch_created'
  | 'checkpoint_pushed'
  | 'default_branch_advanced'
  | 'integration_queued'
  | 'integration_rebasing'
  | 'integration_testing'
  | 'checks_failed'
  | 'conflict_detected'
  | 'integration_superseded'
  | 'integration_merged';

/** Map a candidate's state to the event announcing its entry into that state. */
export function eventForState(state: IntegrationState): IntegrationEventType | undefined {
  switch (state) {
    case 'queued':
      return 'integration_queued';
    case 'rebasing':
      return 'integration_rebasing';
    case 'testing':
      return 'integration_testing';
    case 'checks_failed':
      return 'checks_failed';
    case 'conflict':
      return 'conflict_detected';
    case 'superseded':
      return 'integration_superseded';
    case 'merged':
      return 'integration_merged';
    default:
      return undefined;
  }
}

/**
 * The notification Racecar publishes whenever it observes a new default-branch
 * head for a resource — whether from its own merge or a human push. Every active
 * sandbox for the resource acts on it: idle clean sandboxes fast-forward; active
 * or dirty ones defer to the next safe boundary.
 */
export interface DefaultBranchAdvancedEvent {
  readonly type: 'default_branch_advanced';
  readonly resourceKey: string;
  readonly defaultBranch: string;
  readonly previousSha: string;
  readonly newSha: string;
  readonly source: 'racecar-integration' | 'external';
  readonly mergedEntryId: string | null;
  readonly occurredAt: string;
}

/** Build a {@link DefaultBranchAdvancedEvent}. */
export function defaultBranchAdvancedEvent(input: {
  resourceKey: string;
  defaultBranch: string;
  previousSha: string;
  newSha: string;
  source: 'racecar-integration' | 'external';
  mergedEntryId?: string | null;
  now?: () => Date;
}): DefaultBranchAdvancedEvent {
  return {
    type: 'default_branch_advanced',
    resourceKey: input.resourceKey,
    defaultBranch: input.defaultBranch,
    previousSha: input.previousSha,
    newSha: input.newSha,
    source: input.source,
    mergedEntryId: input.mergedEntryId ?? null,
    occurredAt: (input.now ?? (() => new Date()))().toISOString(),
  };
}

/** The compact integration resource Racecar attaches to a mission for Overlord. */
export interface IntegrationResource {
  readonly type: 'integration';
  readonly provider: 'racecar';
  readonly resourceKey: string;
  readonly branch: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly queueBaseSha: string;
  readonly rebasedSha: string | null;
  readonly deliveredSha: string;
  readonly integrationState: IntegrationState;
  readonly defaultBranch: string;
  readonly defaultBranchSha: string | null;
  readonly behindBy: number | null;
  readonly checks: { state: string; url?: string } | null;
  readonly conflict: string | null;
  readonly mergedSha: string | null;
  readonly actions: readonly string[];
}

/** The actions Overlord may offer for a candidate in a given state. */
export function actionsForState(state: IntegrationState): string[] {
  switch (state) {
    case 'awaiting_approval':
      return ['approve', 'dequeue'];
    case 'queued':
    case 'rebasing':
    case 'testing':
      return ['dequeue'];
    case 'conflict':
    case 'checks_failed':
      return ['retry', 'dequeue'];
    default:
      return [];
  }
}

/** Extra context Overlord needs that is not carried on the entry itself. */
export interface ResourceContext {
  readonly defaultBranch: string;
  readonly defaultBranchSha?: string;
  /** How many commits the mission branch is behind the default branch, if known. */
  readonly behindBy?: number;
}

/**
 * Project an internal {@link QueueEntry} into the outward {@link IntegrationResource}
 * Overlord renders. The projection exposes only the SHAs and state Overlord
 * needs for continuity; the coordinator's private bookkeeping stays internal.
 */
export function toIntegrationResource(
  entry: QueueEntry,
  context: ResourceContext,
): IntegrationResource {
  return {
    type: 'integration',
    provider: 'racecar',
    resourceKey: entry.resourceKey,
    branch: entry.branch,
    baseSha: entry.baseSha,
    headSha: entry.headSha,
    queueBaseSha: entry.queueBaseSha,
    rebasedSha: entry.rebasedSha ?? null,
    deliveredSha: entry.headSha,
    integrationState: entry.state,
    defaultBranch: context.defaultBranch,
    defaultBranchSha: context.defaultBranchSha ?? null,
    behindBy: context.behindBy ?? null,
    checks:
      entry.checks === undefined
        ? null
        : {
            state: entry.checks.state,
            ...(entry.checks.url !== undefined ? { url: entry.checks.url } : {}),
          },
    conflict: entry.conflict ?? null,
    mergedSha: entry.mergedSha ?? null,
    actions: actionsForState(entry.state),
  };
}
