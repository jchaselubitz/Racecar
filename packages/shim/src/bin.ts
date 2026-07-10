#!/usr/bin/env node
/**
 * Executable entry for the shim daemon. This is the file the sandbox runs (both
 * the tsc-built `dist/bin.js` and the self-contained esbuild bundle uploaded to
 * a sandbox resolve to `runDaemon`), kept separate from `daemon.ts` so that
 * module stays import-safe for tests and bundlers.
 */
import { runDaemon } from './daemon.js';

void runDaemon().catch((error: unknown) => {
  process.stderr.write(`racecar-shim: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
