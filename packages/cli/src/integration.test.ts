import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  enqueue,
  processNextEntry,
  resolveGitIntegrationConfig,
  type QueueEntry,
} from '@racecar/core';
import { IntegrationStore, LocalGitOps, loadGitIntegrationConfig } from './integration.js';

const exec = promisify(execFile);

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs.length = 0;
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
}

/** Initialize a repo with a `main` branch and one commit; return its dir. */
async function initRepo(): Promise<string> {
  const dir = await tempDir('racecar-repo-');
  await git(dir, 'init', '-b', 'main');
  await git(dir, 'config', 'user.email', 'test@racecar.test');
  await git(dir, 'config', 'user.name', 'Racecar Test');
  await writeFile(join(dir, 'x.txt'), 'base\n');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'base');
  return dir;
}

const SQUASH_CONFIG = resolveGitIntegrationConfig({ git: { defaultBranch: 'main' } });

/** Enqueue one candidate from a feature branch's head onto main's head. */
async function seedEntry(dir: string, branch: string): Promise<QueueEntry[]> {
  const baseSha = await git(dir, 'rev-parse', 'main');
  const headSha = await git(dir, 'rev-parse', branch);
  const { entries } = enqueue([], {
    resourceKey: 'app',
    missionId: 'coo:252',
    branch,
    baseSha,
    headSha,
    queueBaseSha: baseSha,
  });
  return entries;
}

describe('IntegrationStore', () => {
  it('round-trips entries and defaults to empty', async () => {
    const cwd = await tempDir('racecar-store-');
    const store = new IntegrationStore('app', cwd);
    expect(await store.load()).toEqual([]);
    const { entries } = enqueue([], {
      resourceKey: 'app',
      missionId: 'm1',
      branch: 'b',
      baseSha: 'a',
      headSha: 'c',
      queueBaseSha: 'a',
    });
    await store.save(entries);
    const reloaded = await store.load();
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]?.missionId).toBe('m1');
  });

  it('serializes writes with a resource-scoped lock', async () => {
    const cwd = await tempDir('racecar-lock-');
    const store = new IntegrationStore('app', cwd);
    await store.withLock(async () => {
      await expect(store.withLock(() => Promise.resolve(undefined))).rejects.toThrow(/busy/);
    });
    // The lock is released afterward, so a later acquire succeeds.
    await expect(store.withLock(() => Promise.resolve('ok'))).resolves.toBe('ok');
  });
});

describe('loadGitIntegrationConfig', () => {
  it('reads .racecar/config.yaml', async () => {
    const cwd = await tempDir('racecar-cfg-');
    await mkdir(join(cwd, '.racecar'), { recursive: true });
    await writeFile(
      join(cwd, '.racecar', 'config.yaml'),
      'version: 1\ngit:\n  defaultBranch: trunk\n  integration:\n    mergeStrategy: rebase\n',
    );
    const config = await loadGitIntegrationConfig(cwd);
    expect(config.defaultBranch).toBe('trunk');
    expect(config.integration.mergeStrategy).toBe('rebase');
  });

  it('defaults when no config file exists', async () => {
    const cwd = await tempDir('racecar-cfg-none-');
    const config = await loadGitIntegrationConfig(cwd);
    expect(config.defaultBranch).toBe('main');
  });
});

describe('LocalGitOps (end-to-end)', () => {
  it('rebases, checks, and advances main under compare-and-swap', async () => {
    const dir = await initRepo();
    await git(dir, 'checkout', '-b', 'feature');
    await writeFile(join(dir, 'y.txt'), 'feature\n');
    await git(dir, 'add', '.');
    await git(dir, 'commit', '-m', 'feature work');
    await git(dir, 'checkout', 'main');
    const entries = await seedEntry(dir, 'feature');

    const ops = new LocalGitOps(dir, 'main');
    const result = await processNextEntry(entries, SQUASH_CONFIG, ops, {}, 'app');
    await ops.dispose();

    expect(result.outcome).toBe('merged');
    expect(result.entry?.mergedSha).toBeDefined();
    // main now points at the merged commit (the CAS advance landed).
    expect(await git(dir, 'rev-parse', 'main')).toBe(result.entry?.mergedSha);
    // The user's working tree/branch is untouched — no leftover worktrees.
    expect(await git(dir, 'worktree', 'list')).not.toContain('racecar-integ');
  });

  it('returns a conflict when the candidate cannot be applied onto a diverged main', async () => {
    const dir = await initRepo();
    await git(dir, 'checkout', '-b', 'feature');
    await writeFile(join(dir, 'x.txt'), 'feature-change\n');
    await git(dir, 'add', '.');
    await git(dir, 'commit', '-m', 'edit x on feature');
    await git(dir, 'checkout', 'main');
    // Diverge main on the same file so the squash merge conflicts.
    await writeFile(join(dir, 'x.txt'), 'main-change\n');
    await git(dir, 'add', '.');
    await git(dir, 'commit', '-m', 'edit x on main');
    const entries = await seedEntry(dir, 'feature');

    const ops = new LocalGitOps(dir, 'main');
    const result = await processNextEntry(entries, SQUASH_CONFIG, ops, {}, 'app');
    await ops.dispose();

    expect(result.outcome).toBe('conflict');
    expect(result.entry?.state).toBe('conflict');
    expect(result.entry?.conflict).toBeTruthy();
  });

  it('returns checks_failed when a configured check fails', async () => {
    const dir = await initRepo();
    await git(dir, 'checkout', '-b', 'feature');
    await writeFile(join(dir, 'y.txt'), 'feature\n');
    await git(dir, 'add', '.');
    await git(dir, 'commit', '-m', 'feature work');
    await git(dir, 'checkout', 'main');
    const entries = await seedEntry(dir, 'feature');

    const failingConfig = resolveGitIntegrationConfig({
      git: { defaultBranch: 'main', integration: { checks: ['exit 3'] } },
    });
    const ops = new LocalGitOps(dir, 'main');
    const result = await processNextEntry(entries, failingConfig, ops, {}, 'app');
    await ops.dispose();

    expect(result.outcome).toBe('checks_failed');
    // main did not advance — the failed candidate never touched the ref.
    expect(await git(dir, 'rev-parse', 'main')).toBe(entries[0]?.baseSha);
  });
});
