/**
 * Quotas: pure org/project cap evaluation applied at sandbox-creation time.
 */
export type { QuotaScope, QuotaLimits, QuotaUsage, QuotaDelta, QuotaViolation } from './quota.js';
export { QuotaExceededError, evaluateQuota } from './quota.js';
