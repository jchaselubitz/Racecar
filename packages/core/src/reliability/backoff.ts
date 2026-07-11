/**
 * Provider rate-limit backoff.
 *
 * A provider under load answers with a rate-limit error rather than doing the
 * work. That error is transient: the request never ran, so retrying it after a
 * short wait is safe and usually succeeds. {@link retryWithBackoff} wraps a
 * single call in exponential backoff with jitter, bounded by an attempt cap so a
 * genuinely exhausted quota still fails deterministically (as `rate_limited`)
 * instead of hanging forever.
 *
 * {@link RetryingProvider} applies that policy to every {@link SandboxProvider}
 * method, so the control plane gets rate-limit resilience for free without every
 * call site re-implementing it. Only rate-limit errors are retried by default:
 * they alone are known to have done no work, so a retry can never double an
 * effect.
 */
import { ProviderRateLimitError } from '../provider/errors.js';
import type {
  CreateSandboxRequest,
  ExecRequest,
  ExecResult,
  ListSandboxesFilter,
  PreviewUrl,
  ProviderPty,
  ProviderSandbox,
  ProviderSnapshot,
  PtyRequest,
  SandboxProvider,
  SnapshotBuildRequest,
} from '../provider/provider.js';

/** Injectable sleep, so tests advance time without real delay. */
export type Sleep = (ms: number) => Promise<void>;

const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Tuning for {@link retryWithBackoff}. Every field has a sensible default. */
export interface BackoffOptions {
  /** Total attempts including the first. Default 5. */
  readonly maxAttempts?: number;
  /** Delay before the first retry, doubled each attempt. Default 250ms. */
  readonly baseDelayMs?: number;
  /** Ceiling on any single delay. Default 10s. */
  readonly maxDelayMs?: number;
  /** Fraction of the delay randomized away, 0..1, to de-synchronize callers. Default 0.5. */
  readonly jitter?: number;
  /** Whether an error is worth retrying. Default: rate-limit errors only. */
  readonly isRetryable?: (error: unknown, attempt: number) => boolean;
  /** Observed before each wait, for logging/telemetry. */
  readonly onRetry?: (info: {
    readonly error: unknown;
    readonly attempt: number;
    readonly delayMs: number;
  }) => void;
  /** Sleep implementation, injected in tests. */
  readonly sleep?: Sleep;
  /** RNG for jitter, injected in tests. Default `Math.random`. */
  readonly random?: () => number;
}

/** The default retry predicate: only provider rate-limit errors are retried. */
export function isRateLimit(error: unknown): boolean {
  return error instanceof ProviderRateLimitError;
}

/** Compute the (jittered) delay before the retry that follows `attempt` (1-based). */
export function backoffDelayMs(attempt: number, options: BackoffOptions = {}): number {
  const base = options.baseDelayMs ?? 250;
  const max = options.maxDelayMs ?? 10_000;
  const jitter = Math.min(Math.max(options.jitter ?? 0.5, 0), 1);
  const random = options.random ?? Math.random;
  const exponential = Math.min(base * 2 ** (attempt - 1), max);
  // Subtract up to `jitter` of the delay so retries spread out instead of
  // stampeding the provider in lockstep.
  const reduction = exponential * jitter * random();
  return Math.max(0, Math.round(exponential - reduction));
}

/**
 * Run `fn`, retrying on retryable errors with exponential backoff until it
 * succeeds or the attempt cap is reached. The final failure is rethrown as-is,
 * so its {@link ProviderRateLimitError} type (and thus the `rate_limited`
 * failure code) is preserved.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: BackoffOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 5);
  const isRetryable = options.isRetryable ?? isRateLimit;
  const sleep = options.sleep ?? realSleep;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await fn();
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryable(error, attempt)) throw error;
      const delayMs = backoffDelayMs(attempt, options);
      options.onRetry?.({ error, attempt, delayMs });
      await sleep(delayMs);
    }
  }
}

/**
 * A {@link SandboxProvider} decorator that wraps every call in
 * {@link retryWithBackoff}. Retrying only on rate-limit errors keeps it safe for
 * non-idempotent methods (`createSandbox`, `exec`): a rate-limit rejection means
 * the request did no work, so the retry cannot duplicate an effect. Callbacks on
 * `buildSnapshot`/`createPty` never fire before that rejection either.
 */
export class RetryingProvider implements SandboxProvider {
  readonly name: string;
  readonly #inner: SandboxProvider;
  readonly #options: BackoffOptions;

  constructor(inner: SandboxProvider, options: BackoffOptions = {}) {
    this.#inner = inner;
    this.#options = options;
    this.name = inner.name;
  }

  #retry<T>(fn: () => Promise<T>): Promise<T> {
    return retryWithBackoff(fn, this.#options);
  }

  buildSnapshot(request: SnapshotBuildRequest): Promise<ProviderSnapshot> {
    return this.#retry(() => this.#inner.buildSnapshot(request));
  }
  getSnapshot(name: string): Promise<ProviderSnapshot | null> {
    return this.#retry(() => this.#inner.getSnapshot(name));
  }
  deleteSnapshot(name: string): Promise<void> {
    return this.#retry(() => this.#inner.deleteSnapshot(name));
  }
  createSandbox(request: CreateSandboxRequest): Promise<ProviderSandbox> {
    return this.#retry(() => this.#inner.createSandbox(request));
  }
  getSandbox(id: string): Promise<ProviderSandbox | null> {
    return this.#retry(() => this.#inner.getSandbox(id));
  }
  listSandboxes(filter?: ListSandboxesFilter): Promise<ProviderSandbox[]> {
    return this.#retry(() => this.#inner.listSandboxes(filter));
  }
  startSandbox(id: string, timeoutSeconds?: number): Promise<void> {
    return this.#retry(() => this.#inner.startSandbox(id, timeoutSeconds));
  }
  stopSandbox(id: string, timeoutSeconds?: number): Promise<void> {
    return this.#retry(() => this.#inner.stopSandbox(id, timeoutSeconds));
  }
  archiveSandbox(id: string): Promise<void> {
    return this.#retry(() => this.#inner.archiveSandbox(id));
  }
  deleteSandbox(id: string): Promise<void> {
    return this.#retry(() => this.#inner.deleteSandbox(id));
  }
  setLabels(id: string, labels: Record<string, string>): Promise<Record<string, string>> {
    return this.#retry(() => this.#inner.setLabels(id, labels));
  }
  heartbeat(id: string): Promise<void> {
    return this.#retry(() => this.#inner.heartbeat(id));
  }
  exec(id: string, request: ExecRequest): Promise<ExecResult> {
    return this.#retry(() => this.#inner.exec(id, request));
  }
  createPty(id: string, request: PtyRequest): Promise<ProviderPty> {
    return this.#retry(() => this.#inner.createPty(id, request));
  }
  getPreviewUrl(id: string, port: number): Promise<PreviewUrl> {
    return this.#retry(() => this.#inner.getPreviewUrl(id, port));
  }
}
