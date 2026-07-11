/**
 * Fleet reconciliation: the unattended sweep that cleans up orphaned sandboxes,
 * enforces retention, and halts stuck runs — plus the bounded, redacted log
 * artifacts captured before any cleanup.
 */
export type { LogArtifact, BuildLogArtifactOptions } from './artifacts.js';
export {
  DEFAULT_LOG_ARTIFACT_MAX_BYTES,
  buildLogArtifact,
  captureLogsScript,
} from './artifacts.js';

export type {
  ReconcilePolicy,
  ReconcileObservation,
  ReconcileAction,
  ReconcileActionKind,
  ReconcileResult,
  ReconcileOutcome,
  ExecuteReconcileDeps,
} from './reconcile.js';
export {
  DEFAULT_MAX_RUN_MINUTES,
  DEFAULT_RECONCILE_POLICY,
  executeReconciliation,
  planReconciliation,
} from './reconcile.js';
