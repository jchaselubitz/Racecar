/**
 * Bounded, redacted log artifacts captured before cleanup.
 *
 * When reconciliation is about to delete an orphaned sandbox or halt a stuck
 * run, whatever the agent left in its logs is the only forensic record of why.
 * Deleting the sandbox destroys it. So before cleanup we pull a copy of the run
 * logs out to the control plane — but two constraints govern that copy:
 *
 *  - **Bounded.** A runaway agent can emit gigabytes. We tail a fixed byte
 *    budget inside the sandbox (cheap transfer) and enforce the same ceiling
 *    again in the control plane (the hard guarantee).
 *  - **Redacted.** Injected credentials can land in a log line. The captured
 *    text is run through the same {@link Redactor} as every other output, so a
 *    persisted artifact can never contain a secret verbatim.
 *
 * The provider exec and disk write live in the executor; this module owns the
 * capture *script* and the pure bound-then-redact transform, so both are testable
 * without a sandbox.
 */
import type { Redactor } from '../credentials/redaction.js';

/** Default ceiling on a captured log artifact (64 KiB). */
export const DEFAULT_LOG_ARTIFACT_MAX_BYTES = 64 * 1024;

/** A captured, bounded, redacted log artifact ready to persist. */
export interface LogArtifact {
  readonly sandboxId: string;
  /** ISO-8601 capture time. */
  readonly capturedAt: string;
  /** Byte length of {@link content}. */
  readonly bytes: number;
  /** Whether the source exceeded the budget and was truncated to the tail. */
  readonly truncated: boolean;
  /** The bounded, redacted log text. */
  readonly content: string;
}

/**
 * Shell script that emits the tail of every run log in the sandbox, each under a
 * header, bounded to `maxBytes` per file so the transfer stays small. Prints
 * nothing (exit 0) when no logs exist. The control plane re-bounds the total, so
 * this is a transfer optimization, not the guarantee.
 */
export function captureLogsScript(maxBytes: number = DEFAULT_LOG_ARTIFACT_MAX_BYTES): string {
  const budget = Math.max(1, Math.floor(maxBytes));
  return [
    'set -u',
    'B="$HOME/.racecar/runs"',
    '[ -d "$B" ] || exit 0',
    'for f in "$B"/*.log; do',
    '  [ -e "$f" ] || continue',
    `  printf '===== %s =====\\n' "$(basename "$f")"`,
    `  tail -c ${budget} "$f" 2>/dev/null`,
    `  printf '\\n'`,
    'done',
  ].join('\n');
}

/** Options for {@link buildLogArtifact}. */
export interface BuildLogArtifactOptions {
  /** Redactor applied to the captured text. Omitted means no redaction. */
  readonly redactor?: Redactor;
  /** Byte ceiling on the result. Default {@link DEFAULT_LOG_ARTIFACT_MAX_BYTES}. */
  readonly maxBytes?: number;
  /** Clock, injected for deterministic timestamps in tests. */
  readonly now?: () => Date;
}

/**
 * Turn raw captured log text into a {@link LogArtifact}: redact first (so a
 * secret can never survive the subsequent trim), then bound to the byte budget,
 * keeping the tail — the most recent output, where a failure's cause is. The
 * result is safe to write to disk.
 */
export function buildLogArtifact(
  sandboxId: string,
  raw: string,
  options: BuildLogArtifactOptions = {},
): LogArtifact {
  const maxBytes = Math.max(0, options.maxBytes ?? DEFAULT_LOG_ARTIFACT_MAX_BYTES);
  const now = options.now ?? (() => new Date());
  // Redact before bounding: bounding after guarantees no partial secret can be
  // left behind by a cut that lands inside a token.
  const redacted = options.redactor !== undefined ? options.redactor.redact(raw) : raw;
  const encoded = Buffer.from(redacted, 'utf8');
  const truncated = encoded.length > maxBytes;
  const content = truncated
    ? Buffer.from(encoded.subarray(encoded.length - maxBytes)).toString('utf8')
    : redacted;
  return {
    sandboxId,
    capturedAt: now().toISOString(),
    bytes: Buffer.byteLength(content, 'utf8'),
    truncated,
    content,
  };
}
