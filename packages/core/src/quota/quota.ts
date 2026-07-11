/**
 * Quotas: the caps that keep unattended fleet operation from surprising the
 * operator with runaway concurrency or spend.
 *
 * A quota is evaluated at sandbox-creation time against two scopes:
 *
 *  - **project** — a single project's own limits (its concurrency cap and an
 *    optional hourly-spend ceiling), so one noisy project cannot monopolize the
 *    fleet.
 *  - **org** — a fleet-wide ceiling across every project, so the sum of all
 *    projects still fits a budget.
 *
 * The evaluator is pure: it takes the *current usage* the caller measured (from
 * a label listing plus the cost model) and the candidate being added, and
 * returns the violations. No I/O, so the decision is exhaustively testable.
 */

/** Which scope a limit belongs to. */
export type QuotaScope = 'org' | 'project';

/** The caps a scope may impose. An undefined (or non-positive) cap is "unlimited". */
export interface QuotaLimits {
  /** Maximum number of concurrently non-archived sandboxes. */
  readonly maxConcurrentSandboxes?: number;
  /** Maximum modeled hourly spend, in USD, across the scope's live sandboxes. */
  readonly maxHourlySpendUsd?: number;
}

/** A measured snapshot of a scope's current consumption. */
export interface QuotaUsage {
  /** Live (non-archived) sandboxes currently in the scope. */
  readonly concurrentSandboxes: number;
  /** Modeled hourly spend of those sandboxes, in USD. */
  readonly hourlySpendUsd: number;
}

/** The resource a candidate sandbox would add to a scope. */
export interface QuotaDelta {
  /** Sandboxes the candidate adds (normally 1). */
  readonly concurrentSandboxes: number;
  /** Modeled hourly spend the candidate adds, in USD. */
  readonly hourlySpendUsd: number;
}

/** A single breached limit. */
export interface QuotaViolation {
  readonly scope: QuotaScope;
  /** Which limit was breached. */
  readonly limit: 'maxConcurrentSandboxes' | 'maxHourlySpendUsd';
  /** The cap that would be exceeded. */
  readonly allowed: number;
  /** What usage would become if the candidate were admitted. */
  readonly projected: number;
  /** Human-readable, secret-free explanation. */
  readonly message: string;
}

/** Whether a cap is set (a positive, finite number). Non-positive means unlimited. */
function isCap(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

/**
 * Evaluate one scope's limits against its current usage plus the candidate.
 * Returns every violation (empty means the candidate fits), so a caller can
 * report all breached caps at once rather than one at a time.
 */
export function evaluateQuota(
  scope: QuotaScope,
  usage: QuotaUsage,
  delta: QuotaDelta,
  limits: QuotaLimits,
): QuotaViolation[] {
  const violations: QuotaViolation[] = [];
  if (isCap(limits.maxConcurrentSandboxes)) {
    const projected = usage.concurrentSandboxes + delta.concurrentSandboxes;
    if (projected > limits.maxConcurrentSandboxes) {
      violations.push({
        scope,
        limit: 'maxConcurrentSandboxes',
        allowed: limits.maxConcurrentSandboxes,
        projected,
        message: `${scope} concurrent sandbox cap reached: ${projected} > ${limits.maxConcurrentSandboxes}`,
      });
    }
  }
  if (isCap(limits.maxHourlySpendUsd)) {
    const projected = usage.hourlySpendUsd + delta.hourlySpendUsd;
    // Guard against floating-point noise pushing an exactly-at-cap value over.
    if (projected > limits.maxHourlySpendUsd + 1e-9) {
      violations.push({
        scope,
        limit: 'maxHourlySpendUsd',
        allowed: limits.maxHourlySpendUsd,
        projected,
        message: `${scope} hourly spend cap reached: $${projected.toFixed(2)}/hr > $${limits.maxHourlySpendUsd.toFixed(2)}/hr`,
      });
    }
  }
  return violations;
}

/** Thrown when a sandbox creation would breach one or more quota limits. */
export class QuotaExceededError extends Error {
  readonly violations: readonly QuotaViolation[];
  constructor(violations: readonly QuotaViolation[]) {
    super(`quota exceeded: ${violations.map((v) => v.message).join('; ')}`);
    this.name = 'QuotaExceededError';
    this.violations = violations;
  }
}
