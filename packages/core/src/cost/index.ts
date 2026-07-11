/**
 * Cost model: named resource classes and the estimated-spend arithmetic that
 * `racecar ps` and the quota evaluator build on.
 */
export type { ResourceSpec, ResourceClass, ResourceClassName, ResourcePricing } from './cost.js';
export {
  DEFAULT_RESOURCE_PRICING,
  DEFAULT_RESOURCE_CLASS_NAME,
  RESOURCE_CLASS_NAMES,
  RESOURCE_CLASSES,
  buildResourceClasses,
  estimateSpendUsd,
  formatUsd,
  hourlyUsdForSpec,
  resolveResourceClass,
} from './cost.js';
