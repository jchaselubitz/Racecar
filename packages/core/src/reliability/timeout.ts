/**
 * Timeout enforcement outside the sandbox.
 *
 * The in-sandbox side of the budget is the run wrapper's `timeout` prefix, which
 * kills an agent that overruns even when nothing is attached. This is the
 * control-plane side: a provider call that hangs (a wedged create, a stuck
 * archive) must not wedge a reconcile pass or an interactive command with it.
 * {@link withTimeout} races the operation against a deadline and rejects with a
 * deterministic {@link TimeoutError} (failure code `timeout`) when the deadline
 * wins, so the caller fails predictably instead of blocking forever.
 *
 * The underlying operation is not cancelled — most provider SDK calls have no
 * cancellation — it is abandoned. The deterministic failure is the contract.
 */
import { TimeoutError } from './failure.js';

/** Injectable timer surface so tests need no real wall-clock delay. */
export interface TimeoutScheduler {
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
}

const realScheduler: TimeoutScheduler = {
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Options for {@link withTimeout}. */
export interface WithTimeoutOptions {
  /** Label included in the error message to identify the operation. */
  readonly label?: string;
  /** Timer implementation, injected in tests. */
  readonly scheduler?: TimeoutScheduler;
}

/**
 * Resolve `promise`, or reject with a {@link TimeoutError} if it has not settled
 * within `ms`. A non-positive `ms` disables the timeout and simply awaits the
 * promise. The timer is always cleared, so a fast success leaves nothing pending.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  options: WithTimeoutOptions = {},
): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  const scheduler = options.scheduler ?? realScheduler;
  const what = options.label !== undefined ? `${options.label} ` : '';
  let handle: unknown;
  const deadline = new Promise<never>((_, reject) => {
    handle = scheduler.setTimer(() => {
      reject(new TimeoutError(`operation ${what}timed out after ${ms}ms`));
    }, ms);
  });
  // Race the operation against the deadline; whichever settles first wins and the
  // timer is always cleared. The original rejection propagates unchanged.
  return Promise.race([promise, deadline]).finally(() => scheduler.clearTimer(handle));
}
