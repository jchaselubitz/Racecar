/**
 * Deterministic failure codes.
 *
 * Fleet operations need failures that are *the same every time* for the same
 * cause: a rate-limit exhaustion always reports `rate_limited`, an agent that
 * runs past its wall-clock budget always reports `timeout`, and every code maps
 * to one fixed process exit code. That lets a supervising program (Overlord, a
 * cron reconcile, a shell script) branch on the outcome without scraping prose
 * out of an error message.
 *
 * The string code is the stable contract; the exit code is its terminal-facing
 * projection. Both are frozen here so nothing downstream has to guess.
 */

/**
 * The closed set of failure classifications Racecar reports. Every operator- or
 * automation-visible failure resolves to exactly one of these.
 */
export type FailureCode =
  | 'usage'
  | 'not_found'
  | 'conflict'
  | 'auth'
  | 'rate_limited'
  | 'timeout'
  | 'run_failed'
  | 'provider'
  | 'internal';

/**
 * Deterministic process exit code per failure code. Chosen to not collide with
 * one another and to follow convention where one exists: `2` for usage, `124`
 * for timeout (matching coreutils `timeout`), `1` reserved for a run whose agent
 * exited non-zero (the ordinary "it ran and failed" case).
 */
export const FAILURE_EXIT_CODES: Readonly<Record<FailureCode, number>> = {
  run_failed: 1,
  usage: 2,
  not_found: 3,
  conflict: 4,
  auth: 5,
  rate_limited: 6,
  provider: 7,
  internal: 70,
  timeout: 124,
};

/**
 * An error carrying a deterministic {@link FailureCode}. Throw this (or a
 * subclass) anywhere the classification is known; the CLI's top-level handler
 * turns `.code` into the fixed exit code via {@link exitCodeForError}.
 */
export class RacecarError extends Error {
  readonly code: FailureCode;
  constructor(code: FailureCode, message: string, cause?: unknown) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

/** A wall-clock budget was exceeded (see {@link withTimeout}). */
export class TimeoutError extends RacecarError {
  constructor(message: string, cause?: unknown) {
    super('timeout', message, cause);
  }
}

/** Provider error class names, matched structurally to avoid an import cycle. */
const PROVIDER_ERROR_CODES: Readonly<Record<string, FailureCode>> = {
  ProviderNotFoundError: 'not_found',
  ProviderAuthError: 'auth',
  ProviderConflictError: 'conflict',
  ProviderRateLimitError: 'rate_limited',
  ProviderTimeoutError: 'timeout',
  ProviderError: 'provider',
};

/**
 * Classify any thrown value into a {@link FailureCode}. A {@link RacecarError}
 * already carries its code; a provider error maps by its class name; everything
 * else is `internal`. This never throws, so it is safe in an error handler.
 */
export function failureCodeForError(error: unknown): FailureCode {
  if (error instanceof RacecarError) return error.code;
  if (error instanceof Error) {
    // Walk the prototype chain by name so the most specific provider class wins
    // even though this module does not import the provider error hierarchy.
    let ctor: { name: string; prototype?: unknown } | undefined = error.constructor;
    while (ctor !== undefined && typeof ctor.name === 'string') {
      const mapped = PROVIDER_ERROR_CODES[ctor.name];
      if (mapped !== undefined) return mapped;
      ctor = Object.getPrototypeOf(ctor) as { name: string } | undefined;
    }
  }
  return 'internal';
}

/** The deterministic exit code for a {@link FailureCode}. */
export function exitCodeForFailure(code: FailureCode): number {
  return FAILURE_EXIT_CODES[code];
}

/** The deterministic exit code for any thrown value. */
export function exitCodeForError(error: unknown): number {
  return exitCodeForFailure(failureCodeForError(error));
}

/**
 * Map an agent process exit code to the deterministic run-failure classification
 * the in-sandbox run wrapper records. `0` is success (no failure); `124`/`137`
 * are the SIGTERM/SIGKILL codes coreutils `timeout` uses when it kills a run
 * that overran its budget; anything else is an ordinary run failure.
 */
export function runFailureCodeForExit(exitCode: number): FailureCode | 'ok' {
  if (exitCode === 0) return 'ok';
  if (exitCode === 124 || exitCode === 137) return 'timeout';
  return 'run_failed';
}
