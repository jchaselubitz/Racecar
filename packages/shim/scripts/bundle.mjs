/**
 * Bundle the shim daemon into a single self-contained CommonJS file the control
 * plane uploads into a sandbox and runs with `node`.
 *
 * The sandbox snapshot is the *user's* project image and carries no Racecar
 * dependencies (not even `ws`), so everything the daemon needs — including `ws`
 * — is bundled in. The output is one file with no `node_modules` requirement,
 * which keeps sandbox delivery to a single upload.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

await build({
  entryPoints: [resolve(root, 'src/bin.ts')],
  outfile: resolve(root, 'dist/racecar-shim.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  minify: true,
  // `bufferutil`/`utf-8-validate` are optional native speedups `ws` loads at
  // runtime if present; marking them external keeps the bundle pure-JS and
  // portable, and `ws` already degrades gracefully when they are absent.
  external: ['bufferutil', 'utf-8-validate'],
  logLevel: 'info',
});
