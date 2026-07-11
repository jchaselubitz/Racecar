/**
 * Reliability primitives shared across the control plane: deterministic failure
 * codes, provider rate-limit backoff, and out-of-sandbox timeout enforcement.
 */
export type { FailureCode } from './failure.js';
export {
  FAILURE_EXIT_CODES,
  RacecarError,
  TimeoutError,
  exitCodeForError,
  exitCodeForFailure,
  failureCodeForError,
  runFailureCodeForExit,
} from './failure.js';

export type { BackoffOptions, Sleep } from './backoff.js';
export { RetryingProvider, backoffDelayMs, isRateLimit, retryWithBackoff } from './backoff.js';

export type { TimeoutScheduler, WithTimeoutOptions } from './timeout.js';
export { withTimeout } from './timeout.js';
