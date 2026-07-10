/**
 * Output plane for the CLI: one switch between human-readable text and a
 * machine-readable NDJSON event stream (`--json`).
 *
 * Every command reports through {@link report} (or {@link emitEvent}), so a
 * single global flag makes the whole CLI drivable by another program: in JSON
 * mode each call writes one newline-delimited JSON object to stdout with a
 * timestamp and event `type`; in text mode it writes the human line instead.
 * Both go through the stdout write path, so the credential redactor still
 * scrubs any secret before it leaves the process.
 */

let jsonMode = false;

/** Enable or disable NDJSON event output. Called once at startup from `--json`. */
export function configureOutput(json: boolean): void {
  jsonMode = json;
}

/** Whether the CLI is emitting an NDJSON event stream. */
export function isJsonMode(): boolean {
  return jsonMode;
}

/** Write one NDJSON event (JSON mode only; a no-op in text mode). */
export function emitEvent(type: string, data: Record<string, unknown> = {}): void {
  if (!jsonMode) return;
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), type, ...data })}\n`);
}

/** Write a human line (text mode only; a no-op in JSON mode). */
export function emitLine(text: string): void {
  if (jsonMode) return;
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

/**
 * Report an outcome both ways: an NDJSON event in JSON mode, the human line in
 * text mode. Commands use this for their primary output so `--json` needs no
 * per-command branching.
 */
export function report(type: string, data: Record<string, unknown>, human: string): void {
  if (jsonMode) emitEvent(type, data);
  else emitLine(human);
}

/**
 * Emit a warning: always a human line on stderr (so it never pollutes the
 * NDJSON stream on stdout), plus an `alert` event on stdout in JSON mode.
 */
export function warn(type: string, data: Record<string, unknown>, human: string): void {
  process.stderr.write(human.endsWith('\n') ? human : `${human}\n`);
  if (jsonMode) emitEvent('alert', { alert: type, ...data });
}
