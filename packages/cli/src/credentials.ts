/**
 * CLI-side credential plumbing: where the store lives, how output redaction is
 * installed, and how stored credentials are turned into sandbox injection.
 *
 * The store is machine-global (`~/.racecar`), not per-repository — a Claude
 * token or git credential is a property of the operator, reused across every
 * project. `RACECAR_HOME` overrides the location; `RACECAR_MASTER_KEY` overrides
 * the encryption key (useful for CI, where writing a key file is undesirable).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  buildCredentialInjection,
  CredentialStore,
  parseMasterKey,
  Redactor,
  type CredentialInjection,
} from '@racecar/core';

/** Directory holding the encrypted credential store and its master key. */
export function racecarHome(): string {
  const override = process.env.RACECAR_HOME;
  if (override !== undefined && override.length > 0) return override;
  return join(homedir(), '.racecar');
}

/** Open the machine-global credential store, honoring `RACECAR_MASTER_KEY`. */
export function openCredentialStore(): CredentialStore {
  const keyEnv = process.env.RACECAR_MASTER_KEY;
  return new CredentialStore({
    dir: racecarHome(),
    ...(keyEnv !== undefined && keyEnv.length > 0 ? { masterKey: parseMasterKey(keyEnv) } : {}),
  });
}

/**
 * Build the credential injection for a new sandbox. Best-effort: a missing or
 * unreadable store yields empty injection rather than blocking sandbox
 * creation, so an operator who has not run `racecar auth` can still work with
 * public repos.
 */
export async function loadCredentialInjection(): Promise<CredentialInjection> {
  try {
    return buildCredentialInjection(await openCredentialStore().load());
  } catch {
    return { env: {}, setupCommands: [] };
  }
}

/**
 * Wrap `process.stdout`/`process.stderr` so every write passes through the
 * redactor first. Installed once at startup from the store's secrets, this is
 * the backstop that keeps a stored token out of any command echo, error, or
 * build log the CLI emits.
 */
export function installOutputRedaction(redactor: Redactor): void {
  if (redactor.size === 0) return;
  wrapStream(process.stdout, redactor);
  wrapStream(process.stderr, redactor);
}

/** Best-effort redaction setup from the current store; never throws. */
export async function installStoredSecretRedaction(): Promise<void> {
  try {
    const secrets = await openCredentialStore().secrets();
    if (secrets.length > 0) installOutputRedaction(new Redactor(secrets));
  } catch {
    // A missing key or unreadable store simply means nothing to redact.
  }
}

function wrapStream(stream: NodeJS.WriteStream, redactor: Redactor): void {
  const original = stream.write.bind(stream);
  stream.write = (
    chunk: unknown,
    encoding?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean => {
    const redacted =
      typeof chunk === 'string'
        ? redactor.redact(chunk)
        : Buffer.isBuffer(chunk)
          ? redactor.redact(chunk.toString('utf8'))
          : String(chunk);
    if (typeof encoding === 'function') {
      return original(redacted, encoding);
    }
    return original(redacted, encoding, callback);
  };
}
