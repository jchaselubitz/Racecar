#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const dockerfile = resolve(import.meta.dirname, '../deploy/railway/Dockerfile');
const check = process.argv.includes('--check');
const packages = [
  { name: 'overlord-cli', argument: 'OVERLORD_CLI_VERSION' },
  { name: 'racecar-cli', argument: 'RACECAR_CLI_VERSION' },
];

async function latestVersion(name) {
  const response = await fetch(`https://registry.npmjs.org/${name}/latest`);
  if (!response.ok) throw new Error(`could not resolve ${name}: ${response.statusText}`);
  const metadata = await response.json();
  if (typeof metadata.version !== 'string' || metadata.version.length === 0)
    throw new Error(`npm registry returned no version for ${name}`);
  return metadata.version;
}

const latest = await Promise.all(
  packages.map(async (entry) => ({ ...entry, version: await latestVersion(entry.name) })),
);
let source = await readFile(dockerfile, 'utf8');
let changed = false;

for (const entry of latest) {
  const expression = new RegExp(`^(ARG ${entry.argument}=)([^\\s]+)$`, 'm');
  const match = source.match(expression);
  if (match === null) throw new Error(`missing ${entry.argument} in ${dockerfile}`);
  if (match[2] === entry.version) continue;
  changed = true;
  source = source.replace(expression, `$1${entry.version}`);
  console.log(`${entry.name}: ${match[2]} -> ${entry.version}`);
}

if (!changed) {
  console.log('Gateway CLI pins are already current.');
  process.exit(0);
}
if (check) {
  console.error('Gateway CLI pins need an update.');
  process.exit(1);
}
await writeFile(dockerfile, source);
