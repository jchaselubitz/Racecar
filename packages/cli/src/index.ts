/** @racecar/cli — the `racecar` command-line client. */
import { CORE_PACKAGE } from '@racecar/core';

/** Returns the CLI version banner. */
export function banner(): string {
  return `racecar — powered by ${CORE_PACKAGE}`;
}

/** Quote an untrusted value for a POSIX shell command sent to a sandbox. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
}

/** Parsed command-line arguments: bare positionals and `--key[=value]` options. */
export interface ParsedArgs {
  readonly positional: string[];
  readonly options: ReadonlyMap<string, string | true>;
}

/**
 * Parse `--key value`, `--key=value`, and boolean `--flag` forms alongside
 * positional arguments. A `--key` immediately followed by another `--option`
 * (or nothing) is treated as a boolean flag.
 */
export function parseArgs(args: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const options = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [key, inline] = arg.slice(2).split('=', 2);
    if (key === undefined || key.length === 0) throw new Error(`invalid option '${arg}'`);
    if (inline !== undefined) {
      options.set(key, inline);
      continue;
    }
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      options.set(key, next);
      index += 1;
    } else {
      options.set(key, true);
    }
  }
  return { positional, options };
}

/** Value of an option, or `undefined`; throws if the flag was given no value. */
export function option(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.options.get(name);
  if (value === undefined) return undefined;
  if (value === true) throw new Error(`--${name} requires a value`);
  return value;
}

/** Value of a required option; throws if it is absent. */
export function requireOption(parsed: ParsedArgs, name: string): string {
  return (
    option(parsed, name) ??
    (() => {
      throw new Error(`--${name} is required`);
    })()
  );
}

/** Read all of stdin as a UTF-8 string (used to accept secrets off a pipe). */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
