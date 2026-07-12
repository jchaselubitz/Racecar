/**
 * The per-resource integration state machine.
 *
 * A mission's delivery and its integration into the default branch are separate
 * concerns: an agent can be *delivered* (its branch pushed) while its code is
 * still *queued*, *rebasing*, *testing*, blocked by a *conflict*, or awaiting
 * approval. A mission is integrated only when its delivered SHA — or a traceable
 * rebased/squashed descendant — lands on the default branch (`merged`).
 *
 * This module is the pure vocabulary and transition guard. It states which
 * moves are legal and which states are terminal, so both the coordinator and
 * the CLI validate against one source of truth. From an audit perspective the
 * lifecycle is append-only: a retry after `conflict` or `checks_failed` creates
 * a *new* candidate at a new head SHA rather than mutating the failed entry.
 */

/** Every state an integration candidate can occupy. */
export type IntegrationState =
  | 'working'
  | 'delivered'
  | 'awaiting_approval'
  | 'queued'
  | 'rebasing'
  | 'testing'
  | 'merged'
  | 'conflict'
  | 'checks_failed'
  | 'superseded';

/** States from which no further transition is possible. */
export const TERMINAL_STATES: readonly IntegrationState[] = ['merged', 'superseded'];

/**
 * Legal transitions, keyed by source state. The happy path is
 * `working -> delivered -> queued -> rebasing -> testing -> merged`; the exits
 * are `awaiting_approval`, `conflict`, `checks_failed`, and `superseded`.
 *
 * `testing -> rebasing` exists for the compare-and-swap retry: when the default
 * branch advanced under a candidate, it is re-applied against the new head
 * rather than merged blindly. Every non-terminal state can be `superseded`.
 */
const TRANSITIONS: Readonly<Record<IntegrationState, readonly IntegrationState[]>> = {
  working: ['delivered', 'superseded'],
  delivered: ['queued', 'awaiting_approval', 'superseded'],
  awaiting_approval: ['queued', 'superseded'],
  queued: ['rebasing', 'superseded'],
  rebasing: ['testing', 'conflict', 'superseded'],
  testing: ['merged', 'checks_failed', 'rebasing', 'superseded'],
  conflict: ['superseded'],
  checks_failed: ['superseded'],
  merged: [],
  superseded: [],
};

/** Whether a state is terminal (no legal transition out of it). */
export function isTerminalState(state: IntegrationState): boolean {
  return TERMINAL_STATES.includes(state);
}

/** Whether a state is open (non-terminal, and therefore supersedable). */
export function isOpenState(state: IntegrationState): boolean {
  return !isTerminalState(state);
}

/** Whether `from -> to` is a legal transition. */
export function canTransition(from: IntegrationState, to: IntegrationState): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Assert a legal transition, throwing a precise error otherwise. Used by the
 * coordinator and queue operations so an illegal move fails loudly rather than
 * corrupting the audit trail.
 */
export function assertTransition(from: IntegrationState, to: IntegrationState): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal integration transition: ${from} -> ${to}`);
  }
}
