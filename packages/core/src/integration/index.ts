/**
 * Git integration: the per-resource lifecycle by which a mission sandbox's
 * pushed branch becomes part of the default branch.
 *
 * Racecar owns these mechanics — branch naming, checkpoint bookkeeping, the
 * immutable integration queue, the state machine, and the compare-and-swap
 * default-branch update — even when used from a terminal without Overlord.
 * Overlord supplies mission intent and renders the compact
 * {@link IntegrationResource}; it never runs Git logic itself.
 *
 * The surface is four pure layers: {@link resolveGitIntegrationConfig} (policy),
 * the {@link IntegrationState} machine, the {@link QueueEntry} model, and the
 * {@link processNextEntry} coordinator that drives one candidate under
 * compare-and-swap. Events and the Overlord resource projection round it out.
 */
export type {
  MergeStrategy,
  SyncStrategy,
  IntegrationMode,
  CheckpointPolicy,
  SynchronizationPolicy,
  IntegrationPolicy,
  CleanupPolicy,
  GitIntegrationConfig,
  MissionBranchFields,
} from './config.js';
export {
  DEFAULT_GIT_INTEGRATION_CONFIG,
  resolveGitIntegrationConfig,
  branchSlug,
  renderMissionBranch,
} from './config.js';

export type { IntegrationState } from './state.js';
export {
  TERMINAL_STATES,
  isTerminalState,
  isOpenState,
  canTransition,
  assertTransition,
} from './state.js';

export type {
  IntegrationPriority,
  ChecksObservation,
  QueueEntry,
  CreateEntryInput,
  QueueDeps,
  EntryObservation,
} from './queue.js';
export {
  createQueueEntry,
  enqueue,
  findEntry,
  transitionEntry,
  approveEntry,
  supersedeEntry,
  retryEntry,
  selectNextEntry,
  openEntries,
} from './queue.js';

export type {
  PreparedCandidate,
  CandidateConflict,
  CheckRunResult,
  AdvanceOk,
  AdvanceRaced,
  IntegrationGitOps,
  ProcessOutcome,
  ProcessResult,
  CoordinatorDeps,
} from './coordinator.js';
export { processNextEntry } from './coordinator.js';

export type {
  IntegrationEventType,
  DefaultBranchAdvancedEvent,
  IntegrationResource,
  ResourceContext,
} from './events.js';
export {
  eventForState,
  defaultBranchAdvancedEvent,
  actionsForState,
  toIntegrationResource,
} from './events.js';
