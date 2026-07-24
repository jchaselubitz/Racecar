#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  agentStatusFromActivity,
  auditSandboxLabels,
  buildEgressPolicy,
  countsAgainstConcurrencyCap,
  credentialScrub,
  DaytonaProvider,
  decideSnapshotRebuild,
  decodeSandboxLabels,
  DEFAULT_MAX_RUN_MINUTES,
  DEFAULT_RECONCILE_POLICY,
  DEFAULT_WORKSPACE_DIR,
  defineProject,
  encodeSandboxLabels,
  ensureSessionScript,
  estimateSpendUsd,
  evaluateQuota,
  executeReconciliation,
  exitCodeForError,
  exitCodeForFailure,
  formatUsd,
  generateShimToken,
  knownAgents,
  paneCommandsScript,
  parseEgressAllowlist,
  parsePaneActivity,
  parseRunRecords,
  planReconciliation,
  QuotaExceededError,
  readRunsScript,
  Redactor,
  resolveResourceClass,
  RESOURCE_CLASSES,
  RetryingProvider,
  sandboxLabelSelector,
  secretFingerprint,
  SHIM_DEFAULT_PORT,
  SHIM_TOKEN_ENV,
  toSandbox,
  toSandboxes,
  TMUX_SETUP_COMMANDS,
  validateLabels,
  withTimeout,
  type AgentStatus,
  type LogArtifact,
  type Project,
  type QuotaLimits,
  type QuotaUsage,
  type QuotaViolation,
  type ReconcileObservation,
  type ReconcilePolicy,
  type ResourceClass,
  type Sandbox,
  type SandboxProvider,
  type Snapshot,
} from '@racecar/core';
import { banner, option, parseArgs, requireOption, shellQuote } from './index.js';
import { attachToSandbox } from './attach.js';
import { auth } from './auth.js';
import { chatWithSandbox } from './chat.js';
import {
  installOutputRedaction,
  installStoredSecretRedaction,
  loadCredentialInjection,
  loadStoredRedactor,
  openCredentialStore,
} from './credentials.js';
import { configureOutput, emitEvent, isJsonMode, report, warn } from './output.js';
import {
  collectInbox,
  formatInbox,
  mailboxMessageEvent,
  replyToMessage,
  sendInstruction,
} from './msg.js';
import { listRuns, startRun, type ShimRunRecord } from './run.js';
import { bootShim, rotateShimToken } from './shim.js';
import {
  integrationApprove,
  integrationDequeue,
  integrationEnqueue,
  integrationRetry,
  integrationRun,
  integrationStatus,
} from './integration.js';

const STATE_DIR = '.racecar';
const PROJECTS_DIR = 'projects';
const SNAPSHOTS_DIR = 'snapshots';
const ARTIFACTS_DIR = 'artifacts';
const DEFAULT_IMAGE = 'node:24-bookworm-slim';
/** Org-wide quota config, applied across every project. */
const QUOTA_FILE = 'quota.json';

function statePath(...parts: string[]): string {
  return join(process.cwd(), STATE_DIR, ...parts);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

async function writeText(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, 'utf8');
}

async function readJson<T>(path: string, description: string): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${description} not found; run 'racecar project init' first`);
    }
    throw error;
  }
}

async function loadProject(name: string): Promise<Project> {
  // Normalize legacy project files so snapshots gain the primary resource even
  // when they were created before multi-resource layouts existed.
  return defineProject(
    await readJson<Project>(statePath(PROJECTS_DIR, `${name}.json`), `project '${name}'`),
  );
}

async function loadSnapshot(project: string): Promise<Snapshot> {
  return readJson<Snapshot>(
    statePath(SNAPSHOTS_DIR, `${project}.json`),
    `snapshot for '${project}'`,
  );
}

function git(...args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: process.cwd(), encoding: 'utf8' }).trim();
  } catch {
    throw new Error(`could not run git ${args.join(' ')} in ${process.cwd()}`);
  }
}

async function lockfileHash(directory = process.cwd()): Promise<string | undefined> {
  for (const filename of ['yarn.lock', 'package-lock.json', 'pnpm-lock.yaml', 'bun.lockb']) {
    try {
      const contents = await readFile(join(directory, filename));
      return createHash('sha256').update(contents).digest('hex');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return undefined;
}

/** Resolve a sandbox's recorded resource class, falling back to the default. */
function classFor(sandbox: Sandbox): ResourceClass {
  return resolveResourceClass(sandbox.resourceClass);
}

/**
 * Summarize a set of sandboxes into the quota usage the evaluator consumes:
 * how many count as live, and the summed modeled hourly spend of those.
 */
function usageOf(sandboxes: readonly Sandbox[]): QuotaUsage {
  let concurrentSandboxes = 0;
  let hourlySpendUsd = 0;
  for (const sandbox of sandboxes) {
    if (!countsAgainstConcurrencyCap(sandbox)) continue;
    concurrentSandboxes += 1;
    hourlySpendUsd += classFor(sandbox).hourlyUsd;
  }
  return { concurrentSandboxes, hourlySpendUsd };
}

/** Load the org-wide quota limits, or an empty (unlimited) policy when absent. */
async function loadOrgQuota(): Promise<QuotaLimits> {
  try {
    return await readJson<QuotaLimits>(statePath(QUOTA_FILE), 'org quota');
  } catch {
    return {};
  }
}

/**
 * Kick off a snapshot rebuild in a detached background process so the current
 * mission is never blocked on it. The child re-invokes this CLI's own
 * `snapshot build`, inheriting the provider credentials from the environment.
 * Best-effort: a spawn failure warns rather than aborting the caller.
 */
function spawnSnapshotRebuild(projectName: string): void {
  const entry = process.argv[1];
  if (entry === undefined) return;
  try {
    const child = spawn(process.execPath, [entry, 'snapshot', 'build', '--project', projectName], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    report(
      'snapshot.rebuild-scheduled',
      { project: projectName, pid: child.pid ?? null },
      `Scheduled an async snapshot rebuild for '${projectName}' (pid ${child.pid ?? '?'})`,
    );
  } catch (error) {
    warn(
      'snapshot.rebuild-spawn-failed',
      { project: projectName },
      `warning: could not schedule a snapshot rebuild for '${projectName}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function provider(): SandboxProvider {
  const apiKey = process.env.DAYTONA_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error('DAYTONA_API_KEY is required for provider commands');
  }
  const daytona = new DaytonaProvider({
    apiKey,
    ...(process.env.DAYTONA_API_URL !== undefined ? { apiUrl: process.env.DAYTONA_API_URL } : {}),
    ...(process.env.DAYTONA_ORGANIZATION_ID !== undefined
      ? { organizationId: process.env.DAYTONA_ORGANIZATION_ID }
      : {}),
    ...(process.env.DAYTONA_TARGET !== undefined ? { target: process.env.DAYTONA_TARGET } : {}),
  });
  // Wrap every provider call in rate-limit backoff: a 429 means the request did
  // no work, so retrying it after a short exponential wait is safe and spares
  // the operator transient provider-overload failures.
  return new RetryingProvider(daytona);
}

function sandboxName(project: string, mission: string): string {
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replaceAll(/[^a-z0-9-]/g, '-')
      .slice(0, 30);
  return `racecar-${normalize(project)}-${normalize(mission)}-${Date.now().toString(36)}`;
}

/**
 * Adapter callers may add correlation labels, but cannot replace Racecar's
 * identity labels. Keeping the validation at the CLI boundary means provider
 * label limits fail before a sandbox is created.
 */
function additionalSandboxLabels(value: string | undefined): Record<string, string> {
  if (value === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('--labels-json must be a JSON object with string values');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--labels-json must be a JSON object with string values');
  }
  const labels: Record<string, string> = {};
  for (const [key, labelValue] of Object.entries(parsed)) {
    if (typeof labelValue !== 'string') {
      throw new Error('--labels-json must be a JSON object with string values');
    }
    labels[key] = labelValue;
  }
  return labels;
}

async function projectInit(args: readonly string[]): Promise<void> {
  const parsed = parseArgs(args);
  const repoUrl = option(parsed, 'repo') ?? git('config', '--get', 'remote.origin.url');
  const defaultBranch = option(parsed, 'branch') ?? (git('branch', '--show-current') || 'main');
  const name = option(parsed, 'name') ?? resolve(process.cwd()).split('/').pop() ?? 'project';
  const workspaceDir = option(parsed, 'workspace-dir');
  const resourcesJson = option(parsed, 'resources-json');
  const resources =
    resourcesJson === undefined
      ? undefined
      : (() => {
          const value: unknown = JSON.parse(resourcesJson);
          if (
            !Array.isArray(value) ||
            value.some((entry) => entry === null || typeof entry !== 'object')
          ) {
            throw new Error(
              '--resources-json must be an array of { key, repoUrl, branch } objects',
            );
          }
          return value as { key: string; repoUrl: string; branch: string }[];
        })();
  const project = defineProject({
    name,
    repoUrl,
    snapshot: option(parsed, 'snapshot') ?? `${name}-snapshot`,
    defaultBranch,
    ...(workspaceDir !== undefined ? { workspaceDir } : {}),
    ...(resources !== undefined ? { resources } : {}),
    ...(parsed.options.has('auto-rebuild-snapshot') ? { autoRebuildSnapshot: true } : {}),
    egressAllowlist: parseEgressAllowlist(option(parsed, 'egress-allowlist')),
  });
  await writeJson(statePath(PROJECTS_DIR, `${project.name}.json`), project);
  report(
    'project.initialized',
    { project: project.name, repoUrl: project.repoUrl, defaultBranch: project.defaultBranch },
    `Initialized project '${project.name}' (${project.repoUrl})`,
  );
}

async function snapshotBuild(args: readonly string[]): Promise<void> {
  const parsed = parseArgs(args);
  const project = await loadProject(requireOption(parsed, 'project'));
  const currentHash = await lockfileHash();
  const p = provider();
  report(
    'snapshot.building',
    { snapshot: project.snapshot },
    `Building snapshot '${project.snapshot}'…`,
  );
  const built = await p.buildSnapshot({
    name: project.snapshot,
    baseImage: option(parsed, 'base-image') ?? DEFAULT_IMAGE,
    // Bake tmux into the image: every run executes inside a named tmux session
    // and `racecar attach` connects to it, so tmux must be present at boot.
    setupCommands: [
      ...TMUX_SETUP_COMMANDS,
      'corepack enable',
      ...project.resources.flatMap((resource) => [
        `rm -rf ${shellQuote(resource.workspaceDir)}`,
        `git clone --branch ${shellQuote(resource.branch)} --single-branch ${shellQuote(resource.repoUrl)} ${shellQuote(resource.workspaceDir)}`,
      ]),
      `cd ${shellQuote(project.workspaceDir)} && yarn install --immutable`,
    ],
    onLog: (chunk) => process.stderr.write(chunk),
  });
  const snapshot: Snapshot = {
    name: built.name,
    project: project.name,
    baseImage: option(parsed, 'base-image') ?? DEFAULT_IMAGE,
    ...(currentHash !== undefined ? { lockfileHash: currentHash } : {}),
    ...(built.imageName !== undefined ? { imageName: built.imageName } : {}),
    resourcePaths: Object.fromEntries(
      project.resources.map((resource) => [resource.key, resource.workspaceDir]),
    ),
    state: built.state,
    createdAt: new Date().toISOString(),
  };
  await writeJson(statePath(SNAPSHOTS_DIR, `${project.name}.json`), snapshot);
  const overlordProjectId = process.env.OVERLORD_PROJECT_ID;
  if (overlordProjectId !== undefined) {
    for (const resource of project.resources) {
      execFileSync(
        'ovld',
        [
          'add-cwd',
          '--directory',
          resource.workspaceDir,
          '--project-id',
          overlordProjectId,
          `--primary=${resource.primary ? 'true' : 'false'}`,
        ],
        { stdio: 'inherit' },
      );
    }
  }
  report(
    'snapshot.built',
    { snapshot: snapshot.name, state: snapshot.state },
    `Built snapshot '${snapshot.name}' (${snapshot.state})`,
  );
}

async function sandboxCreate(args: readonly string[]): Promise<void> {
  const parsed = parseArgs(args);
  const project = await loadProject(requireOption(parsed, 'project'));
  const mission = requireOption(parsed, 'mission');
  const branch = option(parsed, 'branch') ?? project.defaultBranch;
  const baseBranch = option(parsed, 'base-branch') ?? project.defaultBranch;
  const shared = parsed.options.has('shared');
  const extraLabels = additionalSandboxLabels(option(parsed, 'labels-json'));
  const workspaceContextFile = option(parsed, 'workspace-context-file');
  const workspaceContext =
    workspaceContextFile === undefined ? undefined : await readFile(workspaceContextFile, 'utf8');
  const resourceClass = resolveResourceClass(option(parsed, 'resource-class'));
  const snapshot = await loadSnapshot(project.name);
  const p = provider();
  // Enforce quotas before spending a create. The candidate adds one live
  // sandbox at its class's modeled hourly rate; check it against both the
  // project's own caps and the org-wide ceiling, over a fresh label listing.
  const all = toSandboxes(await p.listSandboxes({ labels: sandboxLabelSelector() }));
  const projectSandboxes = all.filter((sandbox) => sandbox.project === project.name);
  const delta = { concurrentSandboxes: 1, hourlySpendUsd: resourceClass.hourlyUsd };
  const violations: QuotaViolation[] = [
    ...evaluateQuota('project', usageOf(projectSandboxes), delta, {
      maxConcurrentSandboxes: project.lifecycle.maxConcurrentSandboxes,
      maxHourlySpendUsd: project.lifecycle.maxHourlySpendUsd,
    }),
    ...evaluateQuota('org', usageOf(all), delta, await loadOrgQuota()),
  ];
  if (violations.length > 0) {
    throw new QuotaExceededError(violations);
  }
  const injection = await loadCredentialInjection();
  const now = new Date().toISOString();
  // The per-sandbox shim token: generated here, injected as an env var the shim
  // daemon reads at boot, and never persisted to disk or a label. Every ACP
  // client connecting over the preview URL must present it.
  const shimToken = generateShimToken();
  // Scrub the token from any output before it can appear in an error or log echo.
  installOutputRedaction(new Redactor([shimToken]));
  const envVars = { ...injection.env, [SHIM_TOKEN_ENV]: shimToken };
  const egressPolicy = buildEgressPolicy({
    repoUrl: project.repoUrl,
    extensions: project.egressAllowlist,
    ...(process.env.DAYTONA_API_URL !== undefined
      ? { providerApiUrl: process.env.DAYTONA_API_URL }
      : {}),
  });
  const baseLabels = encodeSandboxLabels({
    project: project.name,
    mission,
    branch,
    snapshot: snapshot.name,
    resourceClass: resourceClass.name,
    createdAt: now,
    role: shared ? 'project' : 'mission',
    ...(process.env.USER !== undefined ? { createdBy: process.env.USER } : {}),
  });
  for (const key of Object.keys(extraLabels)) {
    if (key in baseLabels) {
      throw new Error(`--labels-json cannot replace Racecar identity label '${key}'`);
    }
  }
  const labels = { ...baseLabels, ...extraLabels };
  const labelIssues = validateLabels(labels);
  if (labelIssues.length > 0) {
    throw new Error(
      `invalid --labels-json: ${labelIssues.map((issue) => `${issue.key}: ${issue.message}`).join('; ')}`,
    );
  }
  const created = await p.createSandbox({
    snapshot: snapshot.name,
    name: sandboxName(project.name, mission),
    labels,
    envVars,
    networkBlockAll: egressPolicy.networkBlockAll,
    domainAllowList: egressPolicy.domainAllowList,
    autoStopMinutes: project.lifecycle.autoStopMinutes,
    autoArchiveMinutes: project.lifecycle.autoArchiveMinutes,
    autoDeleteMinutes:
      project.lifecycle.autoDeleteMinutes >= 0
        ? project.lifecycle.autoDeleteMinutes
        : project.lifecycle.retentionDays * 24 * 60,
  });
  const dir = shellQuote(project.workspaceDir);
  // Credential setup commands (which materialize 0600 files from injected env
  // vars) run before the clone so a private repo authenticates. They reference
  // env var names only — no secret literal ever enters this command string.
  // Prefer an existing remote branch; otherwise create it from --base-branch so
  // mission-branch launches can mint a new branch inside the sandbox.
  const checkout = [
    'set -eu',
    ...injection.setupCommands,
    // The snapshot owns the complete resource layout.  A sandbox may advance
    // only its primary working tree to the requested mission branch; recloning
    // here would discard siblings and make the registered Overlord paths vary
    // by sandbox instance.
    `if git -C ${dir} fetch origin ${shellQuote(branch)} && git -C ${dir} rev-parse --verify --quiet FETCH_HEAD >/dev/null; then`,
    `  git -C ${dir} checkout --force -B ${shellQuote(branch)} FETCH_HEAD`,
    'else',
    `  git -C ${dir} fetch origin ${shellQuote(baseBranch)}`,
    `  git -C ${dir} checkout --force -B ${shellQuote(branch)} FETCH_HEAD`,
    'fi',
    `cd ${dir}`,
    'corepack enable',
    'yarn install --immutable',
  ].join('\n');
  const result = await p.exec(created.id, { command: checkout, timeoutSeconds: 900 });
  if (result.exitCode !== 0) {
    await p.stopSandbox(created.id);
    throw new Error(
      `sandbox '${created.id}' was created but checkout/install failed:\n${result.output}`,
    );
  }
  if (workspaceContext !== undefined) {
    const contextPath = join(project.workspaceDir, '.racecar', 'workspace-context.json');
    const contextResult = await p.exec(created.id, {
      command: [
        'set -eu',
        `mkdir -p ${shellQuote(dirname(contextPath))}`,
        `printf %s ${shellQuote(Buffer.from(workspaceContext).toString('base64'))} | base64 --decode > ${shellQuote(contextPath)}`,
        `chmod 600 ${shellQuote(contextPath)}`,
      ].join('\n'),
    });
    if (contextResult.exitCode !== 0) {
      await p.stopSandbox(created.id);
      throw new Error(
        `sandbox '${created.id}' was created but workspace context could not be written:\n${contextResult.output}`,
      );
    }
  }
  const checkoutHashResult = await p.exec(created.id, {
    command: `cd ${shellQuote(project.workspaceDir)} && (sha256sum yarn.lock 2>/dev/null || shasum -a 256 yarn.lock 2>/dev/null || true) | awk '{print $1}'`,
  });
  const checkoutHash = checkoutHashResult.output.trim();
  const decision =
    checkoutHash.length > 0
      ? decideSnapshotRebuild(snapshot, checkoutHash, {
          autoRebuild: project.autoRebuildSnapshot,
        })
      : 'fresh';
  if (decision === 'warn') {
    warn(
      'snapshot.stale',
      { snapshot: snapshot.name, project: project.name, branch },
      `warning: snapshot '${snapshot.name}' is stale relative to ${branch}'s lockfile; rebuild with 'racecar snapshot build --project ${project.name}'`,
    );
  } else if (decision === 'rebuild') {
    // Auto-promotion: the current sandbox already has a fresh `yarn install`, so
    // it proceeds unaffected; the rebuild runs in the background so the *next*
    // sandbox cold-starts from an up-to-date snapshot.
    warn(
      'snapshot.stale',
      { snapshot: snapshot.name, project: project.name, branch },
      `snapshot '${snapshot.name}' is stale relative to ${branch}'s lockfile; scheduling an async rebuild`,
    );
    spawnSnapshotRebuild(project.name);
  }
  // Bootstrap the named tmux session (detached, in the workspace) so attach and
  // run find it ready. Kept out of the strict checkout above so a missing tmux
  // (e.g. a snapshot built before tmux was baked in) warns rather than discards
  // an otherwise-good clone.
  const tmuxBootstrap = await p.exec(created.id, {
    command: ensureSessionScript(project.workspaceDir),
  });
  if (tmuxBootstrap.exitCode !== 0) {
    warn(
      'tmux.bootstrap-failed',
      { sandbox: created.id, project: project.name },
      `warning: could not start the tmux session in '${created.id}'; attach/run need tmux — rebuild the snapshot with 'racecar snapshot build --project ${project.name}'`,
    );
  }
  // Deliver and launch the shim daemon so the sandbox exposes ACP over its
  // preview URL from boot. Best-effort: a delivery failure warns rather than
  // discarding an otherwise-good sandbox, since PTY attach/run still work.
  try {
    const running = await bootShim(p, created.id);
    if (running) {
      const preview = await p.getPreviewUrl(created.id, SHIM_DEFAULT_PORT);
      report(
        'shim.started',
        { sandbox: created.id, url: preview.url, port: SHIM_DEFAULT_PORT },
        `Shim listening on ${preview.url} (ACP over WebSocket)`,
      );
    } else {
      warn(
        'shim.not-running',
        { sandbox: created.id },
        `warning: the shim daemon did not come up in '${created.id}'; chat is unavailable until it starts`,
      );
    }
  } catch (error) {
    warn(
      'shim.boot-failed',
      { sandbox: created.id },
      `warning: could not start the shim in '${created.id}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  report(
    'sandbox.created',
    {
      sandbox: created.id,
      project: project.name,
      mission,
      branch,
      ...(workspaceContext === undefined
        ? {}
        : { workspaceContextPath: `${project.workspaceDir}/.racecar/workspace-context.json` }),
    },
    `Created sandbox '${created.id}' for ${project.name}/${mission} on ${branch}`,
  );
}

/**
 * Determine whether a sandbox has an active agent by inspecting its tmux
 * session's pane commands. Only started sandboxes are probed (a stopped sandbox
 * runs nothing); any probe failure degrades to `?` rather than breaking `ps`.
 */
async function agentStatus(p: SandboxProvider, sandbox: Sandbox): Promise<AgentStatus> {
  if (sandbox.state !== 'started') return '-';
  try {
    const result = await p.exec(sandbox.id, {
      command: paneCommandsScript(),
      timeoutSeconds: 15,
    });
    return agentStatusFromActivity(parsePaneActivity(result.output));
  } catch {
    return '?';
  }
}

async function printPs(p: SandboxProvider, projectName?: string): Promise<void> {
  const managed = toSandboxes(
    await p.listSandboxes({
      labels: sandboxLabelSelector(
        projectName === undefined ? undefined : { project: projectName },
      ),
    }),
  );
  const agents = await Promise.all(managed.map((sandbox) => agentStatus(p, sandbox)));
  const now = new Date();
  if (isJsonMode()) {
    managed.forEach((sandbox, index) => {
      const cls = classFor(sandbox);
      emitEvent('sandbox.ps', {
        sandbox: sandbox.id,
        project: sandbox.project,
        mission: sandbox.mission,
        branch: sandbox.branch,
        state: sandbox.state,
        agent: agents[index] ?? '?',
        resourceClass: cls.name,
        hourlyUsd: cls.hourlyUsd,
        estimatedSpendUsd: estimateSpendUsd(cls.hourlyUsd, sandbox.createdAt, now),
        lastActivityAt: sandbox.lastActivityAt ?? null,
      });
    });
    return;
  }
  process.stdout.write('ID\tPROJECT\tMISSION\tBRANCH\tSTATE\tAGENT\tCLASS\tEST$\tLAST ACTIVITY\n');
  managed.forEach((sandbox, index) => {
    const cls = classFor(sandbox);
    const spend = formatUsd(estimateSpendUsd(cls.hourlyUsd, sandbox.createdAt, now));
    process.stdout.write(
      `${sandbox.id}\t${sandbox.project}\t${sandbox.mission}\t${sandbox.branch}\t${sandbox.state}\t${agents[index] ?? '?'}\t${cls.name}\t${spend}\t${sandbox.lastActivityAt ?? '-'}\n`,
    );
  });
}

async function ps(args: readonly string[]): Promise<void> {
  const parsed = parseArgs(args);
  const project = option(parsed, 'project');
  const p = provider();
  await printPs(p, project);
  if (!parsed.options.has('watch')) return;
  const seconds = Number(option(parsed, 'interval') ?? '15');
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new Error('--interval must be a positive number');
  for (;;) {
    await new Promise<void>((done) => setTimeout(done, seconds * 1000));
    const sandboxes = toSandboxes(
      await p.listSandboxes({
        labels: sandboxLabelSelector(project === undefined ? undefined : { project }),
      }),
    );
    await Promise.all(
      sandboxes
        .filter((sandbox) => sandbox.state === 'started')
        .map((sandbox) => p.heartbeat(sandbox.id)),
    );
    if (!isJsonMode()) process.stdout.write('\n');
    await printPs(p, project);
  }
}

async function sandboxAction(
  action: 'stop' | 'start' | 'rm',
  args: readonly string[],
): Promise<void> {
  const parsed = parseArgs(args);
  const id = parsed.positional[0];
  if (id === undefined) throw new Error(`sandbox ${action} requires a sandbox id`);
  const p = provider();
  if (action === 'stop') await p.stopSandbox(id);
  if (action === 'start') await p.startSandbox(id);
  if (action === 'rm') await p.deleteSandbox(id);
  const verb = action === 'rm' ? 'Removed' : action === 'start' ? 'Started' : 'Stopped';
  report(`sandbox.${action}`, { sandbox: id }, `${verb} sandbox '${id}'`);
}

/**
 * Best-effort workspace directory for a sandbox: decode its project from labels
 * and read that project's configured `workspaceDir`. Used only to start a fresh
 * tmux session in the right place; an existing session keeps its own directory,
 * so a miss here (unknown project locally) is harmless.
 */
async function workspaceDirFor(sandbox: Sandbox): Promise<string | undefined> {
  const meta = decodeSandboxLabels(sandbox.labels);
  if (meta === null) return undefined;
  try {
    return (await loadProject(meta.project)).workspaceDir;
  } catch {
    return undefined;
  }
}

async function attach(args: readonly string[]): Promise<void> {
  const parsed = parseArgs(args);
  const id = parsed.positional[0];
  if (id === undefined) throw new Error('attach requires a sandbox id');
  const p = provider();
  const found = await p.getSandbox(id);
  if (found === null) throw new Error(`sandbox '${id}' not found`);
  const sandbox = toSandbox(found);
  if (sandbox === null) throw new Error(`sandbox '${id}' is not a Racecar-managed sandbox`);
  const startDir = await workspaceDirFor(sandbox);
  // Attach is an interactive PTY bridge; the NDJSON stream can only bracket it.
  emitEvent('attach.started', { sandbox: id });
  await attachToSandbox(p, id, { ...(startDir !== undefined ? { startDir } : {}) });
  emitEvent('attach.detached', { sandbox: id });
}

/** Render a run record as a compact human summary block. */
function formatRunRecord(record: ShimRunRecord): string {
  const lines = [
    `${record.runId}  [${record.status}]  ${record.agent}`,
    `  started: ${record.startedAt}${record.endedAt !== undefined ? `  ended: ${record.endedAt}` : ''}`,
  ];
  if (record.stopReason !== undefined) lines.push(`  stop reason: ${record.stopReason}`);
  const changed = (record.gitStatus ?? '').split('\n').filter((l) => l.trim().length > 0).length;
  if (record.gitStatus !== undefined || record.endedAt !== undefined) {
    lines.push(`  changed files: ${changed}`);
  }
  if (record.gitDiffStat !== undefined && record.gitDiffStat.trim().length > 0) {
    lines.push(...record.gitDiffStat.split('\n').map((l) => `    ${l}`));
  }
  return lines.join('\n');
}

/** Serialize a run record for the NDJSON stream. */
function runEventData(record: ShimRunRecord): Record<string, unknown> {
  return {
    runId: record.runId,
    sandbox: record.sandboxId,
    agent: record.agent,
    status: record.status,
    stopReason: record.stopReason ?? null,
    startedAt: record.startedAt,
    endedAt: record.endedAt ?? null,
    gitStatus: record.gitStatus ?? '',
    gitDiffStat: record.gitDiffStat ?? '',
  };
}

async function run(args: readonly string[]): Promise<void> {
  const parsed = parseArgs(args);
  const id = parsed.positional[0];
  const prompt = parsed.positional[1];
  if (id === undefined) throw new Error('run requires a sandbox id');
  if (prompt === undefined)
    throw new Error('run requires a prompt: racecar run <sandbox> "<prompt>"');
  const p = provider();
  const found = await p.getSandbox(id);
  if (found === null) throw new Error(`sandbox '${id}' not found`);
  const sandbox = toSandbox(found);
  if (sandbox === null) throw new Error(`sandbox '${id}' is not a Racecar-managed sandbox`);
  const workspaceDir = (await workspaceDirFor(sandbox)) ?? DEFAULT_WORKSPACE_DIR;
  const agent = option(parsed, 'agent');
  const timeout = option(parsed, 'timeout');
  // Stream the agent's reply live in text mode so `racecar run` shows progress;
  // in JSON mode the events carry it instead.
  const onUpdate = isJsonMode()
    ? undefined
    : (update: Parameters<NonNullable<Parameters<typeof startRun>[3]['onUpdate']>>[0]): void => {
        if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
          process.stdout.write(update.content.text);
        }
      };
  const result = await startRun(p, id, prompt, {
    workspaceDir,
    ...(agent !== undefined ? { agent } : {}),
    ...(timeout !== undefined ? { waitTimeoutSeconds: Number(timeout) } : {}),
    ...(onUpdate !== undefined ? { onUpdate } : {}),
  });
  if (result.timedOut === true) {
    warn(
      'run.timeout',
      { runId: result.record.runId, sandbox: id },
      `run '${result.record.runId}' did not finish before the timeout; it continues in the shim`,
    );
    // Deterministic: an outside-the-sandbox wait timeout exits with the timeout code.
    process.exitCode = exitCodeForFailure('timeout');
    return;
  }
  if (!isJsonMode()) process.stdout.write('\n');
  report(
    'run.completed',
    runEventData(result.record),
    `Run finished:\n${formatRunRecord(result.record)}`,
  );
  if (result.record.status !== 'succeeded') process.exitCode = 1;
}

async function runs(args: readonly string[]): Promise<void> {
  const parsed = parseArgs(args);
  const id = parsed.positional[0];
  if (id === undefined) throw new Error('runs requires a sandbox id');
  const p = provider();
  const records = await listRuns(p, id);
  if (isJsonMode()) {
    for (const record of records) emitEvent('run.record', runEventData(record));
    return;
  }
  if (records.length === 0) {
    process.stdout.write(`no runs recorded for '${id}'\n`);
    return;
  }
  process.stdout.write(records.map(formatRunRecord).join('\n\n'));
  process.stdout.write('\n');
}

async function chat(args: readonly string[]): Promise<void> {
  const parsed = parseArgs(args);
  const id = parsed.positional[0];
  if (id === undefined) throw new Error('chat requires a sandbox id');
  const p = provider();
  const found = await p.getSandbox(id);
  if (found === null) throw new Error(`sandbox '${id}' not found`);
  const sandbox = toSandbox(found);
  if (sandbox === null) throw new Error(`sandbox '${id}' is not a Racecar-managed sandbox`);
  const runId = option(parsed, 'run');
  const promptArg = parsed.positional[1];
  const cwd = (await workspaceDirFor(sandbox)) ?? DEFAULT_WORKSPACE_DIR;
  emitEvent('chat.started', { sandbox: id });
  await chatWithSandbox(p, id, {
    cwd,
    ...(runId !== undefined ? { run: runId } : {}),
    ...(promptArg !== undefined ? { prompt: promptArg } : {}),
  });
  emitEvent('chat.ended', { sandbox: id });
}

async function msgSend(args: readonly string[]): Promise<void> {
  const parsed = parseArgs(args);
  const id = parsed.positional[0];
  const text = parsed.positional[1];
  if (id === undefined) throw new Error('msg send requires a sandbox id');
  if (text === undefined)
    throw new Error('msg send requires text: racecar msg send <sandbox> "<text>"');
  const p = provider();
  const session = option(parsed, 'session');
  const message = await sendInstruction(p, id, text, session !== undefined ? { session } : {});
  report(
    'mailbox.sent',
    mailboxMessageEvent(id, message),
    `Queued instruction ${message.id} to '${id}'`,
  );
}

async function msgReply(args: readonly string[]): Promise<void> {
  const parsed = parseArgs(args);
  const id = parsed.positional[0];
  const inReplyTo = parsed.positional[1];
  const text = parsed.positional[2];
  if (id === undefined) throw new Error('msg reply requires a sandbox id');
  if (inReplyTo === undefined)
    throw new Error(
      'msg reply requires a message id: racecar msg reply <sandbox> <message-id> "<text>"',
    );
  if (text === undefined)
    throw new Error('msg reply requires text: racecar msg reply <sandbox> <message-id> "<text>"');
  const p = provider();
  const message = await replyToMessage(p, id, inReplyTo, text);
  report(
    'mailbox.replied',
    { ...mailboxMessageEvent(id, message), inReplyTo },
    `Replied to ${inReplyTo} in '${id}' (${message.id})`,
  );
}

async function inbox(args: readonly string[]): Promise<void> {
  const parsed = parseArgs(args);
  const p = provider();
  const project = option(parsed, 'project');
  const sandbox = option(parsed, 'sandbox');
  const inboxes = await collectInbox(p, {
    ...(project !== undefined ? { project } : {}),
    ...(sandbox !== undefined ? { sandbox } : {}),
    ...(parsed.options.has('unread') ? { unreadOnly: true } : {}),
  });
  if (isJsonMode()) {
    for (const box of inboxes) {
      if (box.error !== undefined) {
        emitEvent('mailbox.unavailable', { sandbox: box.sandbox.id, reason: box.error });
        continue;
      }
      emitEvent('mailbox.sandbox', {
        sandbox: box.sandbox.id,
        project: box.sandbox.project,
        mission: box.sandbox.mission,
        running: box.running,
        messageCount: box.messages.length,
      });
      for (const message of box.messages) {
        emitEvent('mailbox.message', mailboxMessageEvent(box.sandbox.id, message));
      }
    }
    return;
  }
  process.stdout.write(formatInbox(inboxes));
}

/** Per-operation timeout (seconds) for reconciliation's provider calls. */
const RECONCILE_OP_TIMEOUT_SECONDS = 120;

/**
 * Observe one sandbox for reconciliation: pair it with the age of its
 * longest-running run. Only started sandboxes are inspected (nothing runs in a
 * stopped one); any probe failure degrades to "no running run" rather than
 * breaking the sweep, so a wedged sandbox never blocks reconciling the rest.
 */
async function reconcileObservation(
  p: SandboxProvider,
  sandbox: Sandbox,
  now: Date,
): Promise<ReconcileObservation> {
  if (sandbox.state !== 'started') return { sandbox };
  try {
    const result = await withTimeout(
      p.exec(sandbox.id, { command: readRunsScript(), timeoutSeconds: 20 }),
      RECONCILE_OP_TIMEOUT_SECONDS * 1000,
      { label: `inspect ${sandbox.id}` },
    );
    let longest: { minutes: number; id: string } | undefined;
    for (const record of parseRunRecords(result.output)) {
      if (record.status !== 'running') continue;
      const started = Date.parse(record.startedAt);
      if (Number.isNaN(started)) continue;
      const minutes = (now.getTime() - started) / 60_000;
      if (longest === undefined || minutes > longest.minutes) {
        longest = { minutes, id: record.id };
      }
    }
    return longest === undefined
      ? { sandbox }
      : { sandbox, runningRunMinutes: longest.minutes, runningRunId: longest.id };
  } catch {
    return { sandbox };
  }
}

/**
 * `racecar reconcile` — the fleet-hygiene sweep. Deletes orphaned (error-state)
 * sandboxes, deletes archived sandboxes past retention, and halts runs that have
 * overrun their budget, capturing a bounded redacted log artifact before any
 * destructive step. `--dry-run` reports the plan without acting.
 */
async function reconcile(args: readonly string[]): Promise<void> {
  const parsed = parseArgs(args);
  const projectName = option(parsed, 'project');
  const dryRun = parsed.options.has('dry-run');
  const maxRunOpt = option(parsed, 'max-run-minutes');
  const maxRunMinutes =
    maxRunOpt !== undefined && Number.isFinite(Number(maxRunOpt))
      ? Number(maxRunOpt)
      : DEFAULT_MAX_RUN_MINUTES;
  // Retention comes from the named project's lifecycle policy when one is given,
  // else the reconcile default. A missing/unreadable project falls back too.
  let retentionDays = DEFAULT_RECONCILE_POLICY.retentionDays;
  if (projectName !== undefined) {
    try {
      retentionDays = (await loadProject(projectName)).lifecycle.retentionDays;
    } catch {
      // Keep the default if the project record cannot be read.
    }
  }
  const policy: ReconcilePolicy = { retentionDays, maxRunMinutes };
  const p = provider();
  const now = new Date();
  const managed = toSandboxes(
    await p.listSandboxes({
      labels: sandboxLabelSelector(
        projectName === undefined ? undefined : { project: projectName },
      ),
    }),
  );
  const observations = await Promise.all(
    managed.map((sandbox) => reconcileObservation(p, sandbox, now)),
  );
  const actions = planReconciliation(observations, policy, () => now);

  if (actions.length === 0) {
    report(
      'reconcile.clean',
      { scanned: managed.length, project: projectName ?? null },
      `Scanned ${managed.length} sandbox(es); nothing to reconcile.`,
    );
    return;
  }

  for (const action of actions) {
    report(
      'reconcile.planned',
      { action: action.kind, sandbox: action.sandboxId, reason: action.reason, dryRun },
      `${dryRun ? 'would ' : ''}${action.kind}: ${action.sandboxId} — ${action.reason}`,
    );
  }
  if (dryRun) return;

  const redactor = await loadStoredRedactor();
  const results = await executeReconciliation(actions, {
    provider: p,
    redactor,
    now: () => new Date(),
    persistArtifact: async (artifact: LogArtifact) => {
      const path = statePath(
        ARTIFACTS_DIR,
        `${artifact.sandboxId}-${artifact.capturedAt.replaceAll(/[:.]/g, '-')}.log`,
      );
      await writeText(path, artifact.content);
      report(
        'reconcile.artifact',
        {
          sandbox: artifact.sandboxId,
          path,
          bytes: artifact.bytes,
          truncated: artifact.truncated,
        },
        `  captured ${artifact.bytes}B log artifact${artifact.truncated ? ' (truncated)' : ''} → ${path}`,
      );
    },
    withOp: (op, label) => withTimeout(op(), RECONCILE_OP_TIMEOUT_SECONDS * 1000, { label }),
  });

  let failures = 0;
  for (const result of results) {
    if (result.outcome === 'done') {
      report(
        'reconcile.done',
        { action: result.action.kind, sandbox: result.action.sandboxId },
        `${result.action.kind}: ${result.action.sandboxId} — done`,
      );
    } else {
      failures += 1;
      warn(
        'reconcile.failed',
        { action: result.action.kind, sandbox: result.action.sandboxId, reason: result.error },
        `${result.action.kind}: ${result.action.sandboxId} — failed: ${result.error ?? 'unknown error'}`,
      );
    }
  }
  if (failures > 0) process.exitCode = exitCodeForError(new Error('reconcile had failures'));
}

/** Render one scope's usage-vs-limit line for the human `racecar quota` view. */
function quotaLine(scope: string, usage: QuotaUsage, limits: QuotaLimits): string {
  const conc =
    limits.maxConcurrentSandboxes !== undefined && limits.maxConcurrentSandboxes > 0
      ? `${usage.concurrentSandboxes}/${limits.maxConcurrentSandboxes}`
      : `${usage.concurrentSandboxes}/∞`;
  const spend =
    limits.maxHourlySpendUsd !== undefined && limits.maxHourlySpendUsd > 0
      ? `${formatUsd(usage.hourlySpendUsd)}/${formatUsd(limits.maxHourlySpendUsd)}`
      : `${formatUsd(usage.hourlySpendUsd)}/∞`;
  return `${scope}\t${conc}\t${spend}/hr`;
}

/**
 * `racecar quota [--project <project>]` — show current live-sandbox concurrency
 * and modeled hourly spend against the org ceiling and, when a project is named,
 * that project's own caps. Read-only; makes no changes.
 */
async function quota(args: readonly string[]): Promise<void> {
  const parsed = parseArgs(args);
  const projectName = option(parsed, 'project');
  const p = provider();
  const all = toSandboxes(await p.listSandboxes({ labels: sandboxLabelSelector() }));
  const orgLimits = await loadOrgQuota();
  const orgUsage = usageOf(all);
  let projectUsage: QuotaUsage | undefined;
  let projectLimits: QuotaLimits | undefined;
  if (projectName !== undefined) {
    projectUsage = usageOf(all.filter((sandbox) => sandbox.project === projectName));
    const project = await loadProject(projectName);
    projectLimits = {
      maxConcurrentSandboxes: project.lifecycle.maxConcurrentSandboxes,
      maxHourlySpendUsd: project.lifecycle.maxHourlySpendUsd,
    };
  }
  if (isJsonMode()) {
    emitEvent('quota.org', { usage: orgUsage, limits: orgLimits });
    if (projectName !== undefined && projectUsage !== undefined) {
      emitEvent('quota.project', {
        project: projectName,
        usage: projectUsage,
        limits: projectLimits,
      });
    }
    return;
  }
  process.stdout.write('SCOPE\tSANDBOXES\tHOURLY SPEND\n');
  process.stdout.write(`${quotaLine('org', orgUsage, orgLimits)}\n`);
  if (projectName !== undefined && projectUsage !== undefined && projectLimits !== undefined) {
    process.stdout.write(`${quotaLine(projectName, projectUsage, projectLimits)}\n`);
  }
}

/**
 * `racecar shim rotate-token <sandbox-id>` — rotate the per-sandbox shim token
 * that guards the preview-URL WebSocket. Generates a fresh token, rewrites the
 * sandbox's token file out-of-band, and restarts the daemon so it serves under
 * the new value. Existing clients (which hold the old token) are disconnected
 * and must reconnect. The token itself is never printed (it is redacted).
 */
async function shimRotate(args: readonly string[]): Promise<void> {
  const parsed = parseArgs(args);
  const sandboxId = parsed.positional[0];
  if (sandboxId === undefined) throw new Error('shim rotate-token requires a sandbox id');
  const p = provider();
  const sandbox = await p.getSandbox(sandboxId);
  if (sandbox === null) throw new Error(`no sandbox '${sandboxId}'`);
  if (sandbox.state !== 'started') {
    throw new Error(
      `sandbox '${sandboxId}' is ${sandbox.state}; start it before rotating its shim token`,
    );
  }
  const newToken = generateShimToken();
  // Scrub the new token from any output before it can appear in an error or echo.
  installOutputRedaction(new Redactor([newToken]));
  const running = await rotateShimToken(p, sandboxId, newToken);
  if (!running) {
    warn(
      'shim.not-running',
      { sandbox: sandboxId },
      `warning: the shim did not come back up in '${sandboxId}' after rotation; chat is unavailable until it starts`,
    );
  }
  try {
    const preview = await p.getPreviewUrl(sandboxId, SHIM_DEFAULT_PORT);
    report(
      'shim.token-rotated',
      { sandbox: sandboxId, url: preview.url },
      `Rotated the shim token for '${sandboxId}'. Existing clients are disconnected and must reconnect; preview URL: ${preview.url}`,
    );
  } catch {
    report(
      'shim.token-rotated',
      { sandbox: sandboxId },
      `Rotated the shim token for '${sandboxId}'. Existing clients are disconnected and must reconnect.`,
    );
  }
}

/**
 * `racecar auth revoke <name> [--stop-sandboxes]` — revoke a stored credential.
 * Removes it from the local store (so no future sandbox is injected with it),
 * then best-effort scrubs its on-disk artifacts from every started managed
 * sandbox. Because a credential is also injected as an env var, a process that
 * already read it keeps it until it stops — so revoke warns about, and with
 * `--stop-sandboxes` stops, sandboxes that may still hold it. Stronger than
 * `auth rm`, which only removes the local copy.
 */
async function authRevoke(args: readonly string[]): Promise<void> {
  const parsed = parseArgs(args);
  const name = parsed.positional[0];
  if (name === undefined) throw new Error('auth revoke requires a credential name');
  const stopSandboxes = parsed.options.has('stop-sandboxes');
  const store = openCredentialStore();
  const credential = await store.get(name);
  if (credential === undefined) {
    process.stdout.write(`No credential named '${name}'\n`);
    return;
  }
  // Redact the revoked secrets from every subsequent write this process makes.
  installOutputRedaction(new Redactor(Object.values(credential.secrets)));
  const fingerprints = Object.values(credential.secrets).map(secretFingerprint).join(', ');
  await store.remove(name);
  report(
    'auth.revoked-locally',
    { name, kind: credential.kind },
    `Removed credential '${name}' (${credential.kind}, fingerprint ${fingerprints}) from the local store; no new sandbox will receive it.`,
  );
  // Scrub live sandboxes. This needs the provider; without an API key we can
  // still have completed the local revocation, so degrade with a warning.
  let p: SandboxProvider;
  try {
    p = provider();
  } catch (error) {
    warn(
      'auth.scrub-skipped',
      { name },
      `note: live sandboxes were not scrubbed (${error instanceof Error ? error.message : String(error)}); running agents keep the credential until they stop`,
    );
    return;
  }
  const scrub = credentialScrub(credential.kind);
  const managed = toSandboxes(
    await p.listSandboxes({ labels: sandboxLabelSelector(), states: ['started'] }),
  );
  if (managed.length === 0) {
    report('auth.no-live-sandboxes', { name }, 'No started managed sandboxes to scrub.');
    return;
  }
  const stillExposed: string[] = [];
  for (const sandbox of managed) {
    if (scrub.command !== undefined) {
      try {
        await p.exec(sandbox.id, { command: scrub.command, timeoutSeconds: 30 });
        report(
          'auth.scrubbed',
          { sandbox: sandbox.id, name },
          `  scrubbed on-disk credential artifacts in '${sandbox.id}'`,
        );
      } catch (error) {
        warn(
          'auth.scrub-failed',
          { sandbox: sandbox.id, name },
          `  could not scrub '${sandbox.id}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (scrub.livesInProcessEnv) stillExposed.push(sandbox.id);
  }
  if (stillExposed.length === 0) return;
  if (stopSandboxes) {
    for (const id of stillExposed) {
      try {
        await p.stopSandbox(id);
        report(
          'auth.stopped',
          { sandbox: id, name },
          `  stopped '${id}' to end processes still holding the credential`,
        );
      } catch (error) {
        warn(
          'auth.stop-failed',
          { sandbox: id, name },
          `  could not stop '${id}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return;
  }
  warn(
    'auth.still-exposed',
    { name, sandboxes: stillExposed },
    `warning: ${stillExposed.length} started sandbox(es) may retain the credential in a running process's environment (${stillExposed.join(', ')}); re-run with --stop-sandboxes to stop them, or stop them manually`,
  );
}

/**
 * `racecar audit [--project <project>]` — verify no stored secret has leaked
 * into a managed sandbox's provider labels, and flag any label outside the
 * `racecar.*` namespace. This is the automated check behind the stage exit
 * criterion "no leaked credentials in any log or label". Exits non-zero when any
 * leak is found so it can gate a CI or scheduled run.
 */
async function audit(args: readonly string[]): Promise<void> {
  const parsed = parseArgs(args);
  const projectName = option(parsed, 'project');
  const secrets = await openCredentialStore().secrets();
  const p = provider();
  const listed = await p.listSandboxes({
    labels: sandboxLabelSelector(projectName === undefined ? undefined : { project: projectName }),
  });
  let leaks = 0;
  for (const sandbox of listed) {
    const result = auditSandboxLabels(sandbox.id, sandbox.labels, secrets);
    if (result.findings.length === 0) {
      report(
        'audit.ok',
        { sandbox: sandbox.id, labels: Object.keys(sandbox.labels).length },
        `${sandbox.id}: ok — ${Object.keys(sandbox.labels).length} label(s), no secret material`,
      );
      continue;
    }
    for (const finding of result.findings) {
      if (finding.severity === 'leak') {
        leaks += 1;
        warn(
          'audit.leak',
          { sandbox: sandbox.id, key: finding.key },
          `${sandbox.id}: LEAK — ${finding.message}`,
        );
      } else {
        warn(
          'audit.warning',
          { sandbox: sandbox.id, key: finding.key },
          `${sandbox.id}: warning — ${finding.message}`,
        );
      }
    }
  }
  report(
    'audit.summary',
    { scanned: listed.length, leaks, project: projectName ?? null },
    `Audited ${listed.length} sandbox(es); ${leaks} leak(s) found.`,
  );
  if (leaks > 0) {
    process.exitCode = exitCodeForError(new Error('audit found leaked secrets in labels'));
  }
}

/**
 * `racecar snapshot check --project <project> [--lockfile-hash <hash>] [--rebuild]`
 * — compare the project's snapshot against the current checkout's lockfile hash
 * (from cwd, or an explicit `--lockfile-hash`) and report fresh/stale. With
 * `--rebuild`, a stale snapshot triggers an async rebuild on demand.
 */
async function snapshotCheck(args: readonly string[]): Promise<void> {
  const parsed = parseArgs(args);
  const project = await loadProject(requireOption(parsed, 'project'));
  const snapshot = await loadSnapshot(project.name);
  const currentHash = option(parsed, 'lockfile-hash') ?? (await lockfileHash());
  const wantRebuild = parsed.options.has('rebuild');
  const decision = decideSnapshotRebuild(snapshot, currentHash, {
    autoRebuild: wantRebuild || project.autoRebuildSnapshot,
  });
  if (decision === 'fresh') {
    report(
      'snapshot.fresh',
      { snapshot: snapshot.name, project: project.name },
      `Snapshot '${snapshot.name}' is up to date with the current lockfile.`,
    );
    return;
  }
  if (decision === 'building') {
    report(
      'snapshot.building',
      { snapshot: snapshot.name, project: project.name },
      `Snapshot '${snapshot.name}' is stale but a rebuild is already in progress.`,
    );
    return;
  }
  if (decision === 'rebuild') {
    warn(
      'snapshot.stale',
      { snapshot: snapshot.name, project: project.name },
      `Snapshot '${snapshot.name}' is stale; scheduling an async rebuild.`,
    );
    spawnSnapshotRebuild(project.name);
    return;
  }
  warn(
    'snapshot.stale',
    { snapshot: snapshot.name, project: project.name },
    `Snapshot '${snapshot.name}' is stale relative to the current lockfile; rebuild with 'racecar snapshot build --project ${project.name}' or re-run with --rebuild.`,
  );
}

function usage(): string {
  return `${banner()}\n\nUsage:\n  racecar project init [--name <name>] [--repo <url>] [--branch <branch>] [--auto-rebuild-snapshot] [--egress-allowlist <domain,...>]\n  racecar snapshot build --project <project> [--base-image <image>]\n  racecar snapshot check --project <project> [--lockfile-hash <hash>] [--rebuild]\n  racecar sandbox create --project <project> --mission <name> [--branch <branch>] [--base-branch <branch>] [--shared] [--resource-class <${Object.keys(RESOURCE_CLASSES).join('|')}>] [--labels-json <object>] [--workspace-context-file <path>]\n  racecar sandbox stop|start|rm <sandbox-id>\n  racecar ps [--project <project>] [--watch --interval <seconds>]\n  racecar quota [--project <project>]\n  racecar attach <sandbox-id>\n  racecar run <sandbox-id> "<prompt>" [--agent <${knownAgents().join('|')}>] [--timeout <seconds>]\n  racecar runs <sandbox-id>\n  racecar chat <sandbox-id> ["<prompt>"] [--run <run-id>]\n  racecar msg send <sandbox-id> "<text>" [--session <run-id>]\n  racecar msg reply <sandbox-id> <message-id> "<text>"\n  racecar inbox [--project <project>] [--sandbox <sandbox-id>] [--unread]\n  racecar reconcile [--project <project>] [--dry-run] [--max-run-minutes <n>]\n  racecar audit [--project <project>]\n  racecar integration status [--resource <key>] [--mission <id>] [--entry <id>]\n  racecar integration enqueue --mission <id> --head <sha> [--branch <name>] [--resource <key>] [--priority <low|normal|high>]\n  racecar integration approve|dequeue --entry <id> [--resource <key>]\n  racecar integration retry --entry <id> --head <sha> [--resource <key>]\n  racecar integration run --once [--resource <key>]\n  racecar shim rotate-token <sandbox-id>\n  racecar auth claude [--token <t>] [--stdin]\n  racecar auth git [--host <h>] [--username <u>] [--token <t>] [--stdin]\n  racecar auth list | rm <name>\n  racecar auth revoke <name> [--stop-sandboxes]\n\nAdd --json to any command for an NDJSON event stream on stdout.\n\nResource classes (estimated spend in 'racecar ps'): ${Object.values(
    RESOURCE_CLASSES,
  )
    .map((c) => `${c.name} (${formatUsd(c.hourlyUsd)}/hr)`)
    .join(
      ', ',
    )}.\nOrg quota: .racecar/quota.json ({ maxConcurrentSandboxes, maxHourlySpendUsd }).\n\nProvider credentials: DAYTONA_API_KEY (optional DAYTONA_API_URL, DAYTONA_ORGANIZATION_ID, DAYTONA_TARGET).\nCredential store: ~/.racecar (override with RACECAR_HOME; RACECAR_MASTER_KEY sets the encryption key).\nSandbox egress: deny-by-default; --egress-allowlist extends the package, git, Anthropic, and Daytona domain allowlist.\n`;
}

async function main(rawArgv: readonly string[]): Promise<void> {
  // `--json` is a global flag: strip it before dispatch so it can appear
  // anywhere without being mistaken for a subcommand or an option value, and
  // switch every command onto the NDJSON event stream.
  let json = false;
  const argv = rawArgv.filter((arg) => {
    if (arg === '--json') {
      json = true;
      return false;
    }
    return true;
  });
  configureOutput(json);
  const [group, command, ...rest] = argv;
  if (group === undefined || group === '--help' || group === '-h') {
    process.stdout.write(usage());
    return;
  }
  if (group === '--version' || group === '-v') {
    process.stdout.write('0.0.0\n');
    return;
  }
  // Seed output redaction from stored secrets before any command can print.
  await installStoredSecretRedaction();
  if (group === 'project' && command === 'init') return projectInit(rest);
  if (group === 'snapshot' && command === 'build') return snapshotBuild(rest);
  if (group === 'snapshot' && command === 'check') return snapshotCheck(rest);
  if (group === 'sandbox' && command === 'create') return sandboxCreate(rest);
  if (group === 'sandbox' && (command === 'stop' || command === 'start' || command === 'rm'))
    return sandboxAction(command, rest);
  if (group === 'ps')
    return ps([command, ...rest].filter((part): part is string => part !== undefined));
  if (group === 'quota')
    return quota([command, ...rest].filter((part): part is string => part !== undefined));
  if (group === 'attach')
    return attach([command, ...rest].filter((part): part is string => part !== undefined));
  if (group === 'run')
    return run([command, ...rest].filter((part): part is string => part !== undefined));
  if (group === 'runs')
    return runs([command, ...rest].filter((part): part is string => part !== undefined));
  if (group === 'chat')
    return chat([command, ...rest].filter((part): part is string => part !== undefined));
  if (group === 'msg' && command === 'send') return msgSend(rest);
  if (group === 'msg' && command === 'reply') return msgReply(rest);
  if (group === 'inbox')
    return inbox([command, ...rest].filter((part): part is string => part !== undefined));
  if (group === 'reconcile')
    return reconcile([command, ...rest].filter((part): part is string => part !== undefined));
  if (group === 'audit')
    return audit([command, ...rest].filter((part): part is string => part !== undefined));
  if (group === 'integration') {
    if (command === 'status') return integrationStatus(parseArgs(rest));
    if (command === 'enqueue') return integrationEnqueue(parseArgs(rest));
    if (command === 'approve') return integrationApprove(parseArgs(rest));
    if (command === 'retry') return integrationRetry(parseArgs(rest));
    if (command === 'dequeue') return integrationDequeue(parseArgs(rest));
    if (command === 'run') return integrationRun(parseArgs(rest));
    throw new Error(`unknown integration command '${command ?? ''}'\n\n${usage()}`);
  }
  if (group === 'shim' && command === 'rotate-token') return shimRotate(rest);
  if (group === 'auth') {
    if (command === 'revoke') return authRevoke(rest);
    const parsed = parseArgs(rest);
    if (await auth(command, parsed)) return;
    throw new Error(`unknown auth command '${command ?? ''}'\n\n${usage()}`);
  }
  throw new Error(`unknown command '${[group, command].filter(Boolean).join(' ')}'\n\n${usage()}`);
}

void main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`racecar: ${error instanceof Error ? error.message : String(error)}\n`);
  // Deterministic exit codes: the same failure cause always yields the same
  // code, so a supervising program can branch on it without parsing the message.
  process.exitCode = exitCodeForError(error);
});
