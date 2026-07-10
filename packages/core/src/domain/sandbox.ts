import { decodeSandboxLabels } from '../labels/schema.js';
import type { ProviderSandbox, SandboxRuntimeState } from '../provider/provider.js';

/**
 * The control-plane view of a Sandbox: a provider sandbox descriptor fused with
 * the identity decoded from its self-describing labels. This is what `racecar
 * ps` renders and what lifecycle policy acts on.
 */
export interface Sandbox {
  /** Provider-assigned sandbox id. */
  readonly id: string;
  /** Normalized runtime state. */
  readonly state: SandboxRuntimeState;
  /** Project the sandbox belongs to (from labels). */
  readonly project: string;
  /** Mission the sandbox was created for (from labels). */
  readonly mission: string;
  /** Git branch checked out in the sandbox (from labels). */
  readonly branch: string;
  /** Snapshot the sandbox was created from (from labels). */
  readonly snapshot: string;
  /** ISO-8601 creation timestamp (from labels). */
  readonly createdAt: string;
  /** ISO-8601 timestamp of the sandbox's last activity, if reported. */
  readonly lastActivityAt?: string;
  /** Full provider label map, for callers that need the raw values. */
  readonly labels: Record<string, string>;
}

/**
 * Build the control-plane {@link Sandbox} from a provider descriptor by decoding
 * its labels. Returns `null` when the sandbox is not Racecar-managed (or its
 * labels are incomplete), so listings can filter out unrelated sandboxes.
 */
export function toSandbox(provider: ProviderSandbox): Sandbox | null {
  const meta = decodeSandboxLabels(provider.labels);
  if (meta === null) {
    return null;
  }
  return {
    id: provider.id,
    state: provider.state,
    project: meta.project,
    mission: meta.mission,
    branch: meta.branch,
    snapshot: meta.snapshot,
    createdAt: meta.createdAt,
    ...(provider.lastActivityAt !== undefined ? { lastActivityAt: provider.lastActivityAt } : {}),
    labels: provider.labels,
  };
}

/**
 * Decode a list of provider sandboxes into control-plane sandboxes, dropping
 * any that are not Racecar-managed.
 */
export function toSandboxes(providers: readonly ProviderSandbox[]): Sandbox[] {
  const result: Sandbox[] = [];
  for (const provider of providers) {
    const sandbox = toSandbox(provider);
    if (sandbox !== null) {
      result.push(sandbox);
    }
  }
  return result;
}

/** States in which a sandbox counts against the per-project concurrency cap. */
const ACTIVE_STATES: readonly SandboxRuntimeState[] = [
  'starting',
  'started',
  'stopping',
  'stopped',
];

/** Whether a sandbox counts as "live" for the per-project concurrency cap. */
export function countsAgainstConcurrencyCap(sandbox: Sandbox): boolean {
  return ACTIVE_STATES.includes(sandbox.state);
}
