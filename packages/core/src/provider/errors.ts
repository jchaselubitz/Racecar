/**
 * Provider-neutral error hierarchy. Adapters translate their SDK's errors into
 * these so callers (CLI, tests) never couple to a specific provider's error
 * types. Each carries an optional `cause` referencing the original error.
 */
export class ProviderError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = new.target.name;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/** A referenced sandbox or snapshot does not exist. */
export class ProviderNotFoundError extends ProviderError {}

/** Authentication or authorization failed (bad or missing API key, etc.). */
export class ProviderAuthError extends ProviderError {}

/** The request conflicts with current state (e.g. archiving a running sandbox). */
export class ProviderConflictError extends ProviderError {}

/** The provider rate-limited the request. */
export class ProviderRateLimitError extends ProviderError {}

/** The operation timed out. */
export class ProviderTimeoutError extends ProviderError {}
