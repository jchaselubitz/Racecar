/**
 * Bundle the `racecar` CLI into a single self-contained ESM file for npm.
 *
 * The CLI depends on the workspace packages `@racecar/core` and `@racecar/shim`,
 * which are not published to npm. We inline them here so the published
 * `racecar-cli` package carries no `@racecar/*` runtime dependency. The genuine
 * third-party dependencies (`@daytona/sdk`, `ws`, `yaml`) stay external and are
 * declared in package.json, so npm installs them for the consumer.
 *
 * The in-sandbox daemon (`racecar-shim.cjs`, produced by `@racecar/shim`) ships
 * as a data asset next to the bundle; `readShimBundle()` reads it from there.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { chmod, copyFile } from 'node:fs/promises';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dist = resolve(root, 'dist');
const shimBundle = resolve(root, '..', 'shim', 'dist', 'racecar-shim.cjs');

const outfile = resolve(dist, 'racecar.js');

await build({
  entryPoints: [resolve(root, 'src/main.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  // The `#!/usr/bin/env node` shebang from src/main.ts is preserved by esbuild.
  // Genuine npm dependencies stay external (declared in package.json). Only the
  // unpublished workspace packages `@racecar/{core,shim}` are inlined. The two
  // native optionals are `ws` speedups that must never be bundled.
  external: ['@daytona/sdk', 'ws', 'yaml', 'bufferutil', 'utf-8-validate'],
  logLevel: 'info',
});

await chmod(outfile, 0o755);

// Ship the in-sandbox daemon next to the bundle so readShimBundle() finds it.
await copyFile(shimBundle, resolve(dist, 'racecar-shim.cjs'));
