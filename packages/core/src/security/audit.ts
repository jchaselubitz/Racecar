/**
 * Auditing what a managed sandbox exposes in its provider labels.
 *
 * Racecar's security posture draws a hard line: secrets live *inside* the
 * sandbox (env vars and `0600` files materialized from them) and never in a
 * label. Labels are non-secret routing/identity fields, readable by anyone with
 * provider access. This module is the automated check behind the stage exit
 * criterion "no leaked credentials in any log or label" — it inspects a
 * sandbox's label map and flags two things:
 *
 *  - **leaks** (severity `leak`): a stored secret value appearing verbatim in a
 *    label key or value. This is the criterion violation and fails the audit.
 *  - **unexpected keys** (severity `warning`): labels outside the Racecar
 *    namespace. Not necessarily a leak — the provider or another tool may set
 *    its own labels — but surfaced so an operator can confirm nothing sensitive
 *    rode in on one.
 *
 * The functions are pure over an explicit label map and secret list, so the same
 * logic is unit-tested and reused by `racecar audit` over a live label listing.
 */

/** Prefix every Racecar-owned label key shares. Mirrors the label schema. */
const RACECAR_LABEL_PREFIX = 'racecar.';

/** Severity of an audit finding. `leak` fails the audit; `warning` informs. */
export type AuditSeverity = 'leak' | 'warning';

/** A single problem found while auditing one sandbox's labels. */
export interface LabelAuditFinding {
  readonly severity: AuditSeverity;
  /** The offending label key, or `'*'` for a whole-map finding. */
  readonly key: string;
  readonly message: string;
}

/** Outcome of auditing one sandbox's labels. */
export interface SandboxLabelAudit {
  readonly sandboxId: string;
  readonly findings: readonly LabelAuditFinding[];
  /** True when no `leak`-severity finding was raised. */
  readonly ok: boolean;
}

/**
 * Audit one sandbox's label map for leaked secrets and unexpected keys.
 *
 * `secrets` is the operator's stored secret values (from the credential store).
 * Empty secrets are ignored so an empty store never produces spurious matches.
 * A finding is raised per secret found in any label key or value; the raw secret
 * is never included in the message (only the key that carried it), so the audit
 * output itself cannot leak.
 */
export function auditSandboxLabels(
  sandboxId: string,
  labels: Record<string, string>,
  secrets: readonly string[],
): SandboxLabelAudit {
  const findings: LabelAuditFinding[] = [];
  const meaningfulSecrets = secrets.filter((secret) => secret.length > 0);

  for (const [key, value] of Object.entries(labels)) {
    for (const secret of meaningfulSecrets) {
      if (key.includes(secret)) {
        findings.push({
          severity: 'leak',
          key,
          message: `a stored secret value appears in the label key '${key}'`,
        });
        break;
      }
    }
    for (const secret of meaningfulSecrets) {
      if (value.includes(secret)) {
        findings.push({
          severity: 'leak',
          key,
          message: `a stored secret value appears in the value of label '${key}'`,
        });
        break;
      }
    }
    if (!key.startsWith(RACECAR_LABEL_PREFIX)) {
      findings.push({
        severity: 'warning',
        key,
        message: `label '${key}' is outside the racecar.* namespace; confirm it carries nothing sensitive`,
      });
    }
  }

  return { sandboxId, findings, ok: !findings.some((finding) => finding.severity === 'leak') };
}
