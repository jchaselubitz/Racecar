/**
 * CLI-side shim delivery: read the bundled daemon and boot it inside a sandbox.
 *
 * The daemon ships as a single self-contained file built by `@racecar/shim`
 * (`dist/racecar-shim.cjs`). The CLI resolves that file from the installed
 * package, hands it to {@link shimBootScript}, and runs the result over the
 * provider's exec channel — writing the bundle and launching it detached in its
 * own tmux session. Token generation and env injection happen at sandbox
 * creation (see `main.ts`); this module only performs the delivery.
 */
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  shimBootScript,
  shimStatusScript,
  SHIM_TMUX_SESSION,
  type SandboxProvider,
} from '@racecar/core';

/** Resolve and read the bundled shim daemon source from the installed package. */
export async function readShimBundle(): Promise<string> {
  const require = createRequire(import.meta.url);
  const packageJson = require.resolve('@racecar/shim/package.json');
  const bundlePath = join(dirname(packageJson), 'dist', 'racecar-shim.cjs');
  try {
    return await readFile(bundlePath, 'utf8');
  } catch {
    throw new Error(
      `shim bundle not found at ${bundlePath}; build it with 'yarn workspace @racecar/shim build'`,
    );
  }
}

/** Whether the shim's tmux session is alive, parsed from {@link shimStatusScript}. */
export function parseShimRunning(output: string): boolean {
  return output.split('\n').some((line) => line.trim() === 'RUNNING');
}

/**
 * Deliver the shim bundle to a sandbox and launch it. Returns whether the daemon
 * came up. The sandbox must already carry the per-sandbox token in its env (set
 * at creation) — this only writes and starts the bundle.
 */
export async function bootShim(provider: SandboxProvider, sandboxId: string): Promise<boolean> {
  const bundle = await readShimBundle();
  const boot = await provider.exec(sandboxId, {
    command: shimBootScript({ bundle }),
    timeoutSeconds: 60,
  });
  if (boot.exitCode !== 0) {
    throw new Error(`shim boot script failed in '${sandboxId}':\n${boot.output}`);
  }
  const status = await provider.exec(sandboxId, {
    command: shimStatusScript(SHIM_TMUX_SESSION),
    timeoutSeconds: 15,
  });
  return parseShimRunning(status.output);
}
