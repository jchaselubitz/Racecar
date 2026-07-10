/**
 * The self-describing-sandbox label schema.
 *
 * Racecar keeps no external database of what a sandbox is for. Instead every
 * managed sandbox carries its identity in provider labels, so the control
 * plane can reconstruct the full picture — which project, mission, branch, and
 * snapshot a sandbox belongs to — from a label listing alone. This module owns
 * the key namespace, the encode/decode functions, and validation against the
 * provider's label limits.
 */

/** Prefix every Racecar-owned label key shares. */
export const LABEL_NAMESPACE = 'racecar';

/** Schema version stamped on each sandbox, so future changes stay decodable. */
export const LABEL_SCHEMA_VERSION = '1';

/**
 * Conservative label limits with headroom under what Stage 0 measured Daytona
 * to allow. Encoding validates against these so we fail in the control plane
 * rather than at the provider API.
 */
export const LABEL_LIMITS = {
  maxKeys: 32,
  maxKeyLength: 63,
  maxValueLength: 255,
} as const;

/** Canonical Racecar label keys. */
export const SandboxLabelKeys = {
  /** Marker identifying a sandbox as Racecar-managed. Always `"true"`. */
  managed: `${LABEL_NAMESPACE}.managed`,
  /** Schema version this sandbox's labels were written with. */
  schemaVersion: `${LABEL_NAMESPACE}.schema`,
  /** Project the sandbox belongs to. */
  project: `${LABEL_NAMESPACE}.project`,
  /** Mission the sandbox was created for. */
  mission: `${LABEL_NAMESPACE}.mission`,
  /** Git branch checked out in the sandbox. */
  branch: `${LABEL_NAMESPACE}.branch`,
  /** Snapshot the sandbox was created from. */
  snapshot: `${LABEL_NAMESPACE}.snapshot`,
  /** Role of the sandbox (e.g. a mission workspace vs. a snapshot-build box). */
  role: `${LABEL_NAMESPACE}.role`,
  /** ISO-8601 creation timestamp, so listings need no extra provider call. */
  createdAt: `${LABEL_NAMESPACE}.created-at`,
  /** Identifier of whoever created the sandbox (user or automation). */
  createdBy: `${LABEL_NAMESPACE}.created-by`,
} as const;

/** Well-known sandbox roles; `role` is left open for future kinds. */
export type SandboxRole = 'mission' | 'snapshot-build';

/**
 * The identity carried by a Racecar-managed sandbox. This is the decoded,
 * structured form of the label map.
 */
export interface SandboxMetadata {
  readonly project: string;
  readonly mission: string;
  readonly branch: string;
  readonly snapshot: string;
  readonly createdAt: string;
  /** Sandbox role; typically one of {@link SandboxRole}, but left open. */
  readonly role?: string;
  readonly createdBy?: string;
}

/** A single problem found while validating a label map. */
export interface LabelValidationIssue {
  readonly key: string;
  readonly message: string;
}

/**
 * Validate a label map against the provider limits. Returns every issue found
 * (empty array means valid) rather than throwing, so callers can surface all
 * problems at once.
 */
export function validateLabels(labels: Record<string, string>): LabelValidationIssue[] {
  const issues: LabelValidationIssue[] = [];
  const keys = Object.keys(labels);
  if (keys.length > LABEL_LIMITS.maxKeys) {
    issues.push({
      key: '*',
      message: `too many labels: ${keys.length} > ${LABEL_LIMITS.maxKeys}`,
    });
  }
  for (const key of keys) {
    if (key.length === 0) {
      issues.push({ key, message: 'label key must not be empty' });
    }
    if (key.length > LABEL_LIMITS.maxKeyLength) {
      issues.push({
        key,
        message: `label key too long: ${key.length} > ${LABEL_LIMITS.maxKeyLength}`,
      });
    }
    const value = labels[key] ?? '';
    if (value.length > LABEL_LIMITS.maxValueLength) {
      issues.push({
        key,
        message: `label value too long: ${value.length} > ${LABEL_LIMITS.maxValueLength}`,
      });
    }
  }
  return issues;
}

/** Thrown by {@link encodeSandboxLabels} when the resulting labels are invalid. */
export class LabelValidationError extends Error {
  readonly issues: readonly LabelValidationIssue[];
  constructor(issues: readonly LabelValidationIssue[]) {
    super(`invalid sandbox labels: ${issues.map((i) => `${i.key}: ${i.message}`).join('; ')}`);
    this.name = 'LabelValidationError';
    this.issues = issues;
  }
}

/**
 * Encode sandbox metadata into the provider label map, stamping the managed
 * marker and schema version. Validates the result and throws
 * {@link LabelValidationError} if it exceeds the provider limits.
 */
export function encodeSandboxLabels(meta: SandboxMetadata): Record<string, string> {
  const labels: Record<string, string> = {
    [SandboxLabelKeys.managed]: 'true',
    [SandboxLabelKeys.schemaVersion]: LABEL_SCHEMA_VERSION,
    [SandboxLabelKeys.project]: meta.project,
    [SandboxLabelKeys.mission]: meta.mission,
    [SandboxLabelKeys.branch]: meta.branch,
    [SandboxLabelKeys.snapshot]: meta.snapshot,
    [SandboxLabelKeys.createdAt]: meta.createdAt,
  };
  if (meta.role !== undefined) {
    labels[SandboxLabelKeys.role] = meta.role;
  }
  if (meta.createdBy !== undefined) {
    labels[SandboxLabelKeys.createdBy] = meta.createdBy;
  }
  const issues = validateLabels(labels);
  if (issues.length > 0) {
    throw new LabelValidationError(issues);
  }
  return labels;
}

/** Whether a label map identifies a Racecar-managed sandbox. */
export function isRacecarManaged(labels: Record<string, string>): boolean {
  return labels[SandboxLabelKeys.managed] === 'true';
}

/**
 * Decode a provider label map back into {@link SandboxMetadata}. Returns `null`
 * for sandboxes not managed by Racecar or missing any required field, so
 * unrelated sandboxes in the same org are simply skipped rather than throwing.
 */
export function decodeSandboxLabels(labels: Record<string, string>): SandboxMetadata | null {
  if (!isRacecarManaged(labels)) {
    return null;
  }
  const project = labels[SandboxLabelKeys.project];
  const mission = labels[SandboxLabelKeys.mission];
  const branch = labels[SandboxLabelKeys.branch];
  const snapshot = labels[SandboxLabelKeys.snapshot];
  const createdAt = labels[SandboxLabelKeys.createdAt];
  if (
    project === undefined ||
    mission === undefined ||
    branch === undefined ||
    snapshot === undefined ||
    createdAt === undefined
  ) {
    return null;
  }
  const role = labels[SandboxLabelKeys.role];
  const createdBy = labels[SandboxLabelKeys.createdBy];
  return {
    project,
    mission,
    branch,
    snapshot,
    createdAt,
    ...(role !== undefined ? { role } : {}),
    ...(createdBy !== undefined ? { createdBy } : {}),
  };
}

/**
 * Build a label selector that matches Racecar-managed sandboxes, optionally
 * narrowed to a project and/or mission. Pass the result to the provider's
 * label-filtered listing so only relevant sandboxes come back.
 */
export function sandboxLabelSelector(filter?: {
  project?: string;
  mission?: string;
}): Record<string, string> {
  const selector: Record<string, string> = { [SandboxLabelKeys.managed]: 'true' };
  if (filter?.project !== undefined) {
    selector[SandboxLabelKeys.project] = filter.project;
  }
  if (filter?.mission !== undefined) {
    selector[SandboxLabelKeys.mission] = filter.mission;
  }
  return selector;
}
