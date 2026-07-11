/**
 * Cost model: resource classes and estimated spend.
 *
 * A sandbox's *resource class* names the compute it is sized for — how many
 * vCPUs, how much memory, and how much disk. Racecar keeps no billing feed, so
 * spend is *estimated*: a class carries a modeled hourly rate, and a sandbox's
 * estimated spend is that rate multiplied by how long the sandbox has existed.
 * This is deliberately an over-estimate ceiling (it bills the whole lifetime,
 * not just running minutes), so `racecar ps` surfaces "no surprise spend"
 * before the provider invoice does, never after.
 *
 * The default per-resource prices below are list-price *estimates*, not a
 * contract with any provider; {@link buildResourceClasses} takes a pricing
 * table so an operator (or a test) can substitute their own quote.
 */

/** The compute a resource class provisions. Memory and disk are in GiB. */
export interface ResourceSpec {
  readonly cpu: number;
  readonly memoryGiB: number;
  readonly diskGiB: number;
}

/** A named sandbox size with a modeled hourly rate. */
export interface ResourceClass {
  readonly name: string;
  readonly spec: ResourceSpec;
  /** Modeled cost per hour the sandbox exists, in USD. */
  readonly hourlyUsd: number;
}

/** Per-resource hourly prices used to model a class's {@link ResourceClass.hourlyUsd}. */
export interface ResourcePricing {
  readonly cpuHourUsd: number;
  readonly memoryGiBHourUsd: number;
  readonly diskGiBHourUsd: number;
}

/**
 * Default per-resource prices. These are list-price *estimates* for a
 * container-class sandbox, chosen to be roughly right rather than exactly any
 * provider's bill; override them via {@link buildResourceClasses} when a real
 * quote is known.
 */
export const DEFAULT_RESOURCE_PRICING: ResourcePricing = {
  cpuHourUsd: 0.05,
  memoryGiBHourUsd: 0.005,
  diskGiBHourUsd: 0.0004,
};

/** The specs of the named classes, before pricing is applied. */
const RESOURCE_SPECS = {
  small: { cpu: 1, memoryGiB: 1, diskGiB: 3 },
  standard: { cpu: 2, memoryGiB: 4, diskGiB: 10 },
  large: { cpu: 4, memoryGiB: 8, diskGiB: 20 },
} as const satisfies Record<string, ResourceSpec>;

/** The name every sandbox is sized as when none is requested. */
export const DEFAULT_RESOURCE_CLASS_NAME = 'standard';

/** The names of the built-in resource classes, in ascending size. */
export const RESOURCE_CLASS_NAMES = ['small', 'standard', 'large'] as const;

/** A built-in resource-class name. */
export type ResourceClassName = (typeof RESOURCE_CLASS_NAMES)[number];

/** Compute a spec's modeled hourly rate under a pricing table. */
export function hourlyUsdForSpec(spec: ResourceSpec, pricing: ResourcePricing): number {
  return (
    spec.cpu * pricing.cpuHourUsd +
    spec.memoryGiB * pricing.memoryGiBHourUsd +
    spec.diskGiB * pricing.diskGiBHourUsd
  );
}

/** Build the named resource classes under a given pricing table. */
export function buildResourceClasses(
  pricing: ResourcePricing = DEFAULT_RESOURCE_PRICING,
): Record<ResourceClassName, ResourceClass> {
  const entries = RESOURCE_CLASS_NAMES.map((name): [ResourceClassName, ResourceClass] => {
    const spec = RESOURCE_SPECS[name];
    return [name, { name, spec, hourlyUsd: hourlyUsdForSpec(spec, pricing) }];
  });
  return Object.fromEntries(entries) as Record<ResourceClassName, ResourceClass>;
}

/** The built-in resource classes priced at {@link DEFAULT_RESOURCE_PRICING}. */
export const RESOURCE_CLASSES = buildResourceClasses();

/**
 * Resolve a resource-class name to its {@link ResourceClass}. An undefined name
 * selects the default class; an unrecognized name throws so a typo fails at the
 * CLI rather than silently sizing a sandbox wrong.
 */
export function resolveResourceClass(
  name?: string,
  classes: Record<string, ResourceClass> = RESOURCE_CLASSES,
): ResourceClass {
  const key = name ?? DEFAULT_RESOURCE_CLASS_NAME;
  const resolved = classes[key];
  if (resolved === undefined) {
    throw new Error(
      `unknown resource class '${key}'; choose one of ${Object.keys(classes).join(', ')}`,
    );
  }
  return resolved;
}

/**
 * Estimate the spend accrued by a resource running at `hourlyUsd` since
 * `sinceIso`. Returns 0 for a missing/unparseable timestamp or a clock that has
 * run backwards, so a bad label never produces a negative or NaN estimate.
 */
export function estimateSpendUsd(hourlyUsd: number, sinceIso: string | undefined, now: Date): number {
  if (sinceIso === undefined) return 0;
  const since = Date.parse(sinceIso);
  if (Number.isNaN(since)) return 0;
  const hours = (now.getTime() - since) / 3_600_000;
  if (!Number.isFinite(hours) || hours <= 0) return 0;
  return hourlyUsd * hours;
}

/** Format a USD amount for display, e.g. `0.42` → `"$0.42"`. */
export function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}
