#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  agentStatusFromActivity,
  countsAgainstConcurrencyCap,
  DaytonaProvider,
  decodeSandboxLabels,
  DEFAULT_WORKSPACE_DIR,
  defineProject,
  encodeSandboxLabels,
  ensureSessionScript,
  generateShimToken,
  isSnapshotStale,
  knownAgents,
  paneCommandsScript,
  parsePaneActivity,
  Redactor,
  sandboxLabelSelector,
  SHIM_DEFAULT_PORT,
  SHIM_TOKEN_ENV,
  toSandbox,
  toSandboxes,
  TMUX_SETUP_COMMANDS,
  type AgentStatus,
  type Project,
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
} from './credentials.js';
import { configureOutput, emitEvent, isJsonMode, report, warn } from './output.js';
import { listRuns, startRun, type ShimRunRecord } from './run.js';
import { bootShim } from './shim.js';

const STATE_DIR = '.racecar';
const PROJECTS_DIR = 'projects';
const SNAPSHOTS_DIR = 'snapshots';
const DEFAULT_IMAGE = 'node:22-bookworm-slim';

function statePath(...parts: string[]): string {
  return join(process.cwd(), STATE_DIR, ...parts);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
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
  return readJson<Project>(statePath(PROJECTS_DIR, `${name}.json`), `project '${name}'`);
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

function provider(): DaytonaProvider {
  const apiKey = process.env.DAYTONA_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error('DAYTONA_API_KEY is required for provider commands');
  }
  return new DaytonaProvider({
    apiKey,
    ...(process.env.DAYTONA_API_URL !== undefined ? { apiUrl: process.env.DAYTONA_API_URL } : {}),
    ...(process.env.DAYTONA_ORGANIZATION_ID !== undefined
      ? { organizationId: process.env.DAYTONA_ORGANIZATION_ID }
      : {}),
    ...(process.env.DAYTONA_TARGET !== undefined ? { target: process.env.DAYTONA_TARGET } : {}),
  });
}

function sandboxName(project: string, mission: string): string {
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replaceAll(/[^a-z0-9-]/g, '-')
      .slice(0, 30);
  return `racecar-${normalize(project)}-${normalize(mission)}-${Date.now().toString(36)}`;
}

async function projectInit(args: readonly string[]): Promise<void> {
  const parsed = parseArgs(args);
  const repoUrl = option(parsed, 'repo') ?? git('config', '--get', 'remote.origin.url');
  const defaultBranch = option(parsed, 'branch') ?? (git('branch', '--show-current') || 'main');
  const name = option(parsed, 'name') ?? resolve(process.cwd()).split('/').pop() ?? 'project';
  const workspaceDir = option(parsed, 'workspace-dir');
  const project = defineProject({
    name,
    repoUrl,
    snapshot: option(parsed, 'snapshot') ?? `${name}-snapshot`,
    defaultBranch,
    ...(workspaceDir !== undefined ? { workspaceDir } : {}),
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
    setupCommands: [...TMUX_SETUP_COMMANDS, 'corepack enable'],
    onLog: (chunk) => process.stderr.write(chunk),
  });
  const snapshot: Snapshot = {
    name: built.name,
    project: project.name,
    baseImage: option(parsed, 'base-image') ?? DEFAULT_IMAGE,
    ...(currentHash !== undefined ? { lockfileHash: currentHash } : {}),
    ...(built.imageName !== undefined ? { imageName: built.imageName } : {}),
    state: built.state,
    createdAt: new Date().toISOString(),
  };
  await writeJson(statePath(SNAPSHOTS_DIR, `${project.name}.json`), snapshot);
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
  const snapshot = await loadSnapshot(project.name);
  const p = provider();
  const existing = toSandboxes(
    await p.listSandboxes({ labels: sandboxLabelSelector({ project: project.name }) }),
  );
  if (
    existing.filter(countsAgainstConcurrencyCap).length >= project.lifecycle.maxConcurrentSandboxes
  ) {
    throw new Error(
      `project '${project.name}' has reached its concurrent sandbox cap (${project.lifecycle.maxConcurrentSandboxes})`,
    );
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
  const created = await p.createSandbox({
    snapshot: snapshot.name,
    name: sandboxName(project.name, mission),
    labels: encodeSandboxLabels({
      project: project.name,
      mission,
      branch,
      snapshot: snapshot.name,
      createdAt: now,
      role: 'mission',
      ...(process.env.USER !== undefined ? { createdBy: process.env.USER } : {}),
    }),
    envVars,
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
  const checkout = [
    'set -eu',
    ...injection.setupCommands,
    `rm -rf ${dir}`,
    `git clone --branch ${shellQuote(branch)} --single-branch ${shellQuote(project.repoUrl)} ${dir}`,
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
  const checkoutHashResult = await p.exec(created.id, {
    command: `cd ${shellQuote(project.workspaceDir)} && (sha256sum yarn.lock 2>/dev/null || shasum -a 256 yarn.lock 2>/dev/null || true) | awk '{print $1}'`,
  });
  const checkoutHash = checkoutHashResult.output.trim();
  if (checkoutHash.length > 0 && isSnapshotStale(snapshot, checkoutHash)) {
    warn(
      'snapshot.stale',
      { snapshot: snapshot.name, project: project.name, branch },
      `warning: snapshot '${snapshot.name}' is stale relative to ${branch}'s lockfile; rebuild with 'racecar snapshot build --project ${project.name}'`,
    );
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
    { sandbox: created.id, project: project.name, mission, branch },
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
  if (isJsonMode()) {
    managed.forEach((sandbox, index) => {
      emitEvent('sandbox.ps', {
        sandbox: sandbox.id,
        project: sandbox.project,
        mission: sandbox.mission,
        branch: sandbox.branch,
        state: sandbox.state,
        agent: agents[index] ?? '?',
        lastActivityAt: sandbox.lastActivityAt ?? null,
      });
    });
    return;
  }
  process.stdout.write('ID\tPROJECT\tMISSION\tBRANCH\tSTATE\tAGENT\tLAST ACTIVITY\n');
  managed.forEach((sandbox, index) => {
    process.stdout.write(
      `${sandbox.id}\t${sandbox.project}\t${sandbox.mission}\t${sandbox.branch}\t${sandbox.state}\t${agents[index] ?? '?'}\t${sandbox.lastActivityAt ?? '-'}\n`,
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
    process.exitCode = 1;
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

function usage(): string {
  return `${banner()}\n\nUsage:\n  racecar project init [--name <name>] [--repo <url>] [--branch <branch>]\n  racecar snapshot build --project <project> [--base-image <image>]\n  racecar sandbox create --project <project> --mission <name> [--branch <branch>]\n  racecar sandbox stop|start|rm <sandbox-id>\n  racecar ps [--project <project>] [--watch --interval <seconds>]\n  racecar attach <sandbox-id>\n  racecar run <sandbox-id> "<prompt>" [--agent <${knownAgents().join('|')}>] [--timeout <seconds>]\n  racecar runs <sandbox-id>\n  racecar chat <sandbox-id> ["<prompt>"] [--run <run-id>]\n  racecar auth claude [--token <t>] [--stdin]\n  racecar auth git [--host <h>] [--username <u>] [--token <t>] [--stdin]\n  racecar auth list | rm <name>\n\nAdd --json to any command for an NDJSON event stream on stdout.\n\nProvider credentials: DAYTONA_API_KEY (optional DAYTONA_API_URL, DAYTONA_ORGANIZATION_ID, DAYTONA_TARGET).\nCredential store: ~/.racecar (override with RACECAR_HOME; RACECAR_MASTER_KEY sets the encryption key).\n`;
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
  if (group === 'sandbox' && command === 'create') return sandboxCreate(rest);
  if (group === 'sandbox' && (command === 'stop' || command === 'start' || command === 'rm'))
    return sandboxAction(command, rest);
  if (group === 'ps')
    return ps([command, ...rest].filter((part): part is string => part !== undefined));
  if (group === 'attach')
    return attach([command, ...rest].filter((part): part is string => part !== undefined));
  if (group === 'run')
    return run([command, ...rest].filter((part): part is string => part !== undefined));
  if (group === 'runs')
    return runs([command, ...rest].filter((part): part is string => part !== undefined));
  if (group === 'chat')
    return chat([command, ...rest].filter((part): part is string => part !== undefined));
  if (group === 'auth') {
    const parsed = parseArgs(rest);
    if (await auth(command, parsed)) return;
    throw new Error(`unknown auth command '${command ?? ''}'\n\n${usage()}`);
  }
  throw new Error(`unknown command '${[group, command].filter(Boolean).join(' ')}'\n\n${usage()}`);
}

void main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`racecar: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
