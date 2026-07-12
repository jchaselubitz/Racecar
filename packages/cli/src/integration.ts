/**
 * `racecar integration` — the CLI surface over the core integration queue.
 *
 * The core `@racecar/core` integration module is pure: it owns the state
 * machine, the immutable queue, and the compare-and-swap coordinator, all
 * without I/O. This module is the thin, side-effecting shell around it:
 *
 *  - it loads the project's git policy from `.racecar/config.yaml`;
 *  - it persists the immutable queue as JSON under `.racecar/integration/`;
 *  - it serializes writes with a resource-scoped lock so two coordinators never
 *    race on the same queue; and
 *  - it supplies {@link LocalGitOps}, a concrete {@link IntegrationGitOps} that
 *    rebases a candidate in a disposable worktree, runs the configured checks,
 *    and advances the default branch under an atomic `git update-ref`
 *    compare-and-swap.
 *
 * Every command honors the CLI contract: `--json` yields a stable object with
 * `ok`, `resourceKey`, `state`, and either `entry` or `resource`.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';
import {
  approveEntry,
  defaultBranchAdvancedEvent,
  DEFAULT_GIT_INTEGRATION_CONFIG,
  enqueue,
  processNextEntry,
  resolveGitIntegrationConfig,
  retryEntry,
  supersedeEntry,
  toIntegrationResource,
  type CandidateConflict,
  type CheckRunResult,
  type GitIntegrationConfig,
  type IntegrationGitOps,
  type PreparedCandidate,
  type QueueEntry,
} from '@racecar/core';
import { option, requireOption, type ParsedArgs } from './index.js';
import { emitEvent, isJsonMode, report, warn } from './output.js';

const execFileAsync = promisify(execFile);

const STATE_DIR = '.racecar';
const INTEGRATION_DIR = 'integration';
const DEFAULT_RESOURCE_KEY = 'primary';
/** Cap on captured conflict/check output so a queue file never grows unbounded. */
const MAX_CAPTURE_BYTES = 16 * 1024;

function statePath(cwd: string, ...parts: string[]): string {
  return join(cwd, STATE_DIR, ...parts);
}

/** Truncate captured git/check output to a bounded, storable size. */
function bounded(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_CAPTURE_BYTES
    ? `${trimmed.slice(0, MAX_CAPTURE_BYTES)}\n…(truncated)`
    : trimmed;
}

// --- git plumbing ----------------------------------------------------------

/** Result of a git invocation: exit code and captured streams. */
interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run git in a directory, never throwing on a non-zero exit. */
async function runGit(cwd: string, args: readonly string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', [...args], { cwd, encoding: 'utf8' });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

/** Run git, throwing with a precise message on failure. Returns trimmed stdout. */
async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await runGit(cwd, args);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

/** Resolve a revision to a full SHA, or undefined when it does not exist. */
async function revParse(cwd: string, rev: string): Promise<string | undefined> {
  const result = await runGit(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

// --- config ----------------------------------------------------------------

/**
 * Load the project's git integration policy from `.racecar/config.yaml` (or
 * `.racecar/config.json`). A missing file yields the default policy, so the
 * feature works before a project commits any config.
 */
export async function loadGitIntegrationConfig(cwd = process.cwd()): Promise<GitIntegrationConfig> {
  for (const file of ['config.yaml', 'config.yml', 'config.json']) {
    const path = statePath(cwd, file);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    try {
      // `yaml` parses JSON too, so one parser handles both file forms.
      return resolveGitIntegrationConfig(parseYaml(raw));
    } catch (error) {
      throw new Error(
        `could not load ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return DEFAULT_GIT_INTEGRATION_CONFIG;
}

// --- queue persistence + resource lock -------------------------------------

interface QueueFile {
  readonly version: 1;
  readonly resourceKey: string;
  readonly entries: QueueEntry[];
}

/**
 * The on-disk immutable queue for one resource, plus the resource-scoped lock
 * that serializes coordinators. The lock is an atomically-created directory:
 * `mkdir` fails if it already exists, so at most one process holds it.
 */
export class IntegrationStore {
  readonly #cwd: string;
  readonly resourceKey: string;

  constructor(resourceKey: string, cwd = process.cwd()) {
    this.resourceKey = resourceKey;
    this.#cwd = cwd;
  }

  get #file(): string {
    return statePath(this.#cwd, INTEGRATION_DIR, `${this.resourceKey}.json`);
  }

  get #lockDir(): string {
    return statePath(this.#cwd, INTEGRATION_DIR, `${this.resourceKey}.lock`);
  }

  /** Read the queue entries, or an empty list when none exist yet. */
  async load(): Promise<QueueEntry[]> {
    try {
      const parsed = JSON.parse(await readFile(this.#file, 'utf8')) as QueueFile;
      return parsed.entries ?? [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  /** Atomically persist the queue entries. */
  async save(entries: readonly QueueEntry[]): Promise<void> {
    const file: QueueFile = { version: 1, resourceKey: this.resourceKey, entries: [...entries] };
    await mkdir(dirname(this.#file), { recursive: true });
    const temp = `${this.#file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
    await rename(temp, this.#file);
  }

  /**
   * Run `fn` while holding the resource lock, releasing it afterward. Throws a
   * clear "resource busy" error if another process holds the lock.
   */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.#lockDir), { recursive: true });
    try {
      await mkdir(this.#lockDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(
          `integration resource '${this.resourceKey}' is busy (locked by another process); retry shortly`,
        );
      }
      throw error;
    }
    try {
      return await fn();
    } finally {
      await rm(this.#lockDir, { recursive: true, force: true });
    }
  }
}

// --- local git ops for `run --once` ----------------------------------------

/**
 * A concrete {@link IntegrationGitOps} that integrates against the local
 * repository's refs. It rebases a candidate into a disposable detached worktree,
 * runs the configured checks there, and advances the default branch with an
 * atomic `git update-ref` compare-and-swap (fails the write if the branch moved).
 * One instance is used per `run --once`; call {@link dispose} to clean up.
 *
 * This models the "direct Git remote" path in the design — an atomic ref update
 * guarded by an expected old SHA. A hosted, protected-branch path (push /
 * provider merge API) is a future implementation of the same interface.
 */
export class LocalGitOps implements IntegrationGitOps {
  readonly #repo: string;
  readonly #defaultBranch: string;
  #worktree: string | undefined;

  constructor(repo: string, defaultBranch: string) {
    this.#repo = repo;
    this.#defaultBranch = defaultBranch;
  }

  async readDefaultBranchSha(): Promise<string> {
    const sha = await revParse(this.#repo, this.#defaultBranch);
    if (sha === undefined) {
      throw new Error(`default branch '${this.#defaultBranch}' does not exist in ${this.#repo}`);
    }
    return sha;
  }

  async prepareCandidate(
    entry: QueueEntry,
    ontoSha: string,
    config: GitIntegrationConfig,
  ): Promise<PreparedCandidate | CandidateConflict> {
    await this.dispose();
    const worktree = await mkdtemp(join(tmpdir(), 'racecar-integ-'));
    this.#worktree = worktree;
    // A detached worktree at the base leaves the user's checkout untouched.
    await git(this.#repo, ['worktree', 'add', '--detach', worktree, ontoSha]);
    if (config.integration.mergeStrategy === 'squash') {
      const squash = await runGit(worktree, ['merge', '--squash', entry.headSha]);
      if (squash.code !== 0) {
        return { ok: false, conflict: bounded(squash.stdout + squash.stderr) };
      }
      const commit = await runGit(worktree, [
        'commit',
        '--no-verify',
        '-m',
        `Integrate ${entry.missionId} (${entry.branch})`,
      ]);
      if (commit.code !== 0) {
        return { ok: false, conflict: bounded(commit.stdout + commit.stderr) };
      }
    } else {
      // Rebase: replay the commits unique to the candidate onto the base.
      const range = await git(worktree, ['rev-list', '--reverse', `${ontoSha}..${entry.headSha}`]);
      const commits = range.split('\n').filter((line) => line.length > 0);
      for (const sha of commits) {
        const pick = await runGit(worktree, ['cherry-pick', sha]);
        if (pick.code !== 0) {
          await runGit(worktree, ['cherry-pick', '--abort']);
          return { ok: false, conflict: bounded(pick.stdout + pick.stderr) };
        }
      }
    }
    const rebasedSha = await git(worktree, ['rev-parse', 'HEAD']);
    return { ok: true, rebasedSha };
  }

  async runChecks(_rebasedSha: string, checks: readonly string[]): Promise<CheckRunResult> {
    if (this.#worktree === undefined) throw new Error('runChecks called before prepareCandidate');
    for (const check of checks) {
      // Run each configured check as a shell command in the prepared worktree.
      const run = await execShell(this.#worktree, check);
      if (run.code !== 0) {
        return { ok: false, output: bounded(`$ ${check}\n${run.stdout}${run.stderr}`) };
      }
    }
    return {
      ok: true,
      output: checks.length > 0 ? `${checks.length} check(s) passed` : 'no checks configured',
    };
  }

  async advanceDefaultBranch(
    expectedSha: string,
    rebasedSha: string,
  ): Promise<{ ok: true; mergedSha: string } | { ok: false; actualSha: string }> {
    // Atomic compare-and-swap: update-ref only succeeds if the branch still
    // points at expectedSha, so a concurrent advance is detected, never clobbered.
    const cas = await runGit(this.#repo, [
      'update-ref',
      `refs/heads/${this.#defaultBranch}`,
      rebasedSha,
      expectedSha,
    ]);
    if (cas.code !== 0) {
      const actual = (await revParse(this.#repo, this.#defaultBranch)) ?? expectedSha;
      return { ok: false, actualSha: actual };
    }
    return { ok: true, mergedSha: rebasedSha };
  }

  /** Remove the disposable worktree, if any. Best-effort. */
  async dispose(): Promise<void> {
    if (this.#worktree === undefined) return;
    const worktree = this.#worktree;
    this.#worktree = undefined;
    await runGit(this.#repo, ['worktree', 'remove', '--force', worktree]);
    await rm(worktree, { recursive: true, force: true });
  }
}

/** Run a shell command in a directory, capturing streams without throwing. */
async function execShell(cwd: string, command: string): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync('sh', ['-c', command], {
      cwd,
      encoding: 'utf8',
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

// --- reporting -------------------------------------------------------------

/** Emit an entry-shaped command result honoring the `ok/resourceKey/state/entry` contract. */
function reportEntry(type: string, resourceKey: string, entry: QueueEntry, human: string): void {
  report(type, { ok: true, resourceKey, state: entry.state, entry }, human);
}

// --- command handlers ------------------------------------------------------

function resolveResourceKey(parsed: ParsedArgs): string {
  return option(parsed, 'resource') ?? option(parsed, 'project') ?? DEFAULT_RESOURCE_KEY;
}

/**
 * `racecar integration status [--resource <key>] [--mission <id>] [--entry <id>]`
 * — list the queue for a resource (optionally filtered to one mission or entry),
 * projecting each open entry into the compact resource Overlord renders.
 */
export async function integrationStatus(parsed: ParsedArgs): Promise<void> {
  const resourceKey = resolveResourceKey(parsed);
  const mission = option(parsed, 'mission');
  const entryId = option(parsed, 'entry');
  const config = await loadGitIntegrationConfig();
  const store = new IntegrationStore(resourceKey);
  const entries = await store.load();
  const selected = entries.filter(
    (entry) =>
      (mission === undefined || entry.missionId === mission) &&
      (entryId === undefined || entry.entryId === entryId),
  );
  // Best-effort default-branch head, for behind/ahead context; absent outside a repo.
  const defaultBranchSha = await revParse(process.cwd(), config.defaultBranch);
  if (isJsonMode()) {
    for (const entry of selected) {
      emitEvent('integration.status', {
        ok: true,
        resourceKey,
        state: entry.state,
        resource: toIntegrationResource(entry, {
          defaultBranch: config.defaultBranch,
          ...(defaultBranchSha !== undefined ? { defaultBranchSha } : {}),
        }),
      });
    }
    return;
  }
  if (selected.length === 0) {
    process.stdout.write(`no integration entries for '${resourceKey}'\n`);
    return;
  }
  process.stdout.write('ENTRY\tMISSION\tSTATE\tHEAD\tMERGED\tBRANCH\n');
  for (const entry of selected) {
    process.stdout.write(
      `${entry.entryId}\t${entry.missionId}\t${entry.state}\t${entry.headSha.slice(0, 10)}\t${
        entry.mergedSha?.slice(0, 10) ?? '-'
      }\t${entry.branch}\n`,
    );
  }
}

/**
 * `racecar integration enqueue --mission <id> --head <sha> [--branch <name>]
 * [--resource <key>] [--priority <p>]` — accept an immutable queue entry for an
 * exact commit. Fails if the mission branch does not currently contain `--head`.
 */
export async function integrationEnqueue(parsed: ParsedArgs): Promise<void> {
  const resourceKey = resolveResourceKey(parsed);
  const missionId = requireOption(parsed, 'mission');
  const head = requireOption(parsed, 'head');
  const config = await loadGitIntegrationConfig();
  const cwd = process.cwd();
  const headSha = await revParse(cwd, head);
  if (headSha === undefined) {
    throw new Error(`--head '${head}' is not a commit in this repository`);
  }
  const branch =
    option(parsed, 'branch') ?? (await runGit(cwd, ['branch', '--show-current'])).stdout.trim();
  if (branch.length === 0) {
    throw new Error('could not determine the mission branch; pass --branch <name>');
  }
  // Contract: the mission branch must actually contain the enqueued commit.
  const contains = await runGit(cwd, ['merge-base', '--is-ancestor', headSha, branch]);
  if (contains.code !== 0) {
    throw new Error(`branch '${branch}' does not contain commit ${headSha.slice(0, 10)}`);
  }
  const queueBaseSha = (await revParse(cwd, config.defaultBranch)) ?? headSha;
  const baseResult = await runGit(cwd, ['merge-base', config.defaultBranch, headSha]);
  const baseSha = baseResult.code === 0 ? baseResult.stdout.trim() : queueBaseSha;
  const priority = option(parsed, 'priority') as QueueEntry['priority'] | undefined;
  const objectiveId = option(parsed, 'objective');
  const store = new IntegrationStore(resourceKey);
  await store.withLock(async () => {
    const entries = await store.load();
    const result = enqueue(entries, {
      resourceKey,
      missionId,
      ...(objectiveId !== undefined ? { objectiveId } : {}),
      branch,
      baseSha,
      headSha,
      queueBaseSha,
      ...(priority !== undefined ? { priority } : {}),
      requireApproval: config.integration.requireApproval,
    });
    await store.save(result.entries);
    const verb = result.entry.state === 'awaiting_approval' ? 'awaiting approval' : 'queued';
    reportEntry(
      'integration.enqueued',
      resourceKey,
      result.entry,
      `Entry ${result.entry.entryId} ${verb} (${missionId} @ ${headSha.slice(0, 10)})`,
    );
  });
}

/** `racecar integration approve --entry <id> [--resource <key>]`. */
export async function integrationApprove(parsed: ParsedArgs): Promise<void> {
  const resourceKey = resolveResourceKey(parsed);
  const entryId = requireOption(parsed, 'entry');
  const store = new IntegrationStore(resourceKey);
  await store.withLock(async () => {
    const entries = await store.load();
    const result = approveEntry(entries, entryId);
    await store.save(result.entries);
    reportEntry(
      'integration.approved',
      resourceKey,
      result.entry,
      `Approved ${entryId}; now queued`,
    );
  });
}

/** `racecar integration retry --entry <id> --head <sha> [--resource <key>]`. */
export async function integrationRetry(parsed: ParsedArgs): Promise<void> {
  const resourceKey = resolveResourceKey(parsed);
  const entryId = requireOption(parsed, 'entry');
  const head = requireOption(parsed, 'head');
  const config = await loadGitIntegrationConfig();
  const headSha = (await revParse(process.cwd(), head)) ?? head;
  const queueBaseSha = await revParse(process.cwd(), config.defaultBranch);
  const store = new IntegrationStore(resourceKey);
  await store.withLock(async () => {
    const entries = await store.load();
    const result = retryEntry(entries, entryId, headSha, {
      ...(queueBaseSha !== undefined ? { queueBaseSha } : {}),
      requireApproval: config.integration.requireApproval,
    });
    await store.save(result.entries);
    reportEntry(
      'integration.retried',
      resourceKey,
      result.entry,
      `Retry ${result.entry.entryId} supersedes ${entryId} (@ ${headSha.slice(0, 10)})`,
    );
  });
}

/** `racecar integration dequeue --entry <id> [--resource <key>]`. */
export async function integrationDequeue(parsed: ParsedArgs): Promise<void> {
  const resourceKey = resolveResourceKey(parsed);
  const entryId = requireOption(parsed, 'entry');
  const store = new IntegrationStore(resourceKey);
  await store.withLock(async () => {
    const entries = await store.load();
    const result = supersedeEntry(entries, entryId);
    await store.save(result.entries);
    reportEntry('integration.dequeued', resourceKey, result.entry, `Superseded ${entryId}`);
  });
}

/**
 * `racecar integration run --once [--resource <key>]` — process at most one
 * queued candidate under the resource lock, driving it through
 * rebasing → testing → merged (or conflict / checks_failed / cas_retry). The
 * atomic default-branch write is the compare-and-swap guard in {@link LocalGitOps}.
 */
export async function integrationRun(parsed: ParsedArgs): Promise<void> {
  const resourceKey = resolveResourceKey(parsed);
  if (!parsed.options.has('once')) {
    throw new Error('integration run currently supports only --once');
  }
  const config = await loadGitIntegrationConfig();
  const cwd = process.cwd();
  if (!existsSync(join(cwd, '.git'))) {
    throw new Error(`integration run must be executed inside a git repository (${cwd})`);
  }
  const store = new IntegrationStore(resourceKey);
  const ops = new LocalGitOps(cwd, config.defaultBranch);
  await store.withLock(async () => {
    const entries = await store.load();
    // Observe the head before the step so we can announce a real advance after it.
    const previousSha = await revParse(cwd, config.defaultBranch);
    let result;
    try {
      result = await processNextEntry(entries, config, ops, {}, resourceKey);
    } finally {
      await ops.dispose();
    }
    if (result.outcome === 'idle') {
      report(
        'integration.idle',
        { ok: true, resourceKey, state: 'idle' },
        `Nothing queued for '${resourceKey}'`,
      );
      return;
    }
    await store.save(result.entries);
    const entry = result.entry as QueueEntry;
    if (result.outcome === 'merged') {
      reportEntry(
        'integration.merged',
        resourceKey,
        entry,
        `Merged ${entry.missionId} → ${config.defaultBranch} (${entry.mergedSha?.slice(0, 10)})`,
      );
      if (previousSha !== undefined && result.mergedSha !== undefined) {
        const advanced = defaultBranchAdvancedEvent({
          resourceKey,
          defaultBranch: config.defaultBranch,
          previousSha,
          newSha: result.mergedSha,
          source: 'racecar-integration',
          mergedEntryId: entry.entryId,
        });
        emitEvent('integration.default_branch_advanced', { ...advanced });
      }
      return;
    }
    if (result.outcome === 'conflict') {
      warn(
        'integration.conflict',
        { ok: false, resourceKey, state: entry.state, entry: entry.entryId },
        `Conflict integrating ${entry.entryId}; returned to the mission sandbox to resolve and retry`,
      );
      reportEntry('integration.conflict', resourceKey, entry, `Entry ${entry.entryId} conflicted`);
      return;
    }
    if (result.outcome === 'checks_failed') {
      warn(
        'integration.checks_failed',
        { ok: false, resourceKey, state: entry.state, entry: entry.entryId },
        `Checks failed for ${entry.entryId}; returned to the mission sandbox to fix and retry`,
      );
      reportEntry(
        'integration.checks_failed',
        resourceKey,
        entry,
        `Entry ${entry.entryId} failed checks`,
      );
      return;
    }
    // cas_retry
    reportEntry(
      'integration.cas_retry',
      resourceKey,
      entry,
      `Default branch advanced during integration; re-queued ${entry.entryId} to rebase onto ${result.observedSha?.slice(0, 10)}`,
    );
  });
}
