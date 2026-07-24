/**
 * `racecar setup` — one-shot, guided credential provisioning.
 *
 * For each known credential the command first tries an environment variable
 * (`CLAUDE_CODE_OAUTH_TOKEN`, and `GH_AUTH_TOKEN`/`GH_USERNAME` for GitHub); when
 * one is present it is stored non-interactively. A credential already in the
 * store is left untouched. Anything still missing is requested from the operator
 * step by step. It closes by running `auth list` so the final state is visible.
 *
 * Secrets entered interactively are masked at the prompt and registered with the
 * output redactor before any fingerprint is printed, so a token never lands in a
 * terminal echo, log, or error.
 */
import { createInterface } from 'node:readline';
import {
  claudeCredential,
  CLAUDE_OAUTH_ENV,
  DEFAULT_GIT_HOST,
  DEFAULT_GIT_USERNAME,
  gitCredential,
  GH_AUTH_TOKEN_ENV,
  GH_USERNAME_ENV,
  Redactor,
  secretFingerprint,
  type CredentialStore,
  type StoredCredential,
} from '@racecar/core';
import type { ParsedArgs } from './index.js';
import { installOutputRedaction, openCredentialStore } from './credentials.js';
import { authList } from './auth.js';

/** Ask the operator a question; `secret` mutes the terminal echo of the answer. */
export type PromptFn = (question: string, options?: { secret?: boolean }) => Promise<string>;

/** Injectable seams so the setup flow can run under test without real IO. */
export interface SetupIo {
  readonly env: NodeJS.ProcessEnv;
  readonly store: CredentialStore;
  readonly prompt: PromptFn;
  readonly write: (text: string) => void;
  /** Register freshly gathered secrets with the process-wide output redactor. */
  readonly redact: (secrets: readonly string[]) => void;
}

/** One credential the setup flow knows how to source from env or a prompt. */
interface SetupStep {
  /** Store key, matching the names `auth list` prints. */
  readonly name: string;
  /** Human label for the prompts and status lines. */
  readonly label: string;
  /** Build the credential from environment variables, or `undefined` if unset. */
  readonly fromEnv: (env: NodeJS.ProcessEnv) => StoredCredential | undefined;
  /** Interactively gather the credential, or `undefined` if the operator skips. */
  readonly fromPrompt: (prompt: PromptFn) => Promise<StoredCredential | undefined>;
}

const STEPS: readonly SetupStep[] = [
  {
    name: 'claude',
    label: 'Claude Code OAuth token',
    fromEnv: (env) => {
      const token = env[CLAUDE_OAUTH_ENV]?.trim();
      return token !== undefined && token.length > 0
        ? claudeCredential({ oauthToken: token })
        : undefined;
    },
    fromPrompt: async (prompt) => {
      const token = (
        await prompt(`${CLAUDE_OAUTH_ENV} (leave blank to skip): `, { secret: true })
      ).trim();
      return token.length > 0 ? claudeCredential({ oauthToken: token }) : undefined;
    },
  },
  {
    name: 'git',
    label: 'GitHub credential',
    fromEnv: (env) => {
      const token = env[GH_AUTH_TOKEN_ENV]?.trim();
      if (token === undefined || token.length === 0) return undefined;
      const username = env[GH_USERNAME_ENV]?.trim();
      return gitCredential({
        token,
        host: DEFAULT_GIT_HOST,
        username: username !== undefined && username.length > 0 ? username : DEFAULT_GIT_USERNAME,
      });
    },
    fromPrompt: async (prompt) => {
      const token = (
        await prompt(`${GH_AUTH_TOKEN_ENV} (leave blank to skip): `, { secret: true })
      ).trim();
      if (token.length === 0) return undefined;
      const username = (await prompt(`${GH_USERNAME_ENV} [${DEFAULT_GIT_USERNAME}]: `)).trim();
      return gitCredential({
        token,
        host: DEFAULT_GIT_HOST,
        username: username.length > 0 ? username : DEFAULT_GIT_USERNAME,
      });
    },
  },
];

/** Fingerprint of a credential's first secret, for a non-reversible status line. */
function fingerprintOf(credential: StoredCredential): string {
  const secret = Object.values(credential.secrets)[0];
  return secret === undefined ? 'unknown' : secretFingerprint(secret);
}

/**
 * Drive the setup flow over injectable IO. Env-provided credentials are stored
 * outright (overwriting a stale copy); an already-stored credential with no env
 * value is kept as-is; anything still missing is prompted for.
 */
export async function runSetup(io: SetupIo): Promise<void> {
  const existing = await io.store.load();
  for (const step of STEPS) {
    const fromEnv = step.fromEnv(io.env);
    if (fromEnv !== undefined) {
      io.redact(Object.values(fromEnv.secrets));
      await io.store.set(step.name, fromEnv);
      io.write(`✓ ${step.label}: set from environment (fingerprint ${fingerprintOf(fromEnv)})\n`);
      continue;
    }
    const present = existing[step.name];
    if (present !== undefined) {
      io.write(`✓ ${step.label}: already stored (fingerprint ${fingerprintOf(present)})\n`);
      continue;
    }
    const provided = await step.fromPrompt(io.prompt);
    if (provided === undefined) {
      io.write(`– ${step.label}: skipped\n`);
      continue;
    }
    io.redact(Object.values(provided.secrets));
    await io.store.set(step.name, provided);
    io.write(`✓ ${step.label}: stored (fingerprint ${fingerprintOf(provided)})\n`);
  }
  io.write('\nStored credentials:\n');
  await authList();
}

/**
 * Read one line from stdin. When `secret` is set the keystroke echo is muted so
 * a pasted token never appears on screen. Falls back to a plain read when stdin
 * is not a TTY (a value piped in for automation).
 */
function promptStdin(question: string, options?: { secret?: boolean }): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (options?.secret === true) {
      // Mute the readline echo: write the question ourselves, then swallow the
      // per-keystroke redraws so the typed token is never rendered.
      process.stdout.write(question);
      (rl as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = () => {};
      rl.question('', (answer) => {
        process.stdout.write('\n');
        rl.close();
        resolve(answer);
      });
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
    rl.on('error', reject);
  });
}

/** `racecar setup` entry point: wire the default IO and run the guided flow. */
export async function setup(_parsed: ParsedArgs): Promise<void> {
  await runSetup({
    env: process.env,
    store: openCredentialStore(),
    prompt: promptStdin,
    write: (text) => process.stdout.write(text),
    redact: (secrets) => installOutputRedaction(new Redactor(secrets)),
  });
}
