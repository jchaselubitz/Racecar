/**
 * Credential redaction.
 *
 * Injected credentials can surface in places Racecar prints: a failed `git
 * clone` echoing a URL, a snapshot build log, an error message quoting a
 * command. The {@link Redactor} holds the set of known secret values and
 * replaces every occurrence with a fixed mask, so a stored token can never be
 * written to a terminal or a log file verbatim.
 *
 * Redaction is plain substring replacement (not regex), longest-secret-first so
 * a secret that contains another is masked before its substring is. Very short
 * secrets are ignored: masking a 2-character value would corrupt unrelated
 * output for no security benefit.
 */

/** The text substituted for any secret value. */
export const REDACTION_MASK = '«redacted»';

/** Secrets shorter than this are not redacted (too noisy, negligible value). */
const MIN_SECRET_LENGTH = 6;

/**
 * Replaces known secret values in arbitrary text. Construct it once from the
 * credential store's secrets and run all output through {@link redact}.
 */
export class Redactor {
  private readonly secrets: readonly string[];
  private readonly mask: string;

  constructor(secrets: Iterable<string>, mask: string = REDACTION_MASK) {
    this.mask = mask;
    this.secrets = [...new Set(secrets)]
      .filter((secret) => secret.length >= MIN_SECRET_LENGTH)
      .sort((a, b) => b.length - a.length);
  }

  /** Number of distinct secrets this redactor will mask. */
  get size(): number {
    return this.secrets.length;
  }

  /** Return `text` with every known secret replaced by the mask. */
  redact(text: string): string {
    let result = text;
    for (const secret of this.secrets) {
      if (result.includes(secret)) {
        result = result.split(secret).join(this.mask);
      }
    }
    return result;
  }
}
