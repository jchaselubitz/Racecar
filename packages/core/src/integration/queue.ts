/**
 * The integration queue: immutable, per-resource candidate entries.
 *
 * The queue stores *entries*, not branch pointers. An entry names an exact
 * commit (`headSha`) to integrate; it is created once and never edited in place.
 * The coordinator may append derived observations (`startedAt`, `rebasedSha`,
 * `mergedSha`, `conflict`, …) but must never change the identity fields that
 * decide *what code* is being integrated: `resourceKey`, `missionId`, `branch`,
 * `baseSha`, `headSha`, and `queueBaseSha`.
 *
 * A retry or a re-delivery does not mutate a failed entry — it creates a new one
 * and marks the previous non-terminal entry `superseded`, so the record of what
 * was attempted survives. Every operation here is a pure function over a
 * `readonly QueueEntry[]`: it returns a new array and (where relevant) the
 * affected entry, keeping the whole model deterministic and testable.
 */
import { assertTransition, isOpenState, isTerminalState, type IntegrationState } from './state.js';

/** Candidate priority; higher priority is integrated first among ready entries. */
export type IntegrationPriority = 'low' | 'normal' | 'high';

/** Outcome of the configured checks against a post-rebase candidate. */
export interface ChecksObservation {
  readonly state: 'pending' | 'passed' | 'failed';
  /** Redacted, bounded check output when it has run. */
  readonly output?: string;
  /** Optional link to hosted check results. */
  readonly url?: string;
}

/**
 * One immutable integration candidate. The first block is identity — fixed at
 * creation. The second block is observations the coordinator appends as the
 * candidate moves through the machine.
 */
export interface QueueEntry {
  // --- identity (immutable) ---
  readonly entryId: string;
  readonly resourceKey: string;
  readonly missionId: string;
  readonly objectiveId: string | null;
  readonly branch: string;
  /** Default-branch commit the mission branch claimed as its base. */
  readonly baseSha: string;
  /** Exact mission-branch commit this candidate integrates. */
  readonly headSha: string;
  /** Default-branch head observed when the entry was created. */
  readonly queueBaseSha: string;
  readonly priority: IntegrationPriority;
  readonly createdAt: string;
  /** Entry this one replaces (a retry), or null. */
  readonly supersedesEntryId: string | null;

  // --- observations (appended) ---
  readonly state: IntegrationState;
  /** When the coordinator began processing this entry. */
  readonly startedAt?: string;
  /** When the entry reached a terminal state. */
  readonly finishedAt?: string;
  /** Candidate commit produced by applying `headSha` onto the latest default branch. */
  readonly rebasedSha?: string;
  /** Commit now reachable from the default branch that represents this candidate. */
  readonly mergedSha?: string;
  /** Conflict detail when `state` is `conflict`. */
  readonly conflict?: string;
  /** Check results as they run. */
  readonly checks?: ChecksObservation;
}

/** Identity fields a caller supplies to create a queue entry. */
export interface CreateEntryInput {
  readonly resourceKey: string;
  readonly missionId: string;
  readonly objectiveId?: string | null;
  readonly branch: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly queueBaseSha: string;
  readonly priority?: IntegrationPriority;
  /** Whether project policy requires approval before this candidate is queued. */
  readonly requireApproval?: boolean;
  readonly supersedesEntryId?: string | null;
}

/** Injectable clock and id source so entry creation is deterministic in tests. */
export interface QueueDeps {
  readonly now?: () => Date;
  readonly newEntryId?: () => string;
}

let entryCounter = 0;

/** Default entry-id factory: sortable-ish, collision-resistant, `intq_`-prefixed. */
function defaultEntryId(): string {
  entryCounter = (entryCounter + 1) % 1_000_000;
  const time = Date.now().toString(36);
  const seq = entryCounter.toString(36).padStart(4, '0');
  const rand = Math.floor(Math.random() * 0xffffff)
    .toString(36)
    .padStart(4, '0');
  return `intq_${time}${seq}${rand}`;
}

function resolveDeps(deps: QueueDeps | undefined): Required<QueueDeps> {
  return {
    now: deps?.now ?? (() => new Date()),
    newEntryId: deps?.newEntryId ?? defaultEntryId,
  };
}

/**
 * Build a single immutable entry from identity input. A candidate that requires
 * approval starts `awaiting_approval`; otherwise it starts `queued`.
 */
export function createQueueEntry(input: CreateEntryInput, deps?: QueueDeps): QueueEntry {
  const { now, newEntryId } = resolveDeps(deps);
  return {
    entryId: newEntryId(),
    resourceKey: input.resourceKey,
    missionId: input.missionId,
    objectiveId: input.objectiveId ?? null,
    branch: input.branch,
    baseSha: input.baseSha,
    headSha: input.headSha,
    queueBaseSha: input.queueBaseSha,
    priority: input.priority ?? 'normal',
    createdAt: now().toISOString(),
    supersedesEntryId: input.supersedesEntryId ?? null,
    state: input.requireApproval === true ? 'awaiting_approval' : 'queued',
  };
}

/** Entries that share a resource *and* mission with `input`. */
function sameCandidateLine(entry: QueueEntry, resourceKey: string, missionId: string): boolean {
  return entry.resourceKey === resourceKey && entry.missionId === missionId;
}

/**
 * Enqueue a new candidate. Any earlier non-terminal entry for the same
 * resource+mission is marked `superseded` — a mission's newest delivery is the
 * only one that may merge. Returns the updated queue and the created entry.
 */
export function enqueue(
  entries: readonly QueueEntry[],
  input: CreateEntryInput,
  deps?: QueueDeps,
): { entries: QueueEntry[]; entry: QueueEntry } {
  const { now } = resolveDeps(deps);
  const finishedAt = now().toISOString();
  const superseded = entries.map((entry): QueueEntry =>
    sameCandidateLine(entry, input.resourceKey, input.missionId) && isOpenState(entry.state)
      ? { ...entry, state: 'superseded', finishedAt }
      : entry,
  );
  const entry = createQueueEntry(input, deps);
  return { entries: [...superseded, entry], entry };
}

/** Find an entry by id, or undefined. */
export function findEntry(entries: readonly QueueEntry[], entryId: string): QueueEntry | undefined {
  return entries.find((entry) => entry.entryId === entryId);
}

function replaceEntry(
  entries: readonly QueueEntry[],
  entryId: string,
  next: QueueEntry,
): QueueEntry[] {
  return entries.map((entry) => (entry.entryId === entryId ? next : entry));
}

/** Fields the coordinator may append when moving an entry between states. */
export type EntryObservation = Pick<
  QueueEntry,
  'startedAt' | 'finishedAt' | 'rebasedSha' | 'mergedSha' | 'conflict' | 'checks'
>;

/**
 * Transition one entry to a new state, validating the move and appending
 * observations. Terminal states also stamp `finishedAt` when the caller has not
 * supplied one. Throws if the entry is missing or the transition is illegal.
 */
export function transitionEntry(
  entries: readonly QueueEntry[],
  entryId: string,
  to: IntegrationState,
  observation: Partial<EntryObservation> = {},
  deps?: QueueDeps,
): { entries: QueueEntry[]; entry: QueueEntry } {
  const current = findEntry(entries, entryId);
  if (current === undefined) throw new Error(`no integration entry '${entryId}'`);
  assertTransition(current.state, to);
  const { now } = resolveDeps(deps);
  const finishedAt =
    isTerminalState(to) && observation.finishedAt === undefined
      ? now().toISOString()
      : observation.finishedAt;
  const next: QueueEntry = {
    ...current,
    ...observation,
    ...(finishedAt !== undefined ? { finishedAt } : {}),
    state: to,
  };
  return { entries: replaceEntry(entries, entryId, next), entry: next };
}

/** Move an `awaiting_approval` entry to `queued`. Does not change the commit. */
export function approveEntry(
  entries: readonly QueueEntry[],
  entryId: string,
  deps?: QueueDeps,
): { entries: QueueEntry[]; entry: QueueEntry } {
  const current = findEntry(entries, entryId);
  if (current === undefined) throw new Error(`no integration entry '${entryId}'`);
  if (current.state !== 'awaiting_approval') {
    throw new Error(`entry '${entryId}' is ${current.state}, not awaiting_approval`);
  }
  return transitionEntry(entries, entryId, 'queued', {}, deps);
}

/**
 * Mark a non-terminal entry `superseded` (a cancellation/dequeue). The audit
 * record remains; it can never merge. Throws if the entry is already terminal.
 */
export function supersedeEntry(
  entries: readonly QueueEntry[],
  entryId: string,
  deps?: QueueDeps,
): { entries: QueueEntry[]; entry: QueueEntry } {
  const current = findEntry(entries, entryId);
  if (current === undefined) throw new Error(`no integration entry '${entryId}'`);
  if (isTerminalState(current.state)) {
    throw new Error(`entry '${entryId}' is already ${current.state}`);
  }
  return transitionEntry(entries, entryId, 'superseded', {}, deps);
}

/**
 * Retry a failed candidate. The prior entry must be `conflict` or
 * `checks_failed`. A new immutable entry is created at the freshly pushed
 * `newHeadSha`, recording `supersedesEntryId`, and the failed entry is marked
 * `superseded`. Identity is otherwise inherited from the failed entry.
 */
export function retryEntry(
  entries: readonly QueueEntry[],
  failedEntryId: string,
  newHeadSha: string,
  options: { queueBaseSha?: string; requireApproval?: boolean } = {},
  deps?: QueueDeps,
): { entries: QueueEntry[]; entry: QueueEntry } {
  const failed = findEntry(entries, failedEntryId);
  if (failed === undefined) throw new Error(`no integration entry '${failedEntryId}'`);
  if (failed.state !== 'conflict' && failed.state !== 'checks_failed') {
    throw new Error(
      `entry '${failedEntryId}' is ${failed.state}; only conflict/checks_failed retry`,
    );
  }
  const superseded = supersedeEntry(entries, failedEntryId, deps);
  return enqueue(
    superseded.entries,
    {
      resourceKey: failed.resourceKey,
      missionId: failed.missionId,
      objectiveId: failed.objectiveId,
      branch: failed.branch,
      baseSha: failed.baseSha,
      headSha: newHeadSha,
      queueBaseSha: options.queueBaseSha ?? failed.queueBaseSha,
      priority: failed.priority,
      ...(options.requireApproval !== undefined
        ? { requireApproval: options.requireApproval }
        : {}),
      supersedesEntryId: failedEntryId,
    },
    deps,
  );
}

const PRIORITY_RANK: Readonly<Record<IntegrationPriority, number>> = {
  high: 0,
  normal: 1,
  low: 2,
};

/**
 * Select the next candidate to integrate for a resource: the `queued` entry
 * with the highest priority, breaking ties by creation order (FIFO). Returns
 * undefined when nothing is ready. Only `queued` entries are eligible — an entry
 * mid-flight (`rebasing`/`testing`) or awaiting approval is never picked.
 */
export function selectNextEntry(
  entries: readonly QueueEntry[],
  resourceKey?: string,
): QueueEntry | undefined {
  const ready = entries
    .filter((entry) => entry.state === 'queued')
    .filter((entry) => resourceKey === undefined || entry.resourceKey === resourceKey);
  if (ready.length === 0) return undefined;
  return [...ready].sort((a, b) => {
    const rank = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (rank !== 0) return rank;
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  })[0];
}

/** All non-terminal entries, optionally scoped to one resource. */
export function openEntries(entries: readonly QueueEntry[], resourceKey?: string): QueueEntry[] {
  return entries.filter(
    (entry) =>
      isOpenState(entry.state) && (resourceKey === undefined || entry.resourceKey === resourceKey),
  );
}
