/**
 * `racecar auth` — manage the local encrypted credential store.
 *
 *   racecar auth claude [--token <t>] [--stdin]
 *   racecar auth git    [--host <h>] [--username <u>] [--token <t>] [--stdin]
 *   racecar auth list
 *   racecar auth rm <name>
 *
 * `auth claude` wraps `claude setup-token`: with no `--token`/`--stdin` it runs
 * the interactive OAuth flow and captures the printed token. Stored secrets are
 * never echoed back — commands confirm with a non-reversible fingerprint only.
 */
import { spawn } from 'node:child_process';
import {
  claudeCredential,
  DEFAULT_GIT_HOST,
  DEFAULT_GIT_USERNAME,
  extractClaudeToken,
  gitCredential,
  secretFingerprint,
} from '@racecar/core';
import { option, readStdin, type ParsedArgs } from './index.js';
import { openCredentialStore } from './credentials.js';

/** Run `claude setup-token` interactively and return the captured token. */
async function runClaudeSetupToken(): Promise<string> {
  const output = await new Promise<string>((resolvePromise, rejectPromise) => {
    // Inherit stdin/stderr so the OAuth prompts remain interactive; capture
    // stdout, where `claude setup-token` prints the final token.
    const child = spawn('claude', ['setup-token'], { stdio: ['inherit', 'pipe', 'inherit'] });
    let captured = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      captured += chunk;
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        rejectPromise(
          new Error("could not run 'claude setup-token'; install the Claude CLI or pass --token"),
        );
        return;
      }
      rejectPromise(error);
    });
    child.on('close', (code) => {
      if (code === 0) resolvePromise(captured);
      else rejectPromise(new Error(`'claude setup-token' exited with code ${code ?? 'null'}`));
    });
  });
  const token = extractClaudeToken(output);
  if (token === undefined) {
    throw new Error("no token found in 'claude setup-token' output; pass --token instead");
  }
  return token;
}

/** Resolve a secret from `--token`, stdin, or a fallback interactive source. */
async function resolveSecret(
  parsed: ParsedArgs,
  interactive: () => Promise<string>,
): Promise<string> {
  const flag = option(parsed, 'token');
  if (flag !== undefined) return flag.trim();
  if (parsed.options.has('stdin') || process.stdin.isTTY !== true) {
    const piped = (await readStdin()).trim();
    if (piped.length === 0) throw new Error('no token provided on stdin');
    return piped;
  }
  return interactive();
}

async function authClaude(parsed: ParsedArgs): Promise<void> {
  const token = await resolveSecret(parsed, runClaudeSetupToken);
  await openCredentialStore().set('claude', claudeCredential({ oauthToken: token }));
  process.stdout.write(`Stored claude credential (fingerprint ${secretFingerprint(token)})\n`);
}

async function authGit(parsed: ParsedArgs): Promise<void> {
  const host = option(parsed, 'host') ?? DEFAULT_GIT_HOST;
  const username = option(parsed, 'username') ?? DEFAULT_GIT_USERNAME;
  const token = await resolveSecret(parsed, () => {
    throw new Error('git token required; pass --token or pipe it on stdin');
  });
  const name = host === DEFAULT_GIT_HOST ? 'git' : `git:${host}`;
  await openCredentialStore().set(name, gitCredential({ token, host, username }));
  process.stdout.write(
    `Stored ${name} credential for ${username}@${host} (fingerprint ${secretFingerprint(token)})\n`,
  );
}

export async function authList(): Promise<void> {
  const store = openCredentialStore();
  const map = await store.load();
  const names = Object.keys(map).sort();
  if (names.length === 0) {
    process.stdout.write('No credentials stored.\n');
    return;
  }
  process.stdout.write('NAME\tKIND\tCREATED\tDETAIL\n');
  for (const name of names) {
    const credential = map[name];
    if (credential === undefined) continue;
    const detail =
      credential.meta !== undefined && Object.keys(credential.meta).length > 0
        ? Object.entries(credential.meta)
            .map(([key, value]) => `${key}=${value}`)
            .join(' ')
        : '-';
    process.stdout.write(`${name}\t${credential.kind}\t${credential.createdAt}\t${detail}\n`);
  }
}

async function authRemove(parsed: ParsedArgs): Promise<void> {
  const name = parsed.positional[0];
  if (name === undefined) throw new Error('auth rm requires a credential name');
  const removed = await openCredentialStore().remove(name);
  process.stdout.write(
    removed ? `Removed credential '${name}'\n` : `No credential named '${name}'\n`,
  );
}

/** Dispatch an `auth` subcommand. Returns false for an unknown subcommand. */
export async function auth(command: string | undefined, parsed: ParsedArgs): Promise<boolean> {
  switch (command) {
    case 'claude':
      await authClaude(parsed);
      return true;
    case 'git':
      await authGit(parsed);
      return true;
    case 'list':
    case 'ls':
      await authList();
      return true;
    case 'rm':
    case 'remove':
      await authRemove(parsed);
      return true;
    default:
      return false;
  }
}
